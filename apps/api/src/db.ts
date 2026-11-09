import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const databasePath = resolve(process.env.DATABASE_PATH ?? join(workspaceRoot, "data", "redirect-hub.sqlite"));
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL CHECK(scopes IN ('read', 'read,write')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS click_events (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    matched_rule_id TEXT,
    country_code TEXT,
    clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    device TEXT NOT NULL CHECK(device IN ('mobile', 'desktop', 'bot', 'unknown')),
    referrer_host TEXT,
    is_bot INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS redirect_rules (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL,
    country_code TEXT,
    device TEXT CHECK(device IN ('mobile', 'desktop')),
    destination_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK(country_code IS NOT NULL OR device IS NOT NULL)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_one_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
  CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user ON workspace_memberships(user_id, created_at);
  CREATE TABLE IF NOT EXISTS workspace_invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id, created_at DESC);
`);

const linkColumns = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
const clickColumns = db.prepare("PRAGMA table_info(click_events)").all() as Array<{ name: string }>;
if (!linkColumns.some((column) => column.name === "owner_id")) {
  db.exec("ALTER TABLE links ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE");
}
if (!linkColumns.some((column) => column.name === "workspace_id")) {
  db.exec("ALTER TABLE links ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL");
}
if (!linkColumns.some((column) => column.name === "archived_at")) {
  db.exec("ALTER TABLE links ADD COLUMN archived_at TEXT");
}
if (!linkColumns.some((column) => column.name === "modified_at")) {
  db.exec("ALTER TABLE links ADD COLUMN modified_at TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE links SET modified_at = created_at WHERE modified_at = ''");
}
for (const column of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
  if (!linkColumns.some((existing) => existing.name === column)) db.exec(`ALTER TABLE links ADD COLUMN ${column} TEXT`);
}
if (!clickColumns.some((column) => column.name === "matched_rule_id")) {
  db.exec("ALTER TABLE click_events ADD COLUMN matched_rule_id TEXT");
}
if (!clickColumns.some((column) => column.name === "country_code")) {
  db.exec("ALTER TABLE click_events ADD COLUMN country_code TEXT");
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_links_id_owner ON links(id, owner_id);
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (id, owner_id),
    UNIQUE (owner_id, normalized_name)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_owner_name ON tags(owner_id, normalized_name);
  CREATE TABLE IF NOT EXISTS link_tags (
    link_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY (link_id, tag_id),
    FOREIGN KEY (link_id, owner_id) REFERENCES links(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id, owner_id) REFERENCES tags(id, owner_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_link_tags_owner_tag ON link_tags(owner_id, tag_id, link_id);
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_links_workspace_created ON links(workspace_id, created_at DESC)");
db.exec("BEGIN IMMEDIATE");
try {
  const users = db.prepare("SELECT id, email, created_at FROM users ORDER BY created_at, id").all() as Array<{ id: string; email: string; created_at: string }>;
  const findWorkspace = db.prepare("SELECT id FROM workspaces WHERE owner_user_id = ?") as ReturnType<typeof db.prepare>;
  const insertWorkspace = db.prepare("INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)");
  const insertOwner = db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'");
  const assignLinks = db.prepare("UPDATE links SET workspace_id = ? WHERE owner_id = ? AND workspace_id IS NULL");
  for (const user of users) {
    const existing = findWorkspace.get(user.id) as { id: string } | undefined;
    const workspaceId = existing?.id ?? randomUUID();
    if (!existing) insertWorkspace.run(workspaceId, user.id, `${user.email.split("@")[0]}'s workspace`, user.created_at);
    insertOwner.run(workspaceId, user.id, user.created_at);
    assignLinks.run(workspaceId, user.id);
  }
  db.exec("COMMIT");
} catch (error) {
  if (db.isTransaction) db.exec("ROLLBACK");
  throw error;
}
db.exec("CREATE INDEX IF NOT EXISTS idx_links_owner_created ON links(owner_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_links_owner_archive_created ON links(owner_id, archived_at, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_click_events_link_time ON click_events(link_id, clicked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_rules_link_priority ON redirect_rules(link_id, priority)");

export interface LinkRecord {
  id: string;
  owner_id: string;
  workspace_id: string;
  slug: string;
  name: string;
  destination_url: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  created_at: string;
  modified_at: string;
  archived_at: string | null;
  click_count?: number;
}
