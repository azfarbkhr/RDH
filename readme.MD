# Redirect Hub

## Goal

Build a self-hosted link redirection service where one short URL can send visitors to different destinations based on simple country and device rules. Keep the routing easy to inspect, preview, and understand, with useful click analytics and a local MCP interface for link management.

The repository contains an early working Node.js, Hono, and React prototype alongside its project tickets and documentation. It supports self-service sign-up with separate owner-scoped accounts, editable short links, ordered country/device rules, a visitor simulator, HTTP 302 redirects, and bot-filtered click totals with available country and rule-match breakdowns. This is a functional prototype; it has not yet been prepared for public deployment.

## Try the local prototype

Requirements: Node.js 22 or newer and pnpm.

```powershell
pnpm install
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Choose **Sign up** to create an independent account with a valid email and a password of at least 12 characters. Each account has its own links, routing rules, tokens, tags, and analytics; sign-up does not join another account or share its workspace. Create a named link with an HTTP(S) destination. Optional UTM source, medium, campaign, term, and content fields show the composed destination preview as you type; you can change or clear them later in the link's **Settings**. Open **Routing** to add ordered conditions or preview a visitor. Use the short URL shown in the workspace to redirect.

On **Links**, search by name, short code, or destination, then narrow the list by tag or status. Link settings let you assign comma-separated tags, archive or restore a link, and duplicate its configuration. A duplicate gets a new short code and copies its tags and routing rules without copying click history. Archiving only hides a link from the active list; its short URL continues redirecting to the configured destination.

Self-service registration remains available after the first account is created. Only the first account adopts legacy links that have no owner; later accounts start with an empty workspace. The development API and Vite server bind to loopback. The SQLite database is created at `data/redirect-hub.sqlite`. Set `DATABASE_PATH` to choose a different database path or `PORT` to change the Hono port. Behind a reverse proxy, set `PUBLIC_BASE_URL` to the public origin and route `/api` and `/l` to Hono so generated short URLs and self-redirect checks use the same host.

Country is unknown by default. To use country rules in a deployment, set `COUNTRY_HEADER_PROVIDER=cloudflare` only behind a trusted Cloudflare proxy configured to overwrite `CF-IPCountry`. Do not accept this header from arbitrary clients. Device class is inferred from the user-agent; raw IP addresses and full user-agent strings are not stored. Click analytics exclude requests identified as bots.

Build the API and web application with:

```powershell
pnpm build
```

## Current scope

The prototype includes account setup and sign-in, link create/list/edit, generated or custom short codes, optional per-link UTM campaign values with a live destination preview, owner-scoped tags and filters, active/archive views, archive/restore, configuration duplication, ordered country/device rules, side-effect-free visitor previews, 302 redirects, basic click analytics, scoped/revocable API tokens, and a local MCP stdio server. UTM values apply after the default or matching rule destination is selected. Matching UTM keys already in that destination are replaced; other query pairs and fragments are kept. Visitor query parameters are not forwarded. Country-based routing requires the trusted proxy configuration described above.

Account invitations, recovery, token expiry and rate limits, date-filtered analytics, CSV export, disabling or scheduling links, QR downloads, and remote MCP transport remain on the roadmap. See the [ticket queue](docs/tickets/index.html) for proposed work, [product decisions](docs/product/2026-11-08-backlog-decisions.html) for direction, and [current architecture notes](docs/architecture/index.html) for implementation boundaries.

This is a development prototype: do not expose it to the public internet until deployment security, operational setup, and release checks are complete. The previous Django implementation is retained under `redirect_hub/`; the new application is in `apps/`.

## Project map

- [docs/](docs/index.html) — product decisions, research, architecture, technical guides, and tickets.
- [agent-team/](agent-team/README.md) — role-based agent workflow and prompts.
- [apps/api/](apps/api/) — Hono routes, shared routing behavior, SQLite persistence, and redirects.
- [apps/web/](apps/web/) — React and Vite workspace interface.
- [.agents/skills/](.agents/skills/) — project skills.
