import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db, type LinkRecord } from "./db.js";
import { createLinkSchema, createRuleSchema, updateLinkSchema, visitorSchema } from "./schemas.js";
import { resolveDestination, type VisitorContext } from "./routing.js";
import { composeDestinationUrl } from "../../../packages/shared/src/utm.js";
import { GeneratedSlugUnavailableError, insertWithGeneratedSlug, isSlugUniqueConflictError } from "./slug.js";

type WorkspaceRole = "owner" | "member";
type WorkspaceContext = { id: string; ownerUserId: string; name: string; role: WorkspaceRole };
type ApiEnv = { Variables: { userId: string; tokenScopes: string[]; sessionAuth: boolean; workspaceId: string; workspaceOwnerId: string; workspaceName: string; workspaceRole: WorkspaceRole } };
const app = new Hono<ApiEnv>();
const port = Number(process.env.PORT ?? 8787);
const SESSION_DAYS = 30;
const sessionCookie = "redirect_hub_session";
const scryptAsync = promisify(scrypt);
const configuredPublicBase = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL) : null;
if (configuredPublicBase && (configuredPublicBase.protocol !== "http:" && configuredPublicBase.protocol !== "https:" || configuredPublicBase.pathname !== "/" || configuredPublicBase.search || configuredPublicBase.hash || configuredPublicBase.username || configuredPublicBase.password)) {
  throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
}

const registerSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(12).max(128),
});
const loginSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(1).max(128),
});
const createTokenSchema = z.object({ name: z.string().trim().min(1).max(60), scopes: z.enum(["read", "read,write"]).default("read") });
const linkTagsSchema = z.object({ tags: z.array(z.string().trim().min(1).max(160)).max(20) });

const ruleOrderSchema = z.object({ direction: z.enum(["up", "down"]) });
const redeemInvitationSchema = z.object({
  secret: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(12).max(128),
});

function getWorkspaceContext(userId: string, requestedId?: string): WorkspaceContext | undefined {
  const workspace = requestedId
    ? db.prepare(`SELECT workspaces.id, workspaces.owner_user_id AS ownerUserId, workspaces.name, workspace_memberships.role
        FROM workspace_memberships JOIN workspaces ON workspaces.id = workspace_memberships.workspace_id
        WHERE workspace_memberships.user_id = ? AND workspaces.id = ?`).get(userId, requestedId) as WorkspaceContext | undefined
    : db.prepare(`SELECT workspaces.id, workspaces.owner_user_id AS ownerUserId, workspaces.name, workspace_memberships.role
        FROM workspace_memberships JOIN workspaces ON workspaces.id = workspace_memberships.workspace_id
        WHERE workspace_memberships.user_id = ? AND workspaces.owner_user_id = ?`).get(userId, userId) as WorkspaceContext | undefined;
  return workspace;
}

function getUserWorkspaces(userId: string) {
  return db.prepare(`SELECT workspaces.id, workspaces.name, workspace_memberships.role,
      workspaces.owner_user_id = workspace_memberships.user_id AS isPersonal
    FROM workspace_memberships JOIN workspaces ON workspaces.id = workspace_memberships.workspace_id
    WHERE workspace_memberships.user_id = ?
    ORDER BY isPersonal DESC, workspaces.name COLLATE NOCASE, workspaces.id`).all(userId) as Array<{ id: string; name: string; role: WorkspaceRole; isPersonal: number }>;
}

function createPrivateWorkspace(userId: string, email: string, createdAt: string): string {
  const existing = db.prepare("SELECT id FROM workspaces WHERE owner_user_id = ?").get(userId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const label = email.split("@")[0] || "My";
  db.prepare("INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, userId, `${label}'s workspace`, createdAt);
  db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, createdAt);
  return id;
}

function genericInvitationFailure(c: Context<ApiEnv>) {
  return c.json({ error: "This invitation could not be redeemed. Check the link and try again." }, 400);
}

function getPublicBaseUrl(requestUrl: string) {
  return configuredPublicBase?.origin ?? new URL(requestUrl).origin;
}

function getLinkUtm(link: LinkRecord) {
  return { source: link.utm_source, medium: link.utm_medium, campaign: link.utm_campaign, term: link.utm_term, content: link.utm_content };
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

function createSessionRecord(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(userId, new Date().toISOString());
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").run(id, userId, hashSessionToken(token), expiresAt);
  return { token, expiresAt };
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, sessionCookie, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

function startSession(c: Parameters<typeof setCookie>[0], userId: string) {
  const session = createSessionRecord(userId);
  setSessionCookie(c, session.token);
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
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health" || c.req.path === "/api/invitations/redeem") return next();
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (user) {
    c.set("userId", user.id);
    c.set("tokenScopes", ["read", "write"]);
    c.set("sessionAuth", true);
    const workspace = getWorkspaceContext(user.id, c.req.header("x-workspace-id")?.trim() || undefined);
    if (!workspace) return c.json({ error: "This workspace is unavailable to your account." }, 404);
    c.set("workspaceId", workspace.id);
    c.set("workspaceOwnerId", workspace.ownerUserId);
    c.set("workspaceName", workspace.name);
    c.set("workspaceRole", workspace.role);
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
  const workspace = getWorkspaceContext(token.user_id);
  if (!workspace) return c.json({ error: "This account has no personal workspace." }, 403);
  if (c.req.header("x-workspace-id") && c.req.header("x-workspace-id") !== workspace.id) {
    return c.json({ error: "API tokens cannot access a shared workspace." }, 403);
  }
  c.set("workspaceId", workspace.id);
  c.set("workspaceOwnerId", workspace.ownerUserId);
  c.set("workspaceName", workspace.name);
  c.set("workspaceRole", workspace.role);
  await next();
});

app.get("/api/auth/session", (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  const configured = Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
  return c.json({ user: user ? { id: user.id, email: user.email } : null, workspaces: user ? getUserWorkspaces(user.id) : [], configured });
});

app.post("/api/workspaces/:workspaceId/invitations", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!c.get("sessionAuth") || c.get("workspaceRole") !== "owner" || c.get("workspaceId") !== workspaceId) {
    return c.json({ error: "Only a signed-in workspace owner can create invitations." }, 403);
  }
  const secret = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const id = randomUUID();
  db.prepare(`INSERT INTO workspace_invitations
    (id, workspace_id, created_by_user_id, secret_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, c.get("userId"), createHash("sha256").update(secret).digest("hex"), createdAt.toISOString(), expiresAt.toISOString());
  const url = `${getPublicBaseUrl(c.req.url)}/#/redeem?invitation=${encodeURIComponent(secret)}`;
  return c.json({ invitation: { id, url, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() } }, 201);
});

app.get("/api/workspaces/:workspaceId/invitations", (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!c.get("sessionAuth") || c.get("workspaceRole") !== "owner" || c.get("workspaceId") !== workspaceId) {
    return c.json({ error: "Only a signed-in workspace owner can view invitations." }, 403);
  }
  const invitations = db.prepare(`SELECT id, created_by_user_id AS createdByUserId, created_at AS createdAt,
      expires_at AS expiresAt, redeemed_at AS redeemedAt, revoked_at AS revokedAt
    FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC, id`).all(workspaceId);
  return c.json({ invitations });
});

app.delete("/api/workspaces/:workspaceId/invitations/:invitationId", (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!c.get("sessionAuth") || c.get("workspaceRole") !== "owner" || c.get("workspaceId") !== workspaceId) {
    return c.json({ error: "Only a signed-in workspace owner can revoke invitations." }, 403);
  }
  const revokedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE workspace_invitations SET revoked_at = ?
    WHERE id = ? AND workspace_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`)
    .run(revokedAt, c.req.param("invitationId"), workspaceId);
  if (!result.changes) return c.json({ error: "Unused invitation not found." }, 404);
  return c.json({ ok: true });
});

app.post("/api/invitations/redeem", async (c) => {
  const parsed = redeemInvitationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return genericInvitationFailure(c);
  const secretHash = createHash("sha256").update(parsed.data.secret).digest("hex");
  const now = new Date().toISOString();
  const invitation = db.prepare(`SELECT id, workspace_id AS workspaceId FROM workspace_invitations
    WHERE secret_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).get(secretHash, now) as { id: string; workspaceId: string } | undefined;
  if (!invitation) return genericInvitationFailure(c);

  const email = parsed.data.email.trim().toLowerCase();
  const userId = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(parsed.data.password, salt);
  const createdAt = new Date().toISOString();
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const sessionExpiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  let personalWorkspaceId = "";
  let invitedWorkspace: { id: string; name: string } | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    const active = db.prepare(`SELECT id, workspace_id AS workspaceId FROM workspace_invitations
      WHERE id = ? AND secret_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .get(invitation.id, secretHash, new Date().toISOString()) as { id: string; workspaceId: string } | undefined;
    if (!active) { db.exec("ROLLBACK"); return genericInvitationFailure(c); }
    if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
      db.exec("ROLLBACK");
      return genericInvitationFailure(c);
    }
    const workspace = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(active.workspaceId) as { id: string; name: string } | undefined;
    if (!workspace) { db.exec("ROLLBACK"); return genericInvitationFailure(c); }
    invitedWorkspace = workspace;
    db.prepare("INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, email, salt, passwordHash.toString("hex"), createdAt);
    personalWorkspaceId = createPrivateWorkspace(userId, email, createdAt);
    db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .run(active.workspaceId, userId, createdAt);
    const consumed = db.prepare(`UPDATE workspace_invitations SET redeemed_at = ?
      WHERE id = ? AND secret_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .run(createdAt, active.id, secretHash, createdAt);
    if (consumed.changes !== 1) throw new Error("Invitation redemption lost the single-use race.");
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(userId, createdAt);
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, userId, hashSessionToken(sessionToken), sessionExpiresAt);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return genericInvitationFailure(c);
    if (error instanceof Error && error.message.includes("Invitation redemption lost")) return genericInvitationFailure(c);
    throw error;
  }
  setSessionCookie(c, sessionToken);
  return c.json({
    user: { id: userId, email },
    personalWorkspaceId,
    workspace: { id: invitedWorkspace!.id, name: invitedWorkspace!.name, role: "member" as const },
  }, 201);
});

app.post("/api/auth/register", async (c) => {
  const input = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Enter a valid email and a password with at least 12 characters." }, 400);

  const userId = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(input.data.password, salt);
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasExistingAccounts = Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
    db.prepare("INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
      .run(userId, input.data.email.trim().toLowerCase(), salt, passwordHash.toString("hex"));
    const createdAt = new Date().toISOString();
    const workspaceId = createPrivateWorkspace(userId, input.data.email.trim().toLowerCase(), createdAt);
    if (!hasExistingAccounts) {
      db.prepare("UPDATE links SET owner_id = ?, workspace_id = ? WHERE owner_id IS NULL").run(userId, workspaceId);
    }
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
  const workspace = getWorkspaceContext(user.id, c.req.header("x-workspace-id")?.trim() || undefined);
  if (!workspace || workspace.role !== "owner") return c.json({ error: "API tokens are available only in your personal owner workspace." }, 403);
  const tokens = db.prepare("SELECT id, name, scopes, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(user.id);
  return c.json({ tokens });
});

app.post("/api/auth/tokens", async (c) => {
  const user = getSessionUser(getCookie(c, sessionCookie));
  if (!user) return c.json({ error: "Sign in to create API tokens." }, 401);
  const workspace = getWorkspaceContext(user.id, c.req.header("x-workspace-id")?.trim() || undefined);
  if (!workspace || workspace.role !== "owner") return c.json({ error: "API tokens are available only in your personal owner workspace." }, 403);
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
  const workspace = getWorkspaceContext(user.id, c.req.header("x-workspace-id")?.trim() || undefined);
  if (!workspace || workspace.role !== "owner") return c.json({ error: "API tokens are available only in your personal owner workspace." }, 403);
  const result = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), c.req.param("id"), user.id);
  if (result.changes === 0) return c.json({ error: "Token not found." }, 404);
  return c.json({ ok: true });
});

function getLinkTags(linkId: string, ownerId: string) {
  return db.prepare(`SELECT tags.name FROM tags JOIN link_tags ON link_tags.tag_id = tags.id AND link_tags.owner_id = tags.owner_id
    WHERE link_tags.link_id = ? AND link_tags.owner_id = ? ORDER BY tags.normalized_name`).all(linkId, ownerId) as Array<{ name: string }>;
}

function serialize(link: LinkRecord, baseUrl: string) {
  const tags = link.owner_id ? getLinkTags(link.id, link.owner_id).map((tag) => tag.name) : [];
  return {
    id: link.id,
    slug: link.slug,
    name: link.name,
    destinationUrl: link.destination_url,
    utmSource: link.utm_source ?? null,
    utmMedium: link.utm_medium ?? null,
    utmCampaign: link.utm_campaign ?? null,
    utmTerm: link.utm_term ?? null,
    utmContent: link.utm_content ?? null,
    shortUrl: `${baseUrl}/l/${encodeURIComponent(link.slug)}`,
    createdAt: link.created_at,
    archivedAt: link.archived_at ?? null,
    tags,
    ...(typeof link.click_count === "number" ? { clickCount: link.click_count } : {}),
  };
}

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/links", (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const workspaceId = c.get("workspaceId");
  const archiveMode = c.req.query("archive") ?? "active";
  if (!(["active", "archived", "all"] as const).includes(archiveMode as "active" | "archived" | "all")) {
    return c.json({ error: "Choose active, archived, or all links." }, 400);
  }
  const search = c.req.query("search")?.trim().slice(0, 200) ?? "";
  const tagId = c.req.query("tag")?.trim() ?? "";
  const archiveClause = archiveMode === "active" ? "links.archived_at IS NULL" : archiveMode === "archived" ? "links.archived_at IS NOT NULL" : "1 = 1";
  const searchClause = search ? "AND (instr(lower(links.name), lower(?)) > 0 OR instr(lower(links.slug), lower(?)) > 0 OR instr(lower(links.destination_url), lower(?)) > 0)" : "";
  const tagClause = tagId ? "AND EXISTS (SELECT 1 FROM link_tags WHERE link_tags.link_id = links.id AND link_tags.owner_id = links.owner_id AND link_tags.tag_id = ? AND link_tags.owner_id = ?)" : "";
  const params: Array<string> = [workspaceId];
  if (search) params.push(search, search, search);
  if (tagId) params.push(tagId, ownerId);
  const rows = db.prepare(`SELECT links.*, SUM(CASE WHEN click_events.is_bot = 0 THEN 1 ELSE 0 END) AS click_count
    FROM links LEFT JOIN click_events ON click_events.link_id = links.id
    WHERE links.workspace_id = ? AND ${archiveClause} ${searchClause} ${tagClause}
    GROUP BY links.id ORDER BY links.created_at DESC, links.rowid DESC`).all(...params) as unknown as LinkRecord[];
  return c.json({ links: rows.map((row) => serialize(row, getPublicBaseUrl(c.req.url))) });
});

app.get("/api/tags", (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const tags = db.prepare(`SELECT tags.id, tags.name, COUNT(link_tags.link_id) AS linkCount
    FROM tags LEFT JOIN link_tags ON link_tags.tag_id = tags.id AND link_tags.owner_id = tags.owner_id
    WHERE tags.owner_id = ? GROUP BY tags.id ORDER BY tags.normalized_name`).all(ownerId);
  return c.json({ tags });
});

app.get("/api/analytics", (c) => {
  const workspaceId = c.get("workspaceId");
  const where = `FROM click_events JOIN links ON links.id = click_events.link_id WHERE links.workspace_id = ? AND click_events.is_bot = 0`;
  const summary = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN julianday(click_events.clicked_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS last_seven_days ${where}`).get(workspaceId) as { total: number; last_seven_days: number | null };
  const devices = db.prepare(`SELECT click_events.device, COUNT(*) AS clicks ${where} GROUP BY click_events.device ORDER BY clicks DESC`).all(workspaceId);
  const topLinks = db.prepare(`SELECT links.id, links.name, links.slug, COUNT(*) AS clicks ${where} GROUP BY links.id ORDER BY clicks DESC LIMIT 5`).all(workspaceId);
  const countries = db.prepare(`SELECT click_events.country_code AS countryCode, COUNT(*) AS clicks ${where} AND click_events.country_code IS NOT NULL GROUP BY click_events.country_code ORDER BY clicks DESC LIMIT 10`).all(workspaceId);
  const rules = db.prepare(`SELECT click_events.matched_rule_id AS ruleId, redirect_rules.priority, redirect_rules.country_code AS countryCode, redirect_rules.device, redirect_rules.destination_url AS destinationUrl, links.name AS linkName, links.slug, COUNT(*) AS clicks
    FROM click_events JOIN links ON links.id = click_events.link_id JOIN redirect_rules ON redirect_rules.id = click_events.matched_rule_id
    WHERE links.workspace_id = ? AND click_events.is_bot = 0 AND click_events.matched_rule_id IS NOT NULL
    GROUP BY click_events.matched_rule_id ORDER BY clicks DESC LIMIT 10`).all(workspaceId);
  return c.json({ totalClicks: summary.total, lastSevenDays: summary.last_seven_days ?? 0, devices, countries, rules, topLinks, tracking: "bot-filtered; no raw IP or full user-agent is stored" });
});

app.post("/api/links", async (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = createLinkSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Check the link details and try again.", issues: parsed.error.flatten().fieldErrors }, 400);

  const input = parsed.data;
  const slug = input.slug ?? "";
  if (slug && pointsToOwnShortUrl(input.destinationUrl, slug, c.req.url)) {
    return c.json({ error: "A short link cannot redirect to itself." }, 400);
  }
  if (slug && db.prepare("SELECT 1 FROM links WHERE slug = ?").get(slug)) {
    return c.json({ error: "That short code is already in use." }, 409);
  }
  const createdAt = new Date().toISOString();
  const link: LinkRecord = {
    id: randomUUID(),
    owner_id: c.get("userId"),
    workspace_id: c.get("workspaceId"),
    slug,
    name: input.name,
    destination_url: input.destinationUrl,
    utm_source: input.utmSource || null,
    utm_medium: input.utmMedium || null,
    utm_campaign: input.utmCampaign || null,
    utm_term: input.utmTerm || null,
    utm_content: input.utmContent || null,
    created_at: createdAt,
    modified_at: createdAt,
    archived_at: null,
  };
  const insertLink = db.prepare("INSERT INTO links (id, owner_id, workspace_id, slug, name, destination_url, utm_source, utm_medium, utm_campaign, utm_term, utm_content, created_at, modified_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)");
  if (input.slug) {
    try { insertLink.run(link.id, link.owner_id, link.workspace_id, input.slug, link.name, link.destination_url, link.utm_source, link.utm_medium, link.utm_campaign, link.utm_term, link.utm_content, createdAt, createdAt); }
    catch (error) {
      if (isSlugUniqueConflictError(error)) return c.json({ error: "That short code is already in use." }, 409);
      throw error;
    }
    link.slug = input.slug;
  } else {
    try {
      const generated = insertWithGeneratedSlug((candidate) => insertLink.run(link.id, link.owner_id, link.workspace_id, candidate, link.name, link.destination_url, link.utm_source, link.utm_medium, link.utm_campaign, link.utm_term, link.utm_content, createdAt, createdAt));
      link.slug = generated.slug;
    } catch (error) {
      if (error instanceof GeneratedSlugUnavailableError) return c.json({ error: error.message }, 503);
      throw error;
    }
  }

  return c.json({ link: serialize(link, getPublicBaseUrl(c.req.url)) }, 201);
});

app.patch("/api/links/:id", async (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const parsed = updateLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide valid link details and UTM values.", issues: parsed.error.flatten().fieldErrors }, 400);
  const existing = db.prepare("SELECT id, slug FROM links WHERE id = ? AND workspace_id = ?").get(c.req.param("id"), c.get("workspaceId")) as { id: string; slug: string } | undefined;
  if (!existing) return c.json({ error: "Link not found." }, 404);
  if (parsed.data.destinationUrl && pointsToOwnShortUrl(parsed.data.destinationUrl, existing.slug, c.req.url)) {
    return c.json({ error: "A short link cannot redirect to itself." }, 400);
  }

  const assignments: string[] = [];
  const values: Array<string | null> = [];
  if (parsed.data.name !== undefined) { assignments.push("name = ?"); values.push(parsed.data.name); }
  if (parsed.data.destinationUrl !== undefined) { assignments.push("destination_url = ?"); values.push(parsed.data.destinationUrl); }
  for (const [field, column] of [["utmSource", "utm_source"], ["utmMedium", "utm_medium"], ["utmCampaign", "utm_campaign"], ["utmTerm", "utm_term"], ["utmContent", "utm_content"]] as const) {
    if (parsed.data[field] !== undefined) { assignments.push(`${column} = ?`); values.push(parsed.data[field] || null); }
  }
  assignments.push("modified_at = ?"); values.push(new Date().toISOString());
  values.push(c.req.param("id"), c.get("workspaceId"));
  db.prepare(`UPDATE links SET ${assignments.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM links WHERE id = ? AND workspace_id = ?").get(c.req.param("id"), c.get("workspaceId")) as unknown as LinkRecord;
  return c.json({ link: serialize(updated, getPublicBaseUrl(c.req.url)) });
});

function cleanTagName(value: string) {
  const name = value.normalize("NFKC").trim();
  if (!name || Array.from(name).length > 40) return null;
  return { name, normalizedName: name.toLowerCase() };
}

app.put("/api/links/:id/tags", async (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const linkId = c.req.param("id");
  const ownerId = c.get("workspaceOwnerId");
  const workspaceId = c.get("workspaceId");
  const link = getOwnedLink(linkId, workspaceId);
  if (!link) return c.json({ error: "Link not found." }, 404);
  const parsed = linkTagsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide up to 20 tag names, each 1–40 characters." }, 400);
  const cleaned = parsed.data.tags.map(cleanTagName);
  if (cleaned.some((tag) => tag === null)) return c.json({ error: "Tag names must contain 1–40 characters after trimming." }, 400);
  const tags = cleaned as Array<{ name: string; normalizedName: string }>;
  if (new Set(tags.map((tag) => tag.normalizedName)).size !== tags.length) {
    return c.json({ error: "Each tag can only be assigned once to a link." }, 400);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM link_tags WHERE link_id = ? AND owner_id = ?").run(linkId, ownerId);
    const insertTag = db.prepare("INSERT INTO tags (id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, normalized_name) DO NOTHING");
    const findTag = db.prepare("SELECT id FROM tags WHERE owner_id = ? AND normalized_name = ?");
    const attachTag = db.prepare("INSERT INTO link_tags (link_id, tag_id, owner_id) VALUES (?, ?, ?)");
    for (const tag of tags) {
      insertTag.run(randomUUID(), ownerId, tag.name, tag.normalizedName);
      const existing = findTag.get(ownerId, tag.normalizedName) as { id: string } | undefined;
      if (!existing) throw new Error("Tag could not be created.");
      attachTag.run(linkId, existing.id, ownerId);
    }
    db.prepare("DELETE FROM tags WHERE owner_id = ? AND NOT EXISTS (SELECT 1 FROM link_tags WHERE link_tags.tag_id = tags.id)").run(ownerId);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  const updated = getOwnedLink(linkId, workspaceId)!;
  return c.json({ link: serialize(updated, getPublicBaseUrl(c.req.url)) });
});

app.post("/api/links/:id/archive", (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const workspaceId = c.get("workspaceId");
  const linkId = c.req.param("id");
  const result = db.prepare("UPDATE links SET archived_at = COALESCE(archived_at, ?), modified_at = ? WHERE id = ? AND workspace_id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), linkId, workspaceId);
  if (!result.changes) return c.json({ error: "Link not found." }, 404);
  return c.json({ link: serialize(getOwnedLink(linkId, workspaceId)!, getPublicBaseUrl(c.req.url)) });
});

app.post("/api/links/:id/unarchive", (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const workspaceId = c.get("workspaceId");
  const linkId = c.req.param("id");
  const result = db.prepare("UPDATE links SET archived_at = NULL, modified_at = ? WHERE id = ? AND workspace_id = ?")
    .run(new Date().toISOString(), linkId, workspaceId);
  if (!result.changes) return c.json({ error: "Link not found." }, 404);
  return c.json({ link: serialize(getOwnedLink(linkId, workspaceId)!, getPublicBaseUrl(c.req.url)) });
});

app.post("/api/links/:id/duplicate", (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const ownerId = c.get("workspaceOwnerId");
  const workspaceId = c.get("workspaceId");
  const source = getOwnedLink(c.req.param("id"), workspaceId);
  if (!source) return c.json({ error: "Link not found." }, 404);
  const createdAt = new Date().toISOString();
  const newLink: Omit<LinkRecord, "slug"> & { slug: string } = {
    id: randomUUID(), owner_id: ownerId, workspace_id: workspaceId, slug: "", name: source.name,
    destination_url: source.destination_url, utm_source: source.utm_source, utm_medium: source.utm_medium,
    utm_campaign: source.utm_campaign, utm_term: source.utm_term, utm_content: source.utm_content, created_at: createdAt,
    modified_at: createdAt, archived_at: null,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertLink = db.prepare("INSERT INTO links (id, owner_id, workspace_id, slug, name, destination_url, utm_source, utm_medium, utm_campaign, utm_term, utm_content, created_at, modified_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)");
    const generated = insertWithGeneratedSlug((slug) => insertLink.run(newLink.id, ownerId, workspaceId, slug, newLink.name, newLink.destination_url, newLink.utm_source, newLink.utm_medium, newLink.utm_campaign, newLink.utm_term, newLink.utm_content, createdAt, createdAt));
    newLink.slug = generated.slug;
    const sourceTags = db.prepare("SELECT tag_id FROM link_tags WHERE link_id = ? AND owner_id = ?").all(source.id, ownerId) as Array<{ tag_id: string }>;
    const attachTag = db.prepare("INSERT INTO link_tags (link_id, tag_id, owner_id) VALUES (?, ?, ?)");
    for (const tag of sourceTags) attachTag.run(newLink.id, tag.tag_id, ownerId);
    const sourceRules = db.prepare("SELECT priority, country_code, device, destination_url FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id").all(source.id) as Array<{ priority: number; country_code: string | null; device: string | null; destination_url: string }>;
    const insertRule = db.prepare("INSERT INTO redirect_rules (id, link_id, priority, country_code, device, destination_url) VALUES (?, ?, ?, ?, ?, ?)");
    for (const rule of sourceRules) insertRule.run(randomUUID(), newLink.id, rule.priority, rule.country_code, rule.device, rule.destination_url);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (error instanceof GeneratedSlugUnavailableError) return c.json({ error: error.message }, 503);
    throw error;
  }
  return c.json({ link: serialize(getOwnedLink(newLink.id, workspaceId)!, getPublicBaseUrl(c.req.url)) }, 201);
});

function getOwnedLink(linkId: string, workspaceId: string) {
  return db.prepare("SELECT * FROM links WHERE id = ? AND workspace_id = ?").get(linkId, workspaceId) as LinkRecord | undefined;
}

app.get("/api/links/:id", (c) => {
  const link = getOwnedLink(c.req.param("id"), c.get("workspaceId"));
  if (!link) return c.json({ error: "Link not found." }, 404);
  return c.json({ link: serialize(link, getPublicBaseUrl(c.req.url)) });
});

app.get("/api/links/:id/rules", (c) => {
  if (!getOwnedLink(c.req.param("id"), c.get("workspaceId"))) return c.json({ error: "Link not found." }, 404);
  const rules = db.prepare("SELECT id, priority, country_code AS countryCode, device, destination_url AS destinationUrl, created_at AS createdAt FROM redirect_rules WHERE link_id = ? ORDER BY priority, created_at, id")
    .all(c.req.param("id"));
  return c.json({ rules, maxRules: 20 });
});

app.post("/api/links/:id/rules", async (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const linkId = c.req.param("id");
  const link = getOwnedLink(linkId, c.get("workspaceId"));
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
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const linkId = c.req.param("id");
  if (!getOwnedLink(linkId, c.get("workspaceId"))) return c.json({ error: "Link not found." }, 404);
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
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "This workspace is read-only for your account." }, 403);
  const linkId = c.req.param("id");
  if (!getOwnedLink(linkId, c.get("workspaceId"))) return c.json({ error: "Link not found." }, 404);
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
  const link = getOwnedLink(c.req.param("id"), c.get("workspaceId"));
  if (!link) return c.json({ error: "Link not found." }, 404);
  const parsed = visitorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Use a two-letter country code and a supported device value." }, 400);
  const context: VisitorContext = { countryCode: parsed.data.countryCode?.toUpperCase() ?? null, device: parsed.data.device ?? "unknown" };
  const resolved = resolveDestination(db, link, context);
  return c.json({ ...resolved, destinationUrl: composeDestinationUrl(resolved.destinationUrl, getLinkUtm(link)), matched: resolved.matchedRuleId !== null, context });
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
  return c.redirect(composeDestinationUrl(resolved.destinationUrl, getLinkUtm(link)), 302);
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`Redirect Hub API listening at http://127.0.0.1:${info.port}`);
  });
}

export { app };
