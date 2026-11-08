import { DatabaseSync } from "node:sqlite";
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
`);

const linkColumns = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
const clickColumns = db.prepare("PRAGMA table_info(click_events)").all() as Array<{ name: string }>;
if (!linkColumns.some((column) => column.name === "owner_id")) {
  db.exec("ALTER TABLE links ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE");
}
if (!linkColumns.some((column) => column.name === "modified_at")) {
  db.exec("ALTER TABLE links ADD COLUMN modified_at TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE links SET modified_at = created_at WHERE modified_at = ''");
}
if (!clickColumns.some((column) => column.name === "matched_rule_id")) {
  db.exec("ALTER TABLE click_events ADD COLUMN matched_rule_id TEXT");
}
if (!clickColumns.some((column) => column.name === "country_code")) {
  db.exec("ALTER TABLE click_events ADD COLUMN country_code TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_links_owner_created ON links(owner_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_click_events_link_time ON click_events(link_id, clicked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_rules_link_priority ON redirect_rules(link_id, priority)");

export interface LinkRecord {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  destination_url: string;
  created_at: string;
  click_count?: number;
}
