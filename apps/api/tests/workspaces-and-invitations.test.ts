import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "redirect-hub-t0025-"));
process.env.DATABASE_PATH = join(fixtureDirectory, "workspaces-and-invitations.sqlite");
process.env.PORT = "0";
process.env.COUNTRY_HEADER_PROVIDER = "cloudflare";

const fixturePath = process.env.DATABASE_PATH;
const legacy = new DatabaseSync(fixturePath);
legacy.exec("PRAGMA foreign_keys = ON;");
legacy.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  CREATE TABLE links (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE CASCADE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, destination_url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  CREATE UNIQUE INDEX idx_links_id_owner ON links(id, owner_id);
  CREATE TABLE api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL CHECK(scopes IN ('read', 'read,write')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), last_used_at TEXT, revoked_at TEXT);
  CREATE TABLE click_events (id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, matched_rule_id TEXT, country_code TEXT, clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), device TEXT NOT NULL CHECK(device IN ('mobile', 'desktop', 'bot', 'unknown')), referrer_host TEXT, is_bot INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN (0, 1)));
  CREATE TABLE redirect_rules (id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, priority INTEGER NOT NULL, country_code TEXT, device TEXT CHECK(device IN ('mobile', 'desktop')), destination_url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), CHECK(country_code IS NOT NULL OR device IS NOT NULL));
  CREATE TABLE tags (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, normalized_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), UNIQUE (id, owner_id), UNIQUE (owner_id, normalized_name));
  CREATE TABLE link_tags (link_id TEXT NOT NULL, tag_id TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (link_id, tag_id), FOREIGN KEY (link_id, owner_id) REFERENCES links(id, owner_id) ON DELETE CASCADE, FOREIGN KEY (tag_id, owner_id) REFERENCES tags(id, owner_id) ON DELETE CASCADE);
`);
for (const [id, email] of [["owner-a", "owner-a@example.test"], ["owner-b", "owner-b@example.test"]]) {
  legacy.prepare("INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, 'salt', 'hash', ?)")
    .run(id, email, "2026-01-01T00:00:00.000Z");
}
legacy.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("legacy-link-a", "owner-a", "before-migration", "Legacy campaign", "https://example.test/default", "2026-01-02T00:00:00.000Z");
legacy.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("legacy-link-b", "owner-b", "private-to-b", "Private link", "https://example.test/private", "2026-01-02T00:00:00.000Z");
legacy.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url, created_at) VALUES (?, NULL, ?, ?, ?, ?)")
  .run("legacy-null-link", "unclaimed-legacy", "Unclaimed legacy", "https://example.test/unclaimed", "2026-01-03T00:00:00.000Z");
legacy.prepare("INSERT INTO redirect_rules (id, link_id, priority, country_code, destination_url) VALUES (?, ?, ?, ?, ?)")
  .run("legacy-rule-a", "legacy-link-a", 1, "CA", "https://example.test/canada");
legacy.prepare("INSERT INTO redirect_rules (id, link_id, priority, device, destination_url) VALUES (?, ?, ?, ?, ?)")
  .run("legacy-rule-mobile", "legacy-link-a", 2, "mobile", "https://example.test/mobile");
legacy.prepare("INSERT INTO click_events (id, link_id, matched_rule_id, country_code, clicked_at, device, is_bot) VALUES (?, ?, ?, ?, ?, ?, 0)")
  .run("legacy-click-a", "legacy-link-a", "legacy-rule-a", "CA", "2026-01-04T00:00:00.000Z", "desktop");
legacy.prepare("INSERT INTO tags (id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?)").run("legacy-tag-a", "owner-a", "Campaign", "campaign");
legacy.prepare("INSERT INTO link_tags (link_id, tag_id, owner_id) VALUES (?, ?, ?)").run("legacy-link-a", "legacy-tag-a", "owner-a");
legacy.prepare("INSERT INTO tags (id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?)").run("legacy-tag-b", "owner-b", "Private", "private");
legacy.prepare("INSERT INTO link_tags (link_id, tag_id, owner_id) VALUES (?, ?, ?)").run("legacy-link-b", "legacy-tag-b", "owner-b");
legacy.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?, ?)").run("legacy-token-a", "owner-a", "legacy token", "hash-of-existing-token", "read");
legacy.close();

const { db } = await import("../src/db.js");
const { app } = await import("../src/index.js");

test.after(() => {
  db.close();
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(value, "successful auth response sets a session cookie");
  return value;
}

async function api(path: string, init: RequestInit = {}, cookie?: string, workspaceId?: string) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (workspaceId) headers.set("x-workspace-id", workspaceId);
  return app.request(`http://redirect-hub.test${path}`, { ...init, headers });
}

async function register(email: string, password: string) {
  return api("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

function workspaceFor(userId: string) {
  return db.prepare(`SELECT workspaces.id, workspaces.owner_user_id AS ownerUserId, workspaces.name
    FROM workspaces WHERE owner_user_id = ?`).get(userId) as { id: string; ownerUserId: string; name: string };
}

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .run(randomBytes(12).toString("hex"), userId, createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 60_000).toISOString());
  return `redirect_hub_session=${token}`;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(url: string, child: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Temporary API exited early: ${child.exitCode}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* Startup still in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Temporary API did not become healthy within four seconds.");
}

async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

test("startup migration gives each existing account a private workspace and preserves records and public routing", async () => {
  const ownerAWorkspace = workspaceFor("owner-a");
  const ownerBWorkspace = workspaceFor("owner-b");
  assert.notEqual(ownerAWorkspace.id, ownerBWorkspace.id);
  assert.equal((db.prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(ownerAWorkspace.id, "owner-a") as { role: string }).role, "owner");
  assert.equal((db.prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(ownerBWorkspace.id, "owner-b") as { role: string }).role, "owner");
  assert.equal((db.prepare("SELECT workspace_id FROM links WHERE id = 'legacy-link-a'").get() as { workspace_id: string }).workspace_id, ownerAWorkspace.id);
  assert.equal((db.prepare("SELECT workspace_id FROM links WHERE id = 'legacy-link-b'").get() as { workspace_id: string }).workspace_id, ownerBWorkspace.id);
  assert.equal((db.prepare("SELECT workspace_id, owner_id FROM links WHERE id = 'legacy-null-link'").get() as { workspace_id: string | null; owner_id: string | null }).workspace_id, null,
    "unowned legacy links are not reassigned to an existing account");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM link_tags WHERE link_id = 'legacy-link-a'").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM api_tokens WHERE id = 'legacy-token-a'").get() as { count: number }).count, 1);
  const eventBefore = (db.prepare("SELECT COUNT(*) AS count FROM click_events WHERE link_id = 'legacy-link-a'").get() as { count: number }).count;
  assert.equal(eventBefore, 1);
  const migrationSnapshot = () => JSON.stringify({
    workspaces: db.prepare("SELECT id, owner_user_id, name, created_at FROM workspaces ORDER BY id").all(),
    memberships: db.prepare("SELECT workspace_id, user_id, role, created_at FROM workspace_memberships ORDER BY workspace_id, user_id").all(),
    links: db.prepare("SELECT id, owner_id, workspace_id, slug FROM links ORDER BY id").all(),
    rules: db.prepare("SELECT id, link_id, priority, country_code, device, destination_url FROM redirect_rules ORDER BY id").all(),
    events: db.prepare("SELECT id, link_id, matched_rule_id, clicked_at FROM click_events ORDER BY id").all(),
    tokens: db.prepare("SELECT id, user_id, token_hash FROM api_tokens ORDER BY id").all(),
  });
  const beforeMigrationRerun = migrationSnapshot();
  const rerun = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const { db } = await import('./src/db.ts'); db.close();"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(rerun.status, 0, `second startup migration exits cleanly: ${rerun.stderr}`);
  assert.equal(migrationSnapshot(), beforeMigrationRerun, "startup migration rerun preserves workspace/membership/link/rule/event/token rows and IDs");

  const defaultRedirect = await app.request("http://redirect-hub.test/l/before-migration", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  assert.equal(defaultRedirect.status, 302);
  assert.equal(defaultRedirect.headers.get("location"), "https://example.test/default");
  const nonMatchingRedirect = await app.request("http://redirect-hub.test/l/before-migration", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "cf-ipcountry": "US" } });
  assert.equal(nonMatchingRedirect.status, 302);
  assert.equal(nonMatchingRedirect.headers.get("location"), "https://example.test/default", "unmatched country/device inputs keep the default destination");
  const matchedRedirect = await app.request("http://redirect-hub.test/l/before-migration", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "cf-ipcountry": "CA" } });
  assert.equal(matchedRedirect.status, 302);
  assert.equal(matchedRedirect.headers.get("location"), "https://example.test/canada");
  const mobileRedirect = await app.request("http://redirect-hub.test/l/before-migration", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1", "cf-ipcountry": "US" } });
  assert.equal(mobileRedirect.status, 302);
  assert.equal(mobileRedirect.headers.get("location"), "https://example.test/mobile", "the migrated mobile-device rule remains active");
  assert.equal((db.prepare("SELECT matched_rule_id FROM click_events WHERE id = (SELECT id FROM click_events WHERE link_id = 'legacy-link-a' ORDER BY clicked_at DESC LIMIT 1)").get() as { matched_rule_id: string }).matched_rule_id, "legacy-rule-mobile");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM click_events WHERE link_id = 'legacy-link-a'").get() as { count: number }).count, eventBefore + 4);
});

test("registration provisions a private owner workspace", async () => {
  const response = await register("workspace-owner@example.test", "a sufficiently long test password");
  assert.equal(response.status, 201);
  const { user } = await response.json() as { user: { id: string } };
  const membership = db.prepare(`
    SELECT workspace_id, role FROM workspace_memberships WHERE user_id = ?
  `).get(user.id) as { workspace_id: string; role: string } | undefined;
  assert.ok(membership, "new account receives a private workspace membership");
  assert.equal(membership.role, "owner");
});

test("workspace invitations are owner-only, single-use, seven-day bearer links and grant read-only workspace access", async () => {
  const ownerCookie = await sessionFor("owner-a");
  const ownerWorkspace = workspaceFor("owner-a");
  const created = await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, { method: "POST" }, ownerCookie, ownerWorkspace.id);
  assert.equal(created.status, 201);
  const createdData = await created.json() as { invitation: { id: string; url: string; createdAt: string; expiresAt: string } };
  const rawSecret = new URL(createdData.invitation.url).hash.match(/[?&]invitation=([^&]+)/)?.[1];
  assert.ok(rawSecret, "the invitation secret is shared only in the returned fragment URL");
  const secret = decodeURIComponent(rawSecret);
  assert.equal(Date.parse(createdData.invitation.expiresAt) - Date.parse(createdData.invitation.createdAt), 7 * 24 * 60 * 60 * 1000);
  const stored = db.prepare("SELECT secret_hash FROM workspace_invitations WHERE id = ?").get(createdData.invitation.id) as { secret_hash: string };
  assert.equal(stored.secret_hash, createHash("sha256").update(secret).digest("hex"));
  assert.notEqual(stored.secret_hash, secret);

  const listed = await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, {}, ownerCookie, ownerWorkspace.id);
  const listedText = await listed.text();
  assert.equal(listed.status, 200);
  assert.ok(!listedText.includes(secret) && !listedText.includes(stored.secret_hash), "listing excludes raw secret and its hash");
  assert.equal((await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, {}, await sessionFor("owner-b"), ownerWorkspace.id)).status, 404,
    "a different account cannot administer a guessed workspace");

  const redemption = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret, email: "invitee@example.test", password: "a sufficiently long invitee password" }) });
  assert.equal(redemption.status, 201, await redemption.clone().text());
  const redemptionText = await redemption.text();
  assert.ok(!redemptionText.includes(secret) && !redemptionText.includes(stored.secret_hash));
  const inviteeCookie = cookieFrom(redemption);
  const invitee = db.prepare("SELECT id FROM users WHERE email = 'invitee@example.test'").get() as { id: string };
  assert.equal((db.prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(ownerWorkspace.id, invitee.id) as { role: string }).role, "member");
  const inviteePersonalWorkspace = workspaceFor(invitee.id);

  const ownerDetail = await api("/api/links/legacy-link-a", {}, ownerCookie, ownerWorkspace.id);
  assert.equal(ownerDetail.status, 200, "owner can read link detail");
  const memberDetail = await api("/api/links/legacy-link-a", {}, inviteeCookie, ownerWorkspace.id);
  assert.equal(memberDetail.status, 200, "member can read detail for a shared-workspace link");
  assert.equal(((await memberDetail.json() as { link: { id: string } }).link.id), "legacy-link-a");
  const guessedDetail = await api("/api/links/legacy-link-b", {}, inviteeCookie, ownerWorkspace.id);
  assert.equal(guessedDetail.status, 404, "guessed link IDs from an independent workspace reveal no detail");
  assert.ok(!(await guessedDetail.text()).includes("Private link"));
  const memberRules = await api("/api/links/legacy-link-a/rules", {}, inviteeCookie, ownerWorkspace.id);
  assert.deepEqual(((await memberRules.json() as { rules: Array<{ id: string }> }).rules).map((rule) => rule.id), ["legacy-rule-a", "legacy-rule-mobile"]);
  assert.equal((await api("/api/links/legacy-link-b/rules", {}, inviteeCookie, ownerWorkspace.id)).status, 404,
    "guessed rules from another workspace return not found");
  const memberTags = await api("/api/tags", {}, inviteeCookie, ownerWorkspace.id);
  assert.deepEqual(((await memberTags.json() as { tags: Array<{ name: string }> }).tags).map((tag) => tag.name), ["Campaign"]);

  const ownerArchive = await api("/api/links/legacy-link-a/archive", { method: "POST" }, ownerCookie, ownerWorkspace.id);
  assert.equal(ownerArchive.status, 200, "owner retains archive access");
  const archivedMemberLinks = await api("/api/links?archive=archived", {}, inviteeCookie, ownerWorkspace.id);
  assert.deepEqual(((await archivedMemberLinks.json() as { links: Array<{ id: string; archivedAt: string | null }> }).links)
    .map((link) => [link.id, Boolean(link.archivedAt)]), [["legacy-link-a", true]], "member can read archived links in the joined workspace");
  const archiveState = (db.prepare("SELECT archived_at FROM links WHERE id = 'legacy-link-a'").get() as { archived_at: string | null }).archived_at;
  assert.ok(archiveState);
  assert.equal((await api("/api/links/legacy-link-a/unarchive", { method: "POST" }, inviteeCookie, ownerWorkspace.id)).status, 403);
  assert.equal((db.prepare("SELECT archived_at FROM links WHERE id = 'legacy-link-a'").get() as { archived_at: string | null }).archived_at, archiveState,
    "denied unarchive leaves archived state unchanged");
  assert.equal((await api("/api/links/legacy-link-a/unarchive", { method: "POST" }, ownerCookie, ownerWorkspace.id)).status, 200,
    "owner retains unarchive access");

  db.prepare("INSERT INTO click_events (id, link_id, clicked_at, device, is_bot) VALUES (?, ?, ?, ?, 0)")
    .run("member-visible-click", "legacy-link-a", new Date().toISOString(), "desktop");
  const sharedLinks = await api("/api/links", {}, inviteeCookie, ownerWorkspace.id);
  assert.deepEqual((await sharedLinks.json() as { links: Array<{ id: string }> }).links.map((link) => link.id), ["legacy-link-a"]);
  const sharedAnalytics = await api("/api/analytics", {}, inviteeCookie, ownerWorkspace.id);
  const sharedClickCount = (db.prepare("SELECT COUNT(*) AS count FROM click_events JOIN links ON links.id = click_events.link_id WHERE links.workspace_id = ? AND click_events.is_bot = 0").get(ownerWorkspace.id) as { count: number }).count;
  assert.equal((await sharedAnalytics.json() as { totalClicks: number }).totalClicks, sharedClickCount);
  const before = (db.prepare("SELECT name, modified_at FROM links WHERE id = 'legacy-link-a'").get() as { name: string; modified_at: string | null });
  const deniedUpdate = await api("/api/links/legacy-link-a", { method: "PATCH", body: JSON.stringify({ name: "unauthorized" }) }, inviteeCookie, ownerWorkspace.id);
  assert.equal(deniedUpdate.status, 403);
  assert.deepEqual(db.prepare("SELECT name, modified_at FROM links WHERE id = 'legacy-link-a'").get(), before, "denied write makes no database change");
  const deniedWrites: Array<[string, RequestInit]> = [
    ["/api/links", { method: "POST", body: JSON.stringify({ name: "Blocked", destinationUrl: "https://example.test" }) }],
    ["/api/links/legacy-link-a/tags", { method: "PUT", body: JSON.stringify({ tags: ["blocked"] }) }],
    ["/api/links/legacy-link-a/archive", { method: "POST" }],
    ["/api/links/legacy-link-a/duplicate", { method: "POST" }],
    ["/api/links/legacy-link-a/rules", { method: "POST", body: JSON.stringify({ countryCode: "GB", destinationUrl: "https://example.test/blocked" }) }],
    ["/api/links/legacy-link-a/rules/legacy-rule-a", { method: "DELETE" }],
    ["/api/links/legacy-link-a/rules/legacy-rule-a/priority", { method: "PATCH", body: JSON.stringify({ direction: "up" }) }],
  ];
  const linkCountBefore = (db.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count;
  const rulesBefore = (db.prepare("SELECT COUNT(*) AS count FROM redirect_rules").get() as { count: number }).count;
  for (const [path, init] of deniedWrites) assert.equal((await api(path, init, inviteeCookie, ownerWorkspace.id)).status, 403, `${init.method} ${path} is denied to a read-only member`);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count, linkCountBefore);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM redirect_rules").get() as { count: number }).count, rulesBefore);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tags WHERE owner_id = ? AND normalized_name = 'blocked'").get("owner-a") as { count: number }).count, 0);
  assert.equal((await api("/api/links/legacy-link-a/simulate", { method: "POST", body: JSON.stringify({ countryCode: "CA" }) }, inviteeCookie, ownerWorkspace.id)).status, 200,
    "read-only members can use the visitor simulator");
  assert.equal((await api("/api/auth/tokens", {}, inviteeCookie, ownerWorkspace.id)).status, 403, "members cannot manage API tokens in the shared workspace");
  const tokenSnapshot = () => JSON.stringify(db.prepare("SELECT id, user_id, token_hash, revoked_at FROM api_tokens ORDER BY id").all());
  const beforeMemberTokenOps = tokenSnapshot();
  assert.equal((await api("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name: "blocked", scopes: "read" }) }, inviteeCookie, ownerWorkspace.id)).status, 403,
    "members cannot create tokens in the shared workspace");
  assert.equal((await api("/api/auth/tokens/legacy-token-a", { method: "DELETE" }, inviteeCookie, ownerWorkspace.id)).status, 403,
    "members cannot revoke an owner's token in the shared workspace");
  assert.equal(tokenSnapshot(), beforeMemberTokenOps, "denied token create/revoke leaves token rows unchanged");

  const activeInvitationResponse = await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, { method: "POST" }, ownerCookie, ownerWorkspace.id);
  assert.equal(activeInvitationResponse.status, 201, "owner retains invitation creation access");
  const activeInvitation = (await activeInvitationResponse.json() as { invitation: { id: string } }).invitation;
  const invitationSnapshot = () => JSON.stringify(db.prepare("SELECT id, secret_hash, redeemed_at, revoked_at FROM workspace_invitations WHERE id = ?").get(activeInvitation.id));
  const beforeMemberInvitationOps = invitationSnapshot();
  assert.equal((await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, {}, inviteeCookie, ownerWorkspace.id)).status, 403,
    "member cannot list workspace invitations");
  assert.equal((await api(`/api/workspaces/${ownerWorkspace.id}/invitations/${activeInvitation.id}`, { method: "DELETE" }, inviteeCookie, ownerWorkspace.id)).status, 403,
    "member cannot revoke workspace invitations");
  assert.equal(invitationSnapshot(), beforeMemberInvitationOps, "denied invitation list/revoke leaves invitation row unchanged");

  const inviteeTokenResponse = await api("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name: "private member token", scopes: "read" }) }, inviteeCookie, inviteePersonalWorkspace.id);
  assert.equal(inviteeTokenResponse.status, 201, "invitee can make a token for their own personal workspace");
  const inviteeToken = (await inviteeTokenResponse.json() as { token: { id: string; value: string } }).token;
  const privateTokenRead = await api("/api/links", { headers: { authorization: `Bearer ${inviteeToken.value}` } });
  assert.equal(privateTokenRead.status, 200);
  assert.deepEqual((await privateTokenRead.json() as { links: unknown[] }).links, [], "member token only sees its owner's private workspace");
  assert.equal((await api("/api/links", { headers: { authorization: `Bearer ${inviteeToken.value}` } }, undefined, ownerWorkspace.id)).status, 403,
    "member-owned bearer tokens cannot select the invited workspace");

  const createdToken = await api("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name: "synthetic invite test", scopes: "read" }) }, ownerCookie, ownerWorkspace.id);
  assert.equal(createdToken.status, 201);
  const ownerToken = (await createdToken.json() as { token: { id: string; value: string } }).token;
  const tokenValue = ownerToken.value;
  assert.equal((await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, { headers: { authorization: `Bearer ${tokenValue}` } }, undefined, ownerWorkspace.id)).status, 403,
    "an owner's API token cannot administer invitations because the route requires a session");
  assert.equal((await api(`/api/auth/tokens/${ownerToken.id}`, { method: "DELETE" }, ownerCookie, ownerWorkspace.id)).status, 200,
    "owner retains API token revocation access");
  assert.equal((await api("/api/links", {}, inviteeCookie, ownerWorkspace.id)).status, 200);
  assert.equal((await api("/api/links", {}, inviteeCookie)).status, 200, "invitees retain their separate personal workspace");

  const duplicateUse = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret, email: "second-invitee@example.test", password: "a sufficiently long invitee password" }) });
  assert.equal(duplicateUse.status, 400);
  assert.ok(!(await duplicateUse.text()).includes(secret), "single-use failures do not echo the bearer secret");
  const memberCannotInvite = await api(`/api/workspaces/${ownerWorkspace.id}/invitations`, { method: "POST" }, inviteeCookie, ownerWorkspace.id);
  assert.equal(memberCannotInvite.status, 403);
});

test("expired, revoked, and duplicate-email invitations fail without exposing secrets", async () => {
  const ownerCookie = await sessionFor("owner-b");
  const workspace = workspaceFor("owner-b");
  const create = async () => {
    const response = await api(`/api/workspaces/${workspace.id}/invitations`, { method: "POST" }, ownerCookie, workspace.id);
    assert.equal(response.status, 201);
    const data = await response.json() as { invitation: { id: string; url: string } };
    const secret = decodeURIComponent(new URL(data.invitation.url).hash.match(/[?&]invitation=([^&]+)/)![1]);
    return { ...data.invitation, secret };
  };
  const revoked = await create();
  assert.equal((await api(`/api/workspaces/${workspace.id}/invitations/${revoked.id}`, { method: "DELETE" }, ownerCookie, workspace.id)).status, 200);
  const revokedFailure = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret: revoked.secret, email: "revoked@example.test", password: "a sufficiently long password" }) });
  assert.equal(revokedFailure.status, 400);
  assert.ok(!(await revokedFailure.text()).includes(revoked.secret));

  const expired = await create();
  db.prepare("UPDATE workspace_invitations SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.id);
  const expiredFailure = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret: expired.secret, email: "expired@example.test", password: "a sufficiently long password" }) });
  assert.equal(expiredFailure.status, 400);
  assert.ok(!(await expiredFailure.text()).includes(expired.secret));

  const duplicate = await create();
  const duplicateFailure = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret: duplicate.secret, email: "owner-b@example.test", password: "a sufficiently long password" }) });
  assert.equal(duplicateFailure.status, 400);
  assert.ok(!(await duplicateFailure.text()).includes(duplicate.secret));
  assert.equal((db.prepare("SELECT redeemed_at FROM workspace_invitations WHERE id = ?").get(duplicate.id) as { redeemed_at: string | null }).redeemed_at, null);
});

test("malformed and incorrect secrets fail generically without consuming a valid invitation", async () => {
  const ownerCookie = await sessionFor("owner-a");
  const workspace = workspaceFor("owner-a");
  const created = await api(`/api/workspaces/${workspace.id}/invitations`, { method: "POST" }, ownerCookie, workspace.id);
  assert.equal(created.status, 201);
  const invitation = (await created.json() as { invitation: { id: string } }).invitation;
  for (const secret of ["short-secret", "x".repeat(43)]) {
    const response = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret, email: `invalid-${secret.length}@example.test`, password: "a sufficiently long password" }) });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "This invitation could not be redeemed. Check the link and try again." });
    assert.ok(!body.includes(secret));
  }
  assert.equal((db.prepare("SELECT redeemed_at FROM workspace_invitations WHERE id = ?").get(invitation.id) as { redeemed_at: string | null }).redeemed_at, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE email LIKE 'invalid-%@example.test'").get() as { count: number }).count, 0);
});

test("invited account creation failure rolls back user, private workspace, membership, session, and invitation consumption", async () => {
  const ownerCookie = await sessionFor("owner-b");
  const workspace = workspaceFor("owner-b");
  const created = await api(`/api/workspaces/${workspace.id}/invitations`, { method: "POST" }, ownerCookie, workspace.id);
  assert.equal(created.status, 201);
  const invitation = (await created.json() as { invitation: { id: string; url: string } }).invitation;
  const secret = decodeURIComponent(new URL(invitation.url).hash.match(/[?&]invitation=([^&]+)/)![1]);
  const email = "rollback-invitee@example.test";
  db.exec(`CREATE TRIGGER fail_invited_member_insert BEFORE INSERT ON workspace_memberships
    WHEN NEW.role = 'member'
    BEGIN SELECT RAISE(ABORT, 'synthetic invited membership failure'); END`);
  let response: Response | undefined;
  let capturedErrorLog = "";
  const originalConsoleError = console.error;
  console.error = (...parts: unknown[]) => { capturedErrorLog += parts.map(String).join(" "); };
  try {
    response = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret, email, password: "a sufficiently long password" }) });
  } finally {
    console.error = originalConsoleError;
    db.exec("DROP TRIGGER IF EXISTS fail_invited_member_insert");
  }
  assert.equal(response?.status, 500, "injected membership failure aborts redemption");
  assert.ok(response && !(await response.text()).includes(secret), "the failure response does not echo the invitation secret");
  assert.ok(!capturedErrorLog.includes(secret), "application error logging does not expose the invitation secret");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get(email) as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE owner_user_id = (SELECT id FROM users WHERE email = ?)").get(email) as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workspace_memberships WHERE user_id = (SELECT id FROM users WHERE email = ?)").get(email) as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sessions JOIN users ON users.id = sessions.user_id WHERE users.email = ?").get(email) as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT redeemed_at FROM workspace_invitations WHERE id = ?").get(invitation.id) as { redeemed_at: string | null }).redeemed_at, null,
    "failed account creation leaves a still-valid invitation unused");
});

test("simultaneous redemption consumes one invitation exactly once", async () => {
  const ownerCookie = await sessionFor("owner-a");
  const workspace = workspaceFor("owner-a");
  const created = await api(`/api/workspaces/${workspace.id}/invitations`, { method: "POST" }, ownerCookie, workspace.id);
  assert.equal(created.status, 201);
  const invitation = (await created.json() as { invitation: { url: string } }).invitation;
  const secret = decodeURIComponent(new URL(invitation.url).hash.match(/[?&]invitation=([^&]+)/)![1]);
  const body = JSON.stringify({ secret, email: "race-winner@example.test", password: "a sufficiently long password" });
  const outcomes = await Promise.all([
    api("/api/invitations/redeem", { method: "POST", body }),
    api("/api/invitations/redeem", { method: "POST", body }),
  ]);
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [201, 400]);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'race-winner@example.test'").get() as { count: number }).count, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workspace_memberships
    JOIN users ON users.id = workspace_memberships.user_id
    WHERE workspace_id = ? AND role = 'member' AND users.email = 'race-winner@example.test'`).get(workspace.id) as { count: number }).count, 1);
});

test("an invitation is rejected at the exact expiry timestamp", async () => {
  const ownerCookie = await sessionFor("owner-b");
  const workspace = workspaceFor("owner-b");
  const created = await api(`/api/workspaces/${workspace.id}/invitations`, { method: "POST" }, ownerCookie, workspace.id);
  assert.equal(created.status, 201);
  const invitation = (await created.json() as { invitation: { id: string; url: string; expiresAt: string } }).invitation;
  const secret = decodeURIComponent(new URL(invitation.url).hash.match(/[?&]invitation=([^&]+)/)![1]);
  const exactExpiry = Date.parse(invitation.expiresAt);
  assert.ok(Number.isFinite(exactExpiry));

  mock.timers.enable({ apis: ["Date"], now: exactExpiry - 1 });
  try {
    mock.timers.setTime(exactExpiry);
    const response = await api("/api/invitations/redeem", { method: "POST", body: JSON.stringify({ secret, email: "exact-expiry@example.test", password: "a sufficiently long password" }) });
    assert.equal(response.status, 400, "expires_at equal to now is not redeemable");
    assert.ok(!(await response.text()).includes(secret));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'exact-expiry@example.test'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT redeemed_at FROM workspace_invitations WHERE id = ?").get(invitation.id) as { redeemed_at: string | null }).redeemed_at, null);
  } finally {
    mock.timers.reset();
  }
});

test("actual local MCP read tools use an invitee token's private workspace only", async () => {
  const memberId = "mcp-synthetic-member";
  const memberEmail = "mcp-synthetic-member@example.test";
  const personalWorkspaceId = "mcp-member-private-workspace";
  const ownerWorkspace = workspaceFor("owner-a");
  const tokenValue = `rdh_${randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, 'synthetic', 'synthetic')").run(memberId, memberEmail);
  db.prepare("INSERT INTO workspaces (id, owner_user_id, name) VALUES (?, ?, ?)").run(personalWorkspaceId, memberId, "MCP Member private");
  db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(personalWorkspaceId, memberId);
  db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(ownerWorkspace.id, memberId);
  db.prepare("INSERT INTO links (id, owner_id, workspace_id, slug, name, destination_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run("mcp-private-link", memberId, personalWorkspaceId, "mcp-private", "Member private link", "https://private.example.test");
  db.prepare("INSERT INTO links (id, owner_id, workspace_id, slug, name, destination_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run("mcp-shared-link", ownerWorkspace.ownerUserId, ownerWorkspace.id, "mcp-shared", "Owner shared link", "https://shared.example.test");
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?, 'read')")
    .run("mcp-member-token", memberId, "synthetic MCP token", createHash("sha256").update(tokenValue).digest("hex"));

  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
  const apiChild = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_PATH: fixturePath, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiStderr = "";
  apiChild.stderr!.setEncoding("utf8").on("data", (chunk: string) => { apiStderr += chunk; });
  let mcpChild: ReturnType<typeof spawn> | undefined;
  try {
    await waitForApi(apiUrl, apiChild);
    mcpChild = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_PATH: fixturePath, REDIRECT_HUB_API_URL: apiUrl, REDIRECT_HUB_API_TOKEN: tokenValue },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let mcpStderr = "";
    const mcpStdin = mcpChild.stdin!;
    mcpChild.stderr!.setEncoding("utf8").on("data", (chunk: string) => { mcpStderr += chunk; });
    const lineReader = createInterface({ input: mcpChild.stdout! });
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    lineReader.on("line", (line) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result ?? {});
    });
    const rpc = (id: number, method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out. stderr=${mcpStderr}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      mcpStdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    const initialized = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "redirect-hub-test", version: "1.0.0" } });
    assert.ok(initialized.protocolVersion, "MCP child completes its initialize handshake");
    mcpStdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const toolList = await rpc(2, "tools/list", {});
    assert.ok((toolList.tools as Array<{ name: string }>).some((tool) => tool.name === "list_links"));

    const listResult = await rpc(3, "tools/call", { name: "list_links", arguments: {} });
    const listText = ((listResult.content as Array<{ text: string }>)[0]).text;
    const listData = JSON.parse(listText) as { links: Array<{ slug: string; name: string }> };
    assert.deepEqual(listData.links.map((link) => link.slug), ["mcp-private"]);
    assert.ok(!listText.includes("Owner shared link"), "actual MCP list_links response excludes the invited workspace");

    const privateDetail = await rpc(4, "tools/call", { name: "get_link", arguments: { slug: "mcp-private" } });
    assert.ok(((privateDetail.content as Array<{ text: string }>)[0]).text.includes("Member private link"));
    const sharedDetail = await rpc(5, "tools/call", { name: "get_link", arguments: { slug: "mcp-shared" } });
    assert.equal(sharedDetail.isError, true, "actual MCP get_link denies the invited workspace link");
    assert.ok(!JSON.stringify(sharedDetail).includes("Owner shared link"));
  } finally {
    if (mcpChild?.stdin) mcpChild.stdin.end();
    if (mcpChild) await stopChild(mcpChild);
    await stopChild(apiChild);
  }
  assert.ok(apiStderr.length < 10_000, "synthetic API child remains bounded; captured output is diagnostic only");
});
