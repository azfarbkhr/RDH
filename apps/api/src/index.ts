import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db, type LinkRecord } from "./db.js";
import { createLinkSchema, createRuleSchema, updateLinkSchema, visitorSchema } from "./schemas.js";
import { resolveDestination, type VisitorContext } from "./routing.js";

const app = new Hono<{ Variables: { userId: string; tokenScopes: string[]; sessionAuth: boolean } }>();
const port = Number(process.env.PORT ?? 8787);
const SESSION_DAYS = 30;
const sessionCookie = "redirect_hub_session";
const scryptAsync = promisify(scrypt);
const configuredPublicBase = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL) : null;
if (configuredPublicBase && (configuredPublicBase.protocol !== "http:" && configuredPublicBase.protocol !== "https:" || configuredPublicBase.pathname !== "/" || configuredPublicBase.search || configuredPublicBase.hash || configuredPublicBase.username || configuredPublicBase.password)) {
  throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
}

const registerSchema = z.object({
  email: z.email().trim().max(254),
  password: z.string().min(12).max(128),
});
const loginSchema = z.object({
  email: z.email().trim().max(254),
  password: z.string().min(1).max(128),
});
const createTokenSchema = z.object({ name: z.string().trim().min(1).max(60), scopes: z.enum(["read", "read,write"]).default("read") });

const ruleOrderSchema = z.object({ direction: z.enum(["up", "down"]) });

function getPublicBaseUrl(requestUrl: string) {
  return configuredPublicBase?.origin ?? new URL(requestUrl).origin;
}

function pointsToOwnShortUrl(destinationUrl: string, slug: string, requestUrl: string) {
  const destination = new URL(destinationUrl);
  if (destination.origin !== getPublicBaseUrl(requestUrl)) return false;
  const match = destination.pathname.match(/^\/l\/([^/]+)\/?$/);
  if (!match) return false;
  try { return decodeURIComponent(match[1]) === slug; }
  catch { return false; }
}

function classifyDevice(userAgent: string): "bot" | "mobile" | "desktop" | "unknown" {
  if (/bot|crawl|spider|preview|slack|discord|facebookexternalhit|whatsapp/i.test(userAgent)) return "bot";
  if (/mobile|android|iphone|ipad/i.test(userAgent)) return "mobile";
  return userAgent ? "desktop" : "unknown";
}

function getVisitorContext(countryHeader: string | undefined, userAgent: string): VisitorContext {
  const rawCountry = process.env.COUNTRY_HEADER_PROVIDER === "cloudflare" ? countryHeader?.toUpperCase() : undefined;
  const countryCode = rawCountry && /^[A-Z]{2}$/.test(rawCountry) && rawCountry !== "XX" ? rawCountry : null;
  const classified = classifyDevice(userAgent);
  return { countryCode, device: classified === "mobile" || classified === "desktop" ? classified : "unknown" };
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string, salt: string) {
  return (await scryptAsync(password, salt, 64)) as Buffer;
}

function startSession(c: Parameters<typeof setCookie>[0], userId: string) {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(userId, new Date().toISOString());
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").run(id, userId, hashSessionToken(token), expiresAt);
  setCookie(c, sessionCookie, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

function getSessionUser(token: string | undefined) {
  if (!token) return undefined;
  const row = db.prepare(`
    SELECT users.id, users.email, sessions.id AS session_id, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashSessionToken(token)) as { id: string; email: string; session_id: string; expires_at: string } | undefined;
  if (!row) return undefined;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return undefined;
  }
  return row;
}

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (user) {
    c.set("userId", user.id);
    c.set("tokenScopes", ["read", "write"]);
    c.set("sessionAuth", true);
    return next();
  }
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return c.json({ error: "Sign in to manage your links." }, 401);
  const tokenHash = hashSessionToken(bearer);
  const token = db.prepare("SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as { id: string; user_id: string; scopes: string } | undefined;
  if (!token) return c.json({ error: "The API token is invalid or has been revoked." }, 401);
  const requiredScope = c.req.method === "GET" || c.req.path.endsWith("/simulate") ? "read" : "write";
  if (!token.scopes.split(",").includes(requiredScope)) return c.json({ error: `This API token does not have the ${requiredScope} scope.` }, 403);
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), token.id);
  c.set("userId", token.user_id);
  c.set("tokenScopes", token.scopes.split(","));
  c.set("sessionAuth", false);
  await next();
});

app.get("/api/auth/session", (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  const configured = Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
  return c.json({ user: user ? { id: user.id, email: user.email } : null, configured });
});

app.post("/api/auth/register", async (c) => {
  const input = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Enter a valid email and a password with at least 12 characters." }, 400);

  const userId = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(input.data.password, salt);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
      db.exec("ROLLBACK");
      return c.json({ error: "This instance already has an account. Sign in instead." }, 409);
    }
    db.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
      .run(userId, input.data.email.trim().toLowerCase(), salt, passwordHash.toString("hex"));
    db.prepare("UPDATE links SET owner_id = ? WHERE owner_id IS NULL").run(userId);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "This email is already registered." }, 409);
    }
    throw error;
  }
  startSession(c, userId);
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(userId);
  return c.json({ user }, 201);
});

app.post("/api/auth/login", async (c) => {
  const input = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Enter a valid email and password." }, 400);
  const user = db.prepare("SELECT id, email, password_salt, password_hash FROM users WHERE email = ? COLLATE NOCASE")
    .get(input.data.email.trim()) as { id: string; email: string; password_salt: string; password_hash: string } | undefined;
  const salt = user?.password_salt ?? "redirect-hub-login-fallback";
  const actual = await hashPassword(input.data.password, salt);
  const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!user || !matches) return c.json({ error: "Email or password is incorrect." }, 401);
  startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email } });
});

app.post("/api/auth/logout", (c) => {
  const token = getCookie(c, sessionCookie);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
  deleteCookie(c, sessionCookie, { path: "/", secure: process.env.NODE_ENV === "production", sameSite: "Lax" });
  return c.json({ ok: true });
});

app.get("/api/auth/tokens", (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (!user) return c.json({ error: "Sign in to manage API tokens." }, 401);
  const tokens = db.prepare("SELECT id, name, scopes, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(user.id);
  return c.json({ tokens });
});

app.post("/api/auth/tokens", async (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (!user) return c.json({ error: "Sign in to create API tokens." }, 401);
  const parsed = createTokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide a token name and choose read or read/write access." }, 400);
  const count = (db.prepare("SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL").get(user.id) as { count: number }).count;
  if (count >= 10) return c.json({ error: "Revoke an unused token before creating another. Each account can have up to 10 active tokens." }, 409);
  const id = randomUUID();
  const tokenValue = `rdh_${randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?, ?)")
    .run(id, user.id, parsed.data.name, hashSessionToken(tokenValue), parsed.data.scopes);
  return c.json({ token: { id, name: parsed.data.name, scopes: parsed.data.scopes, value: tokenValue } }, 201);
});

app.delete("/api/auth/tokens/:id", (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (!user) return c.json({ error: "Sign in to revoke API tokens." }, 401);
  const result = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), c.req.param("id"), user.id);
  if (result.changes === 0) return c.json({ error: "Token not found." }, 404);
  return c.json({ ok: true });
});

function serialize(link: LinkRecord, baseUrl: string) {
  return {
    id: link.id,
    slug: link.slug,
    name: link.name,
    destinationUrl: link.destination_url,
    shortUrl: `${baseUrl}/l/${encodeURIComponent(link.slug)}`,
    createdAt: link.created_at,
  };
}

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/links", (c) => {
  const rows = db.prepare(`SELECT links.*, SUM(CASE WHEN click_events.is_bot = 0 THEN 1 ELSE 0 END) AS click_count
    FROM links LEFT JOIN click_events ON click_events.link_id = links.id
    WHERE links.owner_id = ? GROUP BY links.id ORDER BY links.created_at DESC, links.rowid DESC`).all(c.get("userId")) as unknown as LinkRecord[];
  return c.json({ links: rows.map((row) => serialize(row, getPublicBaseUrl(c.req.url))) });
});

app.get("/api/analytics", (c) => {
  const ownerId = c.get("userId");
  const where = `FROM click_events JOIN links ON links.id = click_events.link_id WHERE links.owner_id = ? AND click_events.is_bot = 0`;
  const summary = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN julianday(click_events.clicked_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS last_seven_days ${where}`).get(ownerId) as { total: number; last_seven_days: number | null };
  const devices = db.prepare(`SELECT click_events.device, COUNT(*) AS clicks ${where} GROUP BY click_events.device ORDER BY clicks DESC`).all(ownerId);
  const topLinks = db.prepare(`SELECT links.id, links.name, links.slug, COUNT(*) AS clicks ${where} GROUP BY links.id ORDER BY clicks DESC LIMIT 5`).all(ownerId);
  const countries = db.prepare(`SELECT click_events.country_code AS countryCode, COUNT(*) AS clicks ${where} AND click_events.country_code IS NOT NULL GROUP BY click_events.country_code ORDER BY clicks DESC LIMIT 10`).all(ownerId);
  const rules = db.prepare(`SELECT click_events.matched_rule_id AS ruleId, redirect_rules.priority, redirect_rules.country_code AS countryCode, redirect_rules.device, redirect_rules.destination_url AS destinationUrl, links.name AS linkName, links.slug, COUNT(*) AS clicks
    FROM click_events JOIN links ON links.id = click_events.link_id JOIN redirect_rules ON redirect_rules.id = click_events.matched_rule_id
    WHERE links.owner_id = ? AND click_events.is_bot = 0 AND click_events.matched_rule_id IS NOT NULL
    GROUP BY click_events.matched_rule_id ORDER BY clicks DESC LIMIT 10`).all(ownerId);
  return c.json({ totalClicks: summary.total, lastSevenDays: summary.last_seven_days ?? 0, devices, countries, rules, topLinks, tracking: "bot-filtered; no raw IP or full user-agent is stored" });
});

app.post("/api/links", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createLinkSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Check the link details and try again.", issues: parsed.error.flatten().fieldErrors }, 400);

  const input = parsed.data;
  const slug = input.slug ?? randomBytes(5).toString("base64url");
  if (pointsToOwnShortUrl(input.destinationUrl, slug, c.req.url)) {
    return c.json({ error: "A short link cannot redirect to itself." }, 400);
  }
  if (db.prepare("SELECT 1 FROM links WHERE slug = ?").get(slug)) {
    return c.json({ error: "That short code is already in use." }, 409);
  }

  const link: LinkRecord = {
    id: randomUUID(),
    owner_id: c.get("userId"),
    slug,
    name: input.name,
    destination_url: input.destinationUrl,
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare("INSERT INTO links (id, owner_id, slug, name, destination_url, created_at) VALUES (@id, @owner_id, @slug, @name, @destination_url, @created_at)").run({ ...link });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "That short code is already in use." }, 409);
    }
    throw error;
  }

  return c.json({ link: serialize(link, getPublicBaseUrl(c.req.url)) }, 201);
});

app.patch("/api/links/:id", async (c) => {
  const parsed = updateLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide a valid link name or HTTP(S) destination." }, 400);
  const existing = db.prepare("SELECT id, slug FROM links WHERE id = ? AND owner_id = ?").get(c.req.param("id"), c.get("userId")) as { id: string; slug: string } | undefined;
  if (!existing) return c.json({ error: "Link not found." }, 404);
  if (parsed.data.destinationUrl && pointsToOwnShortUrl(parsed.data.destinationUrl, existing.slug, c.req.url)) {
    return c.json({ error: "A short link cannot redirect to itself." }, 400);
  }

  const assignments: string[] = [];
  const values: string[] = [];
  if (parsed.data.name !== undefined) { assignments.push("name = ?"); values.push(parsed.data.name); }
  if (parsed.data.destinationUrl !== undefined) { assignments.push("destination_url = ?"); values.push(parsed.data.destinationUrl); }
  assignments.push("modified_at = ?"); values.push(new Date().toISOString());
  values.push(c.req.param("id"), c.get("userId"));
  db.prepare(`UPDATE links SET ${assignments.join(", ")} WHERE id = ? AND owner_id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM links WHERE id = ? AND owner_id = ?").get(c.req.param("id"), c.get("userId")) as unknown as LinkRecord;
  return c.json({ link: serialize(updated, getPublicBaseUrl(c.req.url)) });
});

function getOwnedLink(linkId: string, ownerId: string) {
  return db.prepare("SELECT * FROM links WHERE id = ? AND owner_id = ?").get(linkId, ownerId) as LinkRecord | undefined;
}

app.get("/api/links/:id/rules", (c) => {
  if (!getOwnedLink(c.req.param("id"), c.get("userId"))) return c.json({ error: "Link not found." }, 404);
  const rules = db.prepare("SELECT id, priority, country_code AS countryCode, device, destination_url AS destinationUrl, created_at AS createdAt FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id")
    .all(c.req.param("id"));
  return c.json({ rules, maxRules: 20 });
});

app.post("/api/links/:id/rules", async (c) => {
  const linkId = c.req.param("id");
  const link = getOwnedLink(linkId, c.get("userId"));
  if (!link) return c.json({ error: "Link not found." }, 404);
  const parsed = createRuleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Add a valid HTTP(S) destination and at least one country or device condition.", issues: parsed.error.flatten().fieldErrors }, 400);
  if (pointsToOwnShortUrl(parsed.data.destinationUrl, link.slug, c.req.url)) {
    return c.json({ error: "A routing rule cannot redirect back to the same short link." }, 400);
  }
  const count = (db.prepare("SELECT COUNT(*) AS count FROM redirect_rules WHERE link_id = ?").get(linkId) as { count: number }).count;
  if (count >= 20) return c.json({ error: "A link can have at most 20 routing rules." }, 409);
  const priority = ((db.prepare("SELECT MAX(priority) AS priority FROM redirect_rules WHERE link_id = ?").get(linkId) as { priority: number | null }).priority ?? 0) + 1;
  const id = randomUUID();
  db.prepare("INSERT INTO redirect_rules (id, link_id, priority, country_code, device, destination_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, linkId, priority, parsed.data.countryCode?.toUpperCase() ?? null, parsed.data.device ?? null, parsed.data.destinationUrl);
  return c.json({ rule: db.prepare("SELECT id, priority, country_code AS countryCode, device, destination_url AS destinationUrl, created_at AS createdAt FROM redirect_rules WHERE id = ?").get(id) }, 201);
});

app.delete("/api/links/:id/rules/:ruleId", (c) => {
  const linkId = c.req.param("id");
  if (!getOwnedLink(linkId, c.get("userId"))) return c.json({ error: "Link not found." }, 404);
  const exists = db.prepare("SELECT 1 FROM redirect_rules WHERE id = ? AND link_id = ?").get(c.req.param("ruleId"), linkId);
  if (!exists) return c.json({ error: "Rule not found." }, 404);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM redirect_rules WHERE id = ? AND link_id = ?").run(c.req.param("ruleId"), linkId);
    const remaining = db.prepare("SELECT id FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id").all(linkId) as Array<{ id: string }>;
    const update = db.prepare("UPDATE redirect_rules SET priority = ? WHERE id = ?");
    remaining.forEach((rule, index) => update.run(index + 1, rule.id));
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  const rules = db.prepare("SELECT id, priority, country_code AS countryCode, device, destination_url AS destinationUrl, created_at AS createdAt FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id").all(linkId);
  return c.json({ rules });
});

app.patch("/api/links/:id/rules/:ruleId/priority", async (c) => {
  const linkId = c.req.param("id");
  if (!getOwnedLink(linkId, c.get("userId"))) return c.json({ error: "Link not found." }, 404);
  const parsed = ruleOrderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose whether to move this rule up or down." }, 400);
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT id, priority FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id").all(linkId) as Array<{ id: string; priority: number }>;
    const currentIndex = rows.findIndex((row) => row.id === c.req.param("ruleId"));
    if (currentIndex === -1) { db.exec("ROLLBACK"); return c.json({ error: "Rule not found." }, 404); }
    const targetIndex = currentIndex + (parsed.data.direction === "up" ? -1 : 1);
    if (targetIndex >= 0 && targetIndex < rows.length) {
      const reorder = db.prepare("UPDATE redirect_rules SET priority = ? WHERE id = ? AND link_id = ?");
      reorder.run(-1, rows[currentIndex].id, linkId);
      reorder.run(rows[currentIndex].priority, rows[targetIndex].id, linkId);
      reorder.run(rows[targetIndex].priority, rows[currentIndex].id, linkId);
    }
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  const rules = db.prepare("SELECT id, priority, country_code AS countryCode, device, destination_url AS destinationUrl, created_at AS createdAt FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id").all(linkId);
  return c.json({ rules });
});

app.post("/api/links/:id/simulate", async (c) => {
  const link = getOwnedLink(c.req.param("id"), c.get("userId"));
  if (!link) return c.json({ error: "Link not found." }, 404);
  const parsed = visitorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Use a two-letter country code and a supported device value." }, 400);
  const context: VisitorContext = { countryCode: parsed.data.countryCode?.toUpperCase() ?? null, device: parsed.data.device ?? "unknown" };
  const resolved = resolveDestination(db, link, context);
  return c.json({ ...resolved, matched: resolved.matchedRuleId !== null, context });
});

app.get("/l/:slug", (c) => {
  const link = db.prepare("SELECT * FROM links WHERE slug = ?").get(c.req.param("slug")) as LinkRecord | undefined;
  if (!link) return c.text("Short link not found", 404);
  const userAgent = c.req.header("user-agent") ?? "";
  const classified = classifyDevice(userAgent);
  const isBot = classified === "bot";
  const visitor = getVisitorContext(c.req.header("cf-ipcountry"), userAgent);
  const device = classified;
  let referrerHost: string | null = null;
  try {
    const referer = c.req.header("referer");
    if (referer) referrerHost = new URL(referer).hostname.slice(0, 253);
  } catch { /* Ignore malformed referrers. */ }
  const resolved = resolveDestination(db, link, visitor);
  db.prepare("INSERT INTO click_events (id, link_id, matched_rule_id, country_code, device, referrer_host, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), link.id, resolved.matchedRuleId, visitor.countryCode, device, referrerHost, isBot ? 1 : 0);
  return c.redirect(resolved.destinationUrl, 302);
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Redirect Hub API listening at http://127.0.0.1:${info.port}`);
});

export { app };
