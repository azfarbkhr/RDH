import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "redirect-hub-t0002-"));
const fixturePath = join(fixtureDirectory, "legacy.sqlite");
process.env.DATABASE_PATH = fixturePath;
process.env.PORT = "0";

function createLegacyFixture() {
  const legacy = new DatabaseSync(fixturePath);
  legacy.exec("PRAGMA foreign_keys = ON;");
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE links (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      modified_at TEXT NOT NULL
    );
    CREATE TABLE redirect_rules (
      id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      country_code TEXT,
      device TEXT,
      destination_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK(country_code IS NOT NULL OR device IS NOT NULL)
    );
    CREATE TABLE click_events (
      id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      matched_rule_id TEXT,
      country_code TEXT,
      clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      device TEXT NOT NULL,
      referrer_host TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacy.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
    .run("owner-1", "owner@example.test", "salt", "hash");
  legacy.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
    .run("owner-2", "other@example.test", "salt", "hash");
  legacy.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("link-1", "owner-1", "legacy-one", "Legacy link", "https://example.test/old", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  legacy.prepare("INSERT INTO redirect_rules (id, link_id, priority, country_code, destination_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("rule-1", "link-1", 1, "CA", "https://example.test/ca", "2026-01-03T00:00:00.000Z");
  legacy.prepare("INSERT INTO click_events (id, link_id, matched_rule_id, country_code, clicked_at, device, referrer_host, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("click-1", "link-1", "rule-1", "CA", "2026-01-04T00:00:00.000Z", "desktop", "source.example", 0);
  legacy.close();
}

test("startup migration preserves legacy link, rule, and click data and defaults the link to active", async (t) => {
  createLegacyFixture();
  const { db } = await import("../src/db.js");
  t.after(() => {
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  const linkColumns = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
  assert.ok(linkColumns.some((column) => column.name === "archived_at"), "migration adds the archive marker");
  assert.ok(linkColumns.some((column) => column.name === "modified_at"));

  const link = db.prepare("SELECT id, owner_id, slug, name, destination_url, created_at, modified_at, archived_at FROM links WHERE id = ?")
    .get("link-1") as Record<string, unknown>;
  assert.deepEqual({ ...link }, {
    id: "link-1",
    owner_id: "owner-1",
    slug: "legacy-one",
    name: "Legacy link",
    destination_url: "https://example.test/old",
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-02T00:00:00.000Z",
    archived_at: null,
  });
  assert.equal((db.prepare("SELECT id FROM redirect_rules WHERE id = ?").get("rule-1") as { id: string }).id, "rule-1");
  assert.equal((db.prepare("SELECT id FROM click_events WHERE id = ?").get("click-1") as { id: string }).id, "click-1");

  const { app } = await import("../src/index.js");
  async function sessionCookie(userId: string) {
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(`session-${userId}`, userId, createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 60_000).toISOString());
    return `redirect_hub_session=${token}`;
  }
  const ownerCookie = await sessionCookie("owner-1");
  const otherCookie = await sessionCookie("owner-2");
  async function api(path: string, cookie: string, init: RequestInit = {}) {
    return app.request(`http://redirect-hub.test${path}`, { ...init, headers: { cookie, ...init.headers } });
  }
  const legacyRedirect = await api("/l/legacy-one", ownerCookie, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  assert.equal(legacyRedirect.status, 302, "pre-migration short URL still redirects");
  assert.equal(legacyRedirect.headers.get("location"), "https://example.test/old");
  async function createLink(cookie: string, name: string, slug: string) {
    const response = await api("/api/links", cookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug, destinationUrl: `https://example.test/${slug}` }) });
    assert.equal(response.status, 201);
    return (await response.json() as { link: { id: string; slug: string; tags: string[]; archivedAt: string | null } }).link;
  }

  const source = await createLink(ownerCookie, "Campaign launch", "launch-a");
  const other = await createLink(otherCookie, "Other owner campaign", "launch-b");
  const assignTags = await api(`/api/links/${source.id}/tags`, ownerCookie, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: ["Launch", "Q4"] }) });
  assert.equal(assignTags.status, 200);
  assert.deepEqual((await assignTags.json() as { link: { tags: string[] } }).link.tags, ["Launch", "Q4"]);

  const otherTags = await api(`/api/links/${other.id}/tags`, otherCookie, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: ["launch"] }) });
  assert.equal(otherTags.status, 200, "same tag names are allowed across owners");
  const ownerTags = await api("/api/tags", ownerCookie);
  const ownerTagList = (await ownerTags.json() as { tags: Array<{ id: string; name: string; linkCount: number }> }).tags;
  assert.deepEqual(ownerTagList.map((tag) => tag.name), ["Launch", "Q4"]);
  assert.equal(ownerTagList[0].linkCount, 1);
  const foreignMutation = await api(`/api/links/${source.id}/tags`, otherCookie, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: ["Forbidden"] }) });
  assert.equal(foreignMutation.status, 404, "another owner cannot mutate this link's tags");

  const filtered = await api(`/api/links?tag=${ownerTagList[0].id}&search=LAUNCH`, ownerCookie);
  const filteredLinks = (await filtered.json() as { links: Array<{ id: string }> }).links;
  assert.deepEqual(filteredLinks.map((link) => link.id), [source.id], "tag and case-insensitive search combine within owner scope");
  const foreignTagFilter = await api(`/api/links?tag=${ownerTagList[0].id}`, otherCookie);
  assert.equal((await foreignTagFilter.json() as { links: unknown[] }).links.length, 0, "a foreign tag ID reveals no owner link");

  const firstRule = await api(`/api/links/${source.id}/rules`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ countryCode: "CA", destinationUrl: "https://example.test/canada" }) });
  const secondRule = await api(`/api/links/${source.id}/rules`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "mobile", destinationUrl: "https://example.test/mobile" }) });
  assert.equal(firstRule.status, 201);
  assert.equal(secondRule.status, 201);
  db.prepare("INSERT INTO click_events (id, link_id, clicked_at, device, is_bot) VALUES (?, ?, ?, ?, ?)")
    .run("click-source", source.id, new Date().toISOString(), "desktop", 0);

  const archived = await api(`/api/links/${source.id}/archive`, ownerCookie, { method: "POST" });
  assert.equal((await archived.json() as { link: { archivedAt: string | null } }).link.archivedAt === null, false);
  const activeLinks = (await (await api("/api/links", ownerCookie)).json() as { links: Array<{ id: string }> }).links;
  assert.ok(!activeLinks.some((link) => link.id === source.id), "active list omits archived links");
  const archivedLinks = (await (await api("/api/links?archive=archived", ownerCookie)).json() as { links: Array<{ id: string }> }).links;
  assert.ok(archivedLinks.some((link) => link.id === source.id));
  const redirectWhileArchived = await api("/l/launch-a", ownerCookie, { headers: { "user-agent": "Mozilla/5.0 (iPhone; Mobile)" } });
  assert.equal(redirectWhileArchived.status, 302);
  assert.equal(redirectWhileArchived.headers.get("location"), "https://example.test/mobile");

  const duplicateResponse = await api(`/api/links/${source.id}/duplicate`, ownerCookie, { method: "POST" });
  assert.equal(duplicateResponse.status, 201);
  const duplicate = (await duplicateResponse.json() as { link: { id: string; slug: string; name: string; destinationUrl: string; tags: string[]; archivedAt: string | null } }).link;
  assert.notEqual(duplicate.id, source.id);
  assert.notEqual(duplicate.slug, source.slug);
  assert.equal(duplicate.name, "Campaign launch");
  assert.equal(duplicate.destinationUrl, "https://example.test/launch-a");
  assert.deepEqual(duplicate.tags, ["Launch", "Q4"]);
  assert.equal(duplicate.archivedAt, null, "duplicate is active");
  const copiedRules = (await (await api(`/api/links/${duplicate.id}/rules`, ownerCookie)).json() as { rules: Array<{ id: string; priority: number; destinationUrl: string }> }).rules;
  assert.equal(copiedRules.length, 2);
  assert.notEqual(copiedRules[0].id, (await firstRule.json() as { rule: { id: string } }).rule.id, "duplicate receives fresh rule IDs");
  assert.notEqual(copiedRules[1].id, (await secondRule.json() as { rule: { id: string } }).rule.id, "each copied rule receives a fresh ID");
  assert.deepEqual(copiedRules.map((rule) => rule.destinationUrl), ["https://example.test/canada", "https://example.test/mobile"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM click_events WHERE link_id = ?").get(duplicate.id) as { count: number }).count, 0, "click history is not copied");

  const unarchived = await api(`/api/links/${source.id}/unarchive`, ownerCookie, { method: "POST" });
  assert.equal((await unarchived.json() as { link: { archivedAt: string | null } }).link.archivedAt, null);
  const customCollision = await api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Slug collision", slug: "launch-a", destinationUrl: "https://example.test/collision" }) });
  assert.equal(customCollision.status, 409);
  const competingRequests = await Promise.all(["one", "two"].map((suffix) => api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Concurrent ${suffix}`, slug: "same-custom-slug", destinationUrl: `https://example.test/${suffix}` }) })));
  assert.deepEqual(competingRequests.map((response) => response.status).sort(), [201, 409], "global uniqueness resolves concurrent custom-slug collision cleanly");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM links WHERE slug = ?").get("same-custom-slug") as { count: number }).count, 1);

  const { insertWithGeneratedSlug, GeneratedSlugUnavailableError } = await import("../src/slug.js");
  const generated = insertWithGeneratedSlug((slug) => {
    if (slug === "occupied") throw new Error("UNIQUE constraint failed: links.slug");
    return slug;
  }, (() => { const candidates = ["occupied", "fresh-slug"]; return () => candidates.shift()!; })());
  assert.equal(generated.slug, "fresh-slug");
  let collisionAttempts = 0;
  assert.throws(() => insertWithGeneratedSlug(() => { collisionAttempts += 1; throw new Error("UNIQUE constraint failed: links.slug"); }, () => "occupied", 3), GeneratedSlugUnavailableError);
  assert.equal(collisionAttempts, 3, "generated slug retries are bounded");
});
