import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "redirect-hub-t0027-"));
process.env.DATABASE_PATH = join(fixtureDirectory, "signup.sqlite");
process.env.PORT = "0";

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

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return app.request(`http://redirect-hub.test${path}`, { ...init, headers });
}

async function register(email: string, password: string) {
  return api("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

test("self-service signup preserves bootstrap adoption and isolates subsequent accounts", async () => {
  db.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url) VALUES (?, NULL, ?, ?, ?)")
    .run("legacy-link", "legacy", "Legacy unowned", "https://example.test/legacy");

  const firstResponse = await register(" First@example.test ", "correct horse battery staple");
  assert.equal(firstResponse.status, 201);
  assert.match(firstResponse.headers.get("set-cookie") ?? "", /HttpOnly/i);
  const firstCookie = cookieFrom(firstResponse);
  const firstUser = (await firstResponse.json() as { user: { id: string; email: string } }).user;
  assert.equal(firstUser.email, "first@example.test");
  assert.equal((db.prepare("SELECT owner_id FROM links WHERE id = 'legacy-link'").get() as { owner_id: string }).owner_id, firstUser.id,
    "the first account adopts legacy null-owner links");

  const firstSession = await api("/api/auth/session", {}, firstCookie);
  const firstSessionData = await firstSession.json() as { user: typeof firstUser; configured: boolean; workspaces: Array<{ id: string; role: string; isPersonal: number }> };
  assert.equal(firstSessionData.user.id, firstUser.id);
  assert.equal(firstSessionData.configured, true);
  assert.equal(firstSessionData.workspaces.length, 1);
  assert.equal(firstSessionData.workspaces[0].role, "owner");
  assert.equal(firstSessionData.workspaces[0].isPersonal, 1);

  const firstLinkResponse = await api("/api/links", { method: "POST", body: JSON.stringify({ name: "Owner A link", slug: "owner-a", destinationUrl: "https://example.test/a" }) }, firstCookie);
  assert.equal(firstLinkResponse.status, 201);
  const firstLink = (await firstLinkResponse.json() as { link: { id: string } }).link;
  const ruleResponse = await api(`/api/links/${firstLink.id}/rules`, { method: "POST", body: JSON.stringify({ countryCode: "CA", destinationUrl: "https://example.test/a-ca" }) }, firstCookie);
  assert.equal(ruleResponse.status, 201);
  const rule = (await ruleResponse.json() as { rule: { id: string } }).rule;
  const tagged = await api(`/api/links/${firstLink.id}/tags`, { method: "PUT", body: JSON.stringify({ tags: ["Owner A"] }) }, firstCookie);
  assert.equal(tagged.status, 200);
  const tokenResponse = await api("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name: "Owner A token", scopes: "read" }) }, firstCookie);
  assert.equal(tokenResponse.status, 201);
  const token = (await tokenResponse.json() as { token: { id: string } }).token;
  db.prepare("INSERT INTO click_events (id, link_id, matched_rule_id, clicked_at, device, is_bot) VALUES (?, ?, ?, ?, ?, 0)")
    .run("owner-a-click", firstLink.id, rule.id, new Date().toISOString(), "desktop");

  db.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url) VALUES (?, NULL, ?, ?, ?)")
    .run("later-null-link", "later-unowned", "Later null owner", "https://example.test/unowned");
  const invalidEmail = await register("not-an-email", "correct horse battery staple");
  assert.equal(invalidEmail.status, 400);
  assert.equal(invalidEmail.headers.get("set-cookie"), null);
  const weakPassword = await register("weak@example.test", "short");
  assert.equal(weakPassword.status, 400);
  assert.equal(weakPassword.headers.get("set-cookie"), null);
  const duplicate = await register(" FIRST@example.test ", "correct horse battery staple");
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.headers.get("set-cookie"), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 1,
    "invalid and duplicate requests create no users");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 1,
    "invalid and duplicate requests create no sessions");

  const secondResponse = await register("second@example.test", "another secure password");
  assert.equal(secondResponse.status, 201, "signup stays open after the first account");
  const secondCookie = cookieFrom(secondResponse);
  const secondUser = (await secondResponse.json() as { user: { id: string; email: string } }).user;
  assert.equal(secondUser.email, "second@example.test");
  assert.equal((db.prepare("SELECT owner_id FROM links WHERE id = 'later-null-link'").get() as { owner_id: string | null }).owner_id, null,
    "later registrations do not adopt unowned legacy links");

  const secondLinks = await api("/api/links", {}, secondCookie);
  assert.deepEqual((await secondLinks.json() as { links: unknown[] }).links, []);
  assert.deepEqual((await (await api("/api/tags", {}, secondCookie)).json() as { tags: unknown[] }).tags, []);
  assert.equal((await (await api("/api/analytics", {}, secondCookie)).json() as { totalClicks: number }).totalClicks, 0);
  assert.deepEqual((await (await api("/api/auth/tokens", {}, secondCookie)).json() as { tokens: unknown[] }).tokens, []);
  assert.equal((await api(`/api/links/${firstLink.id}`, { method: "PATCH", body: JSON.stringify({ name: "Attempted takeover" }) }, secondCookie)).status, 404,
    "foreign link lookup does not disclose the record");
  assert.equal((await api(`/api/links/${firstLink.id}/rules/${rule.id}`, { method: "DELETE" }, secondCookie)).status, 404,
    "foreign rule mutation is rejected");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM api_tokens WHERE id = ? AND user_id = ?").get(token.id, firstUser.id) as { count: number }).count, 1,
    "first account's token remains owned by first account");

  const firstLinksAgain = await api("/api/links", {}, firstCookie);
  assert.equal((await firstLinksAgain.json() as { links: Array<{ id: string }> }).links.some((link) => link.id === firstLink.id), true,
    "first account retains its link");
  assert.equal((await (await api("/api/analytics", {}, firstCookie)).json() as { totalClicks: number }).totalClicks, 1,
    "first account retains its click history");

  const logout = await api("/api/auth/logout", { method: "POST" }, firstCookie);
  assert.equal(logout.status, 200);
  assert.equal((await (await api("/api/auth/session", {}, firstCookie)).json() as { user: unknown }).user, null);
  const loginA = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "first@example.test", password: "correct horse battery staple" }) });
  const loginB = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "second@example.test", password: "another secure password" }) });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  assert.equal((await (await api("/api/auth/session", {}, cookieFrom(loginA))).json() as { user: { id: string } }).user.id, firstUser.id);
  assert.equal((await (await api("/api/auth/session", {}, cookieFrom(loginB))).json() as { user: { id: string } }).user.id, secondUser.id);
});
