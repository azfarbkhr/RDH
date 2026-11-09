import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeDestinationUrl } from "../../../packages/shared/src/utm.js";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "redirect-hub-t0003-"));
process.env.DATABASE_PATH = join(fixtureDirectory, "utm.sqlite");
process.env.PORT = "0";

test("UTM values persist per owner, compose identically for preview contract/simulation/redirect, and ignore visitor query", async (t) => {
  const { db } = await import("../src/db.js");
  const { app } = await import("../src/index.js");
  t.after(() => { db.close(); rmSync(fixtureDirectory, { recursive: true, force: true }); });

  for (const id of ["utm-owner", "utm-other"]) {
    db.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
      .run(id, `${id}@example.test`, "salt", "hash");
    const workspaceId = `workspace-${id}`;
    db.prepare("INSERT INTO workspaces (id, owner_user_id, name) VALUES (?, ?, ?)").run(workspaceId, id, `${id} workspace`);
    db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspaceId, id);
  }
  const cookieFor = (ownerId: string) => {
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(`session-${ownerId}`, ownerId, createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 60_000).toISOString());
    return `redirect_hub_session=${token}`;
  };
  const ownerCookie = cookieFor("utm-owner");
  const otherCookie = cookieFor("utm-other");
  const api = (path: string, cookie: string, init: RequestInit = {}) => app.request(`http://redirect-hub.test${path}`, { ...init, headers: { cookie, ...init.headers } });

  const created = await api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    name: "UTM campaign", slug: "utm-campaign",
    destinationUrl: "https://dest.example/default?a=1&a=2&utm_source=old&UTM_SOURCE=older#section",
    utmSource: " launch team ", utmMedium: "social", utmCampaign: "café 東京", utmTerm: "", utmContent: "tile A",
  }) });
  assert.equal(created.status, 201);
  const createdLink = (await created.json() as { link: { id: string; utmSource: string; utmMedium: string; utmCampaign: string; utmTerm: string | null; utmContent: string } }).link;
  assert.deepEqual([createdLink.utmSource, createdLink.utmMedium, createdLink.utmCampaign, createdLink.utmTerm, createdLink.utmContent], ["launch team", "social", "café 東京", null, "tile A"]);

  const update = await api(`/api/links/${createdLink.id}`, ownerCookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ utmMedium: " paid-social " }) });
  assert.equal(update.status, 200);
  let updatedLink = (await update.json() as { link: { utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string } }).link;
  assert.deepEqual([updatedLink.utmSource, updatedLink.utmMedium, updatedLink.utmCampaign, updatedLink.utmContent], ["launch team", "paid-social", "café 東京", "tile A"], "omitted PATCH fields remain unchanged and supplied values are trimmed");
  assert.equal((await api(`/api/links/${createdLink.id}`, otherCookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ utmSource: "foreign" }) })).status, 404);
  const ownerList = await api("/api/links", ownerCookie);
  assert.equal(((await ownerList.json() as { links: Array<{ id: string; utmMedium: string }> }).links.find((link) => link.id === createdLink.id))?.utmMedium, "paid-social", "owner can read saved UTM values");
  const otherList = await api("/api/links", otherCookie);
  assert.ok(!(await otherList.json() as { links: Array<{ id: string }> }).links.some((link) => link.id === createdLink.id), "another owner's list does not expose the link");
  const clear = await api(`/api/links/${createdLink.id}`, ownerCookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ utmSource: null, utmMedium: "", utmCampaign: "   ", utmContent: null }) });
  assert.equal(clear.status, 200);
  updatedLink = (await clear.json() as { link: typeof updatedLink }).link;
  assert.deepEqual([updatedLink.utmSource, updatedLink.utmMedium, updatedLink.utmCampaign, updatedLink.utmContent], [null, null, null, null]);
  const clearedSimulation = await api(`/api/links/${createdLink.id}/simulate`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "desktop" }) });
  const clearedDestination = new URL((await clearedSimulation.json() as { destinationUrl: string }).destinationUrl);
  assert.equal(clearedDestination.searchParams.has("utm_source"), false);
  assert.equal(clearedDestination.searchParams.has("UTM_SOURCE"), false);

  const utmFields = ["utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent"] as const;
  for (const field of utmFields) {
    const tooLong = await api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Too long", slug: `utm-long-${field.slice(3).toLowerCase()}`, destinationUrl: "https://dest.example", [field]: "🙂".repeat(201) }) });
    assert.equal(tooLong.status, 400, `${field} rejects 201 Unicode code points`);
    assert.ok((await tooLong.json() as { issues: Record<string, unknown> }).issues[field], `${field} length error is field-specific`);
    const badType = await api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bad type", slug: `utm-type-${field.slice(3).toLowerCase()}`, destinationUrl: "https://dest.example", [field]: 4 }) });
    assert.equal(badType.status, 400, `${field} rejects non-string values`);
    assert.ok((await badType.json() as { issues: Record<string, unknown> }).issues[field], `${field} type error is field-specific`);
    const accepted = await api("/api/links", ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "At limit", slug: `utm-limit-${field.slice(3).toLowerCase()}`, destinationUrl: "https://dest.example", [field]: "🙂".repeat(200) }) });
    assert.equal(accepted.status, 201, `${field} accepts 200 Unicode code points`);
  }

  const restore = await api(`/api/links/${createdLink.id}`, ownerCookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ utmSource: "launch team", utmMedium: "social", utmCampaign: "café 東京", utmTerm: "search", utmContent: "tile A" }) });
  assert.equal(restore.status, 200);
  const ruleResponse = await api(`/api/links/${createdLink.id}/rules`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "mobile", destinationUrl: "https://dest.example/mobile?x=first&x=second&utm_medium=old#mobile" }) });
  assert.equal(ruleResponse.status, 201);

  const defaultSimulation = await api(`/api/links/${createdLink.id}/simulate`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "desktop" }) });
  const defaultUrl = (await defaultSimulation.json() as { destinationUrl: string }).destinationUrl;
  const defaultParsed = new URL(defaultUrl);
  assert.deepEqual(defaultParsed.searchParams.getAll("a"), ["1", "2"]);
  assert.deepEqual(defaultParsed.searchParams.getAll("utm_source"), ["launch team"]);
  assert.deepEqual(defaultParsed.searchParams.getAll("utm_campaign"), ["café 東京"]);
  assert.equal(defaultParsed.searchParams.has("UTM_SOURCE"), false);
  assert.equal(defaultParsed.hash, "#section");

  const simulated = await api(`/api/links/${createdLink.id}/simulate`, ownerCookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "mobile" }) });
  const simulatedData = await simulated.json() as { destinationUrl: string; matched: boolean };
  assert.equal(simulatedData.matched, true);
  const redirect = await app.request("http://redirect-hub.test/l/utm-campaign?utm_source=attacker&destinationUrl=https%3A%2F%2Fevil.example&visitor=ignored&visitor=also-ignored", { headers: { "user-agent": "Mozilla/5.0 (iPhone; Mobile)" } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), simulatedData.destinationUrl, "simulation and live redirect compose the same selected route");
  const mobileUrl = new URL(redirect.headers.get("location")!);
  assert.deepEqual(mobileUrl.searchParams.getAll("x"), ["first", "second"]);
  assert.equal(mobileUrl.hash, "#mobile");
  assert.deepEqual(mobileUrl.searchParams.getAll("utm_source"), ["launch team"]);
  assert.equal(mobileUrl.searchParams.has("destinationUrl"), false);
  assert.equal(mobileUrl.searchParams.has("visitor"), false);

  const clearSource = composeDestinationUrl("https://dest.example/?utm_source=old&UTM_SOURCE=older&a=1&a=2#frag", { source: "", campaign: "café 東京" });
  const parsed = new URL(clearSource);
  assert.equal(parsed.searchParams.has("utm_source"), false);
  assert.deepEqual(parsed.searchParams.getAll("a"), ["1", "2"]);
  assert.equal(parsed.searchParams.get("utm_campaign"), "café 東京");
  assert.equal(parsed.hash, "#frag");
});
