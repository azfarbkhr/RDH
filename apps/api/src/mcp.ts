import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const serverVersion = "0.1.0";
const apiBaseUrl = (process.env.REDIRECT_HUB_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const allowWrites = process.env.REDIRECT_HUB_MCP_ALLOW_WRITES === "1";
const server = new McpServer({ name: "redirect-hub", version: serverVersion });

const apiUrl = new URL(apiBaseUrl);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && localHosts.has(apiUrl.hostname))) {
  throw new Error("REDIRECT_HUB_API_URL must use HTTPS unless it points to a loopback address.");
}
if (apiUrl.username || apiUrl.password) throw new Error("Do not embed credentials in REDIRECT_HUB_API_URL; use REDIRECT_HUB_API_TOKEN.");

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.REDIRECT_HUB_API_TOKEN;
  if (!token) throw new Error("Set REDIRECT_HUB_API_TOKEN in this MCP host configuration.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `Redirect Hub API returned HTTP ${response.status}.`);
  return payload as T;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type LinkItem = { id: string; slug: string; name: string; shortUrl: string; destinationUrl: string; createdAt: string };

async function findLink(slug: string) {
  const { links } = await api<{ links: LinkItem[] }>("/api/links");
  const link = links.find((item) => item.slug === slug);
  if (!link) throw new Error("Link not found.");
  return link;
}

function registerReadTools() {
  server.registerTool("list_links", {
    description: "List links accessible to this API token. Optionally filter by a name or short code substring.",
    inputSchema: z.object({ search: z.string().trim().max(100).optional() }),
    annotations: { title: "List links", readOnlyHint: true, openWorldHint: false },
  }, async ({ search }) => {
    const { links } = await api<{ links: LinkItem[] }>("/api/links");
    const query = search?.toLocaleLowerCase();
    return result({ links: query ? links.filter((link) => `${link.name} ${link.slug}`.toLocaleLowerCase().includes(query)) : links });
  });

  server.registerTool("get_link", {
    description: "Get a link and its current destination by short code.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48) }),
    annotations: { title: "Get link", readOnlyHint: true, openWorldHint: false },
  }, async ({ slug }) => result({ link: await findLink(slug) }));

  server.registerTool("list_routing_rules", {
    description: "List the ordered country and device rules attached to a short link.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48) }),
    annotations: { title: "List routing rules", readOnlyHint: true, openWorldHint: false },
  }, async ({ slug }) => {
    const link = await findLink(slug);
    const { rules, maxRules } = await api<{ rules: unknown[]; maxRules: number }>(`/api/links/${encodeURIComponent(link.id)}/rules`);
    return result({ link, rules, maxRules });
  });

  server.registerTool("simulate_redirect", {
    description: "Preview which saved routing rule matches a visitor. The simulation does not redirect or record an analytics event.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48), countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(), device: z.enum(["mobile", "desktop", "unknown"]).optional() }),
    annotations: { title: "Simulate redirect", readOnlyHint: true, openWorldHint: false },
  }, async ({ slug, countryCode, device }) => {
    const link = await findLink(slug);
    return result(await api(`/api/links/${encodeURIComponent(link.id)}/simulate`, { method: "POST", body: JSON.stringify({ countryCode, device }) }));
  });

  server.registerTool("get_analytics", {
    description: "Get bot-filtered click totals, device/country/rule breakdowns, and top links available to this API token.",
    inputSchema: z.object({}),
    annotations: { title: "Get analytics", readOnlyHint: true, openWorldHint: false },
  }, async () => result(await api("/api/analytics")));
}

function registerWriteTools() {
  server.registerTool("create_link", {
    description: "Create a short link. Requires a write-scoped API token and REDIRECT_HUB_MCP_ALLOW_WRITES=1.",
    inputSchema: z.object({ name: z.string().trim().min(1).max(80), destinationUrl: z.url().max(2048), slug: z.string().trim().min(3).max(48).regex(/^[a-zA-Z0-9_-]+$/).optional() }),
    annotations: { title: "Create link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => result(await api("/api/links", { method: "POST", body: JSON.stringify(input) })));

  server.registerTool("update_link", {
    description: "Update the name and/or default destination of a link without changing its short code.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48), name: z.string().trim().min(1).max(80).optional(), destinationUrl: z.url().max(2048).optional() }),
    annotations: { title: "Update link", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ slug, ...input }) => {
    const link = await findLink(slug);
    return result(await api(`/api/links/${encodeURIComponent(link.id)}`, { method: "PATCH", body: JSON.stringify(input) }));
  });

  server.registerTool("create_routing_rule", {
    description: "Add a country and/or device routing rule to a short link. Rules run in priority order.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48), countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(), device: z.enum(["mobile", "desktop"]).optional(), destinationUrl: z.url().max(2048) }),
    annotations: { title: "Create routing rule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ slug, ...input }) => {
    const link = await findLink(slug);
    return result(await api(`/api/links/${encodeURIComponent(link.id)}/rules`, { method: "POST", body: JSON.stringify(input) }));
  });

  server.registerTool("delete_routing_rule", {
    description: "Remove a routing rule from a short link. This operation cannot be undone.",
    inputSchema: z.object({ slug: z.string().trim().min(3).max(48), ruleId: z.string().uuid() }),
    annotations: { title: "Delete routing rule", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ slug, ruleId }) => {
    const link = await findLink(slug);
    return result(await api(`/api/links/${encodeURIComponent(link.id)}/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }));
  });
}

registerReadTools();
if (allowWrites) registerWriteTools();

console.error(`Redirect Hub MCP stdio server ${serverVersion} ready; ${allowWrites ? "write tools enabled" : "read-only tools only"}.`);
await serveStdio(() => server);
