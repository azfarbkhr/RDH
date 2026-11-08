import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type LinkItem = {
  id: string;
  slug: string;
  name: string;
  destinationUrl: string;
  shortUrl: string;
  createdAt: string;
  clickCount?: number;
  archivedAt?: string | null;
  tags?: string[];
};
type TagItem = { id: string; name: string; linkCount: number };

type Analytics = { totalClicks: number; lastSevenDays: number; countries?: Array<{ countryCode: string; clicks: number }>; devices?: Array<{ device: string; clicks: number }>; topLinks?: Array<{ id: string; name: string; slug: string; clicks: number }>; rules?: Array<{ ruleId: string; priority: number; countryCode: string | null; device: string | null; linkName: string; clicks: number }> };

type User = { id: string; email: string };
type RouteRule = { id: string; priority: number; countryCode: string | null; device: "mobile" | "desktop" | null; destinationUrl: string };
type ApiToken = { id: string; name: string; scopes: string; createdAt: string; lastUsedAt: string | null };
type WorkspaceRoute = "overview" | "links" | "create" | "analytics" | "developer" | "link";

function readRoute() {
  const [page, linkId] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (page === "link" && linkId) return { page: "link" as WorkspaceRoute, linkId };
  return { page: (["overview", "links", "create", "analytics", "developer"].includes(page) ? page : "overview") as WorkspaceRoute, linkId: null };
}

function AuthPanel({ configured, onAuthenticated }: { configured: boolean; onAuthenticated: (user: User) => void }) {
  const [registering, setRegistering] = useState(!configured);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json() as { user?: User; error?: string };
      if (!response.ok || !data.user) throw new Error(data.error ?? "Couldn't sign you in.");
      onAuthenticated(data.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  }

  return <main className="auth-shell"><a className="brand" href="/" aria-label="Redirect Hub home"><span className="brand-mark" aria-hidden="true">↗</span><span>redirect<span className="brand-accent">hub</span></span></a><section className="panel auth-panel"><div className="eyebrow">{registering ? "YOUR PRIVATE INSTANCE" : "WELCOME BACK"}</div><h1>{registering ? "Set up your account." : "Sign in to your links."}</h1><p>{registering ? "Create the owner account for this Redirect Hub instance." : "Your links are waiting for you."}</p>{error && <div className="feedback error" role="alert">{error}</div>}<form className="link-form" onSubmit={submit}><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com"/><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? 12 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={registering ? "At least 12 characters" : "Your password"}/><button className="primary-button" disabled={busy}>{busy ? "Please wait…" : registering ? "Create owner account" : "Sign in"}<span aria-hidden="true">→</span></button></form>{!registering && <p className="auth-footnote">This instance is private. Ask its owner for an account.</p>}</section></main>;
}

function RoutingEditor({ link }: { link: LinkItem }) {
  const [open, setOpen] = useState(true);
  const [rules, setRules] = useState<RouteRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesError, setRulesError] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [device, setDevice] = useState("");
  const [ruleDestination, setRuleDestination] = useState("");
  const [simCountry, setSimCountry] = useState("");
  const [simDevice, setSimDevice] = useState("unknown");
  const [simulation, setSimulation] = useState<{ destinationUrl: string; matched: boolean; matchedPriority: number | null; trace: Array<{ ruleId: string; priority: number; matched: boolean; reasons: string[] }> } | null>(null);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(async () => {
    setRulesLoading(true); setRulesError("");
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(link.id)}/rules`);
      const data = await response.json() as { rules?: RouteRule[]; error?: string };
      if (!response.ok || !Array.isArray(data.rules)) throw new Error(data.error ?? "Couldn't load routing rules.");
      setRules(data.rules);
      return true;
    } catch (cause) {
      setRulesError(cause instanceof Error ? cause.message : "Couldn't load routing rules.");
      return false;
    } finally { setRulesLoading(false); }
  }, [link.id]);

  useEffect(() => { void loadRules(); }, [loadRules]);

  async function toggle() {
    setOpen((value) => !value);
    setMessage("");
  }

  async function addRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setMessageError(false);
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(link.id)}/rules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ countryCode: countryCode.trim() || undefined, device: device || undefined, destinationUrl: ruleDestination }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Couldn't add the rule.");
      setCountryCode(""); setDevice(""); setRuleDestination("");
      const loaded = await loadRules();
      setMessage(loaded ? "Rule added. Earlier rules are checked first." : "Rule added, but the updated list could not be loaded. Retry loading rules.");
      setMessageError(!loaded);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Couldn't add the rule."); setMessageError(true); }
    finally { setBusy(false); }
  }

  async function mutateRule(ruleId: string, action: "up" | "down" | "delete") {
    setMessage(""); setMessageError(false);
    try {
      const response = action === "delete"
        ? await fetch(`/api/links/${encodeURIComponent(link.id)}/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" })
        : await fetch(`/api/links/${encodeURIComponent(link.id)}/rules/${encodeURIComponent(ruleId)}/priority`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ direction: action }) });
      const data = await response.json() as { rules?: RouteRule[]; error?: string };
      if (!response.ok || !Array.isArray(data.rules)) throw new Error(data.error ?? "Couldn't update the rule.");
      setRules(data.rules); setSimulation(null);
      setMessage(action === "delete" ? "Routing rule removed." : "Routing rule order updated.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Couldn't update the rule.");
      setMessageError(true);
    }
  }

  async function simulate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(""); setMessageError(false);
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(link.id)}/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ countryCode: simCountry.trim() || undefined, device: simDevice }) });
      const data = await response.json() as { destinationUrl: string; matched: boolean; matchedPriority: number | null; trace: Array<{ ruleId: string; priority: number; matched: boolean; reasons: string[] }>; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Couldn't simulate this visitor.");
      setSimulation(data);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Couldn't simulate this visitor."); setMessageError(true); }
  }

  return <section className="routing-editor"><button className="routing-toggle" type="button" onClick={() => void toggle()}><span>⇢</span> Routing rules <span className="rule-count">{rules.length}</span><span className="toggle-chevron">{open ? "−" : "+"}</span></button>{open && <div className="routing-content">
    <p className="routing-help">Rules run from top to bottom. A rule matches when every condition it defines is true; otherwise this link’s default destination is used.</p>
    {message && <p className={`routing-message ${messageError ? "routing-message-error" : ""}`} role={messageError ? "alert" : "status"}>{message}</p>}
    {rulesLoading ? <p className="routing-message" role="status">Loading routing rules…</p> : rulesError ? <div className="routing-load-error" role="alert"><p>{rulesError}</p><button className="copy-button" type="button" onClick={() => void loadRules()}>Retry</button></div> : rules.length > 0 ? <ol className="rule-list">{rules.map((rule, index) => <li className="rule-row" key={rule.id}><span className="rule-priority">{index + 1}</span><div className="rule-summary"><strong>{[rule.countryCode, rule.device].filter(Boolean).join(" · ")}</strong><span title={rule.destinationUrl}>{rule.destinationUrl}</span></div><div className="rule-actions"><button type="button" aria-label="Move rule up" disabled={index === 0} onClick={() => void mutateRule(rule.id, "up")}>↑</button><button type="button" aria-label="Move rule down" disabled={index === rules.length - 1} onClick={() => void mutateRule(rule.id, "down")}>↓</button><button type="button" aria-label="Delete rule" onClick={() => void mutateRule(rule.id, "delete")}>×</button></div></li>)}</ol> : <div className="rules-empty">No rules yet. Add one to send a specific audience somewhere different.</div>}
    <form className="rule-form" onSubmit={(event) => void addRule(event)}><div className="rule-form-title">Add a rule</div><div className="rule-fields"><label>Country code <input value={countryCode} onChange={(event) => setCountryCode(event.target.value.toUpperCase())} placeholder="US" maxLength={2} pattern="[A-Za-z]{2}" /></label><label>Device <select value={device} onChange={(event) => setDevice(event.target.value)}><option value="">Any device</option><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label></div><label>Send matching visitors to<input type="url" required maxLength={2048} value={ruleDestination} onChange={(event) => setRuleDestination(event.target.value)} placeholder="https://example.com/campaign" /></label><button className="copy-button" disabled={busy || rules.length >= 20}>{busy ? "Adding…" : "Add routing rule"}</button></form>
    <form className="simulator" onSubmit={(event) => void simulate(event)}><div><strong>Visitor simulator</strong><span>Preview the first matching destination without recording a click.</span></div><div className="simulator-fields"><label>Country<input value={simCountry} onChange={(event) => setSimCountry(event.target.value.toUpperCase())} placeholder="US" maxLength={2} /></label><label>Device<select value={simDevice} onChange={(event) => setSimDevice(event.target.value)}><option value="unknown">Unknown</option><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label><button className="copy-button" type="submit">Preview</button></div>{simulation && <><p className="simulation-result"><span>{simulation.matched ? `Rule ${simulation.matchedPriority} matches` : "Default destination"}</span><strong title={simulation.destinationUrl}>{simulation.destinationUrl}</strong></p>{simulation.trace.length > 0 && <ol className="resolution-trace" aria-label="Rule evaluation trace">{simulation.trace.map((step) => <li className={step.matched ? "trace-match" : "trace-miss"} key={step.ruleId}><span>{step.matched ? "✓" : "·"}</span><div><strong>Rule {step.priority}{step.matched ? " matched" : " not matched"}</strong>{step.reasons.map((reason, index) => <small key={index}>{reason}</small>)}</div></li>)}</ol>}</>}</form>
  </div>}</section>;
}

function ApiTokenPanel({ onClose, presentation = "dialog" }: { onClose: () => void; presentation?: "dialog" | "page" }) {
  const panelRef = useRef<HTMLElement | null>(null);
  const tokenLoadRequest = useRef(0);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokenLoadError, setTokenLoadError] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("read");
  const [newToken, setNewToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const requestId = ++tokenLoadRequest.current;
    setTokensLoading(true);
    setTokenLoadError("");
    try {
      const response = await fetch("/api/auth/tokens");
      const data = await response.json() as { tokens?: ApiToken[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Couldn't load API tokens.");
      if (requestId !== tokenLoadRequest.current) return;
      setTokens(data.tokens ?? []);
      setTokenLoadError("");
    } catch (cause) {
      if (requestId !== tokenLoadRequest.current) return;
      setTokenLoadError(cause instanceof Error ? cause.message : "Couldn't load API tokens.");
    } finally {
      if (requestId === tokenLoadRequest.current) setTokensLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (presentation !== "dialog") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const getFocusable = () => panel?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [];
    getFocusable()[0]?.focus();
    function keepFocusInPanel(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(getFocusable());
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", keepFocusInPanel);
    return () => {
      document.removeEventListener("keydown", keepFocusInPanel);
      previouslyFocused?.focus();
    };
  }, [onClose, presentation]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNewToken("");
    try {
      const response = await fetch("/api/auth/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, scopes }) });
      const data = await response.json() as { token?: { id: string; name: string; scopes: string; value: string }; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error ?? "Couldn't create the token.");
      setNewToken(data.token.value); setName(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't create the token."); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setError("");
    try {
      const response = await fetch(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Couldn't revoke the token.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't revoke the token."); }
  }

  const content = <section ref={panelRef} className={`panel token-panel ${presentation === "page" ? "token-panel-page" : ""}`} role={presentation === "dialog" ? "dialog" : undefined} aria-modal={presentation === "dialog" ? true : undefined} aria-labelledby="token-heading" aria-describedby="token-description"><div className="token-panel-head"><div><div className="eyebrow">DEVELOPER ACCESS</div><h2 id="token-heading">API tokens</h2></div>{presentation === "dialog" && <button className="feedback-close" onClick={onClose} aria-label="Close API tokens">×</button>}</div><p className="token-intro" id="token-description">Tokens let trusted tools connect to this instance. Read-only access can inspect links and analytics; read/write can also change them.</p>{error && <p className="token-error" role="alert">{error}</p>}{newToken && <div className="token-secret"><strong>Copy this token now. It won’t be shown again.</strong><code>{newToken}</code><button className="copy-button" onClick={() => void navigator.clipboard.writeText(newToken)}>Copy token</button></div>}<form className="token-create" onSubmit={(event) => void create(event)}><label>Token name<input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="MCP on this computer" /></label><label>Access<select value={scopes} onChange={(event) => setScopes(event.target.value)}><option value="read">Read only</option><option value="read,write">Read and write</option></select></label><button className="primary-button" disabled={busy || tokensLoading || Boolean(tokenLoadError) || tokens.length >= 10}>{busy ? "Creating…" : "Create API token"}</button></form><div className="token-list-heading">ACTIVE TOKENS <span>{tokensLoading || tokenLoadError ? "—" : `${tokens.length}/10`}</span></div>{tokensLoading ? <p className="token-empty" role="status">Loading API tokens…</p> : tokenLoadError ? <div className="token-load-error" role="alert"><p className="token-error">{tokenLoadError}</p><button className="copy-button" type="button" onClick={() => void load()}>Retry</button></div> : tokens.length ? <ul className="token-list">{tokens.map((token) => <li key={token.id}><span><strong>{token.name}</strong><small>{token.scopes === "read" ? "Read only" : "Read and write"} · created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(token.createdAt))}</small></span><button className="copy-button" onClick={() => void revoke(token.id)}>Revoke</button></li>)}</ul> : <p className="token-empty">No active API tokens.</p>}</section>;
  return presentation === "dialog" ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{content}</div> : <div className="token-page-wrap">{content}</div>;
}

function App() {
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [analytics, setAnalytics] = useState<Analytics>({ totalClicks: 0, lastSevenDays: 0 });
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [name, setName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDestination, setEditDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [route, setRoute] = useState(() => readRoute());
  const [detailSection, setDetailSection] = useState<"overview" | "routing" | "analytics" | "settings">("overview");
  const [search, setSearch] = useState("");
  const [archiveView, setArchiveView] = useState<"active" | "archived" | "all">("active");
  const [selectedTag, setSelectedTag] = useState("");
  const [tags, setTags] = useState<TagItem[]>([]);
  const [editTags, setEditTags] = useState("");

  function navigate(page: WorkspaceRoute, linkId?: string) {
    const hash = page === "link" && linkId ? `#/link/${encodeURIComponent(linkId)}` : `#/${page}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute({ page, linkId: linkId ?? null });
    setError(""); setNotice("");
    if (page === "link") setDetailSection("overview");
  }

  useEffect(() => {
    const updateRoute = () => setRoute(readRoute());
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  const refresh = useCallback(async (overrides: { archive?: "active" | "archived" | "all" } = {}) => {
    try {
      const params = new URLSearchParams({ archive: overrides.archive ?? archiveView });
      if (search.trim()) params.set("search", search.trim());
      if (selectedTag) params.set("tag", selectedTag);
      const [response, analyticsResponse, tagsResponse] = await Promise.all([fetch(`/api/links?${params}`), fetch("/api/analytics"), fetch("/api/tags")]);
      if (!response.ok || !analyticsResponse.ok || !tagsResponse.ok) throw new Error("Could not load your links.");
      const [data, analyticsData, tagsData] = await Promise.all([response.json(), analyticsResponse.json(), tagsResponse.json()]) as [{ links: LinkItem[] }, Analytics, { tags: TagItem[] }];
      setLinks(data.links);
      setAnalytics(analyticsData);
      setTags(tagsData.tags);
      setError("");
    } catch {
      setError("Couldn't connect to Redirect Hub. Check that the API server is running, then try again.");
    } finally {
      setLoading(false);
    }
  }, [archiveView, search, selectedTag]);

  useEffect(() => {
    void fetch("/api/auth/session").then((response) => response.json()).then((data: { user: User | null; configured: boolean }) => {
      setUser(data.user); setConfigured(data.configured);
    }).catch(() => setError("Couldn't connect to Redirect Hub. Check that the API server is running, then try again."))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (user) void refresh();
    else if (authChecked) { setLinks([]); setLoading(false); }
  }, [user, authChecked, refresh]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null); setNotice(""); setError("");
  }

  if (!authChecked) return <main className="auth-shell"><span className="brand"><span className="brand-mark" aria-hidden="true">↗</span> redirect<span className="brand-accent">hub</span></span><p role="status">Connecting to your workspace…</p></main>;
  if (!user) return <AuthPanel configured={configured} onAuthenticated={(nextUser) => { setUser(nextUser); setConfigured(true); }} />;

  async function createLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, destinationUrl, ...(slug.trim() ? { slug: slug.trim() } : {}) }),
      });
      const data = await response.json() as { link?: LinkItem; error?: string };
      if (!response.ok || !data.link) throw new Error(data.error ?? "Couldn't create this link.");
      setName("");
      setDestinationUrl("");
      setSlug("");
      await refresh();
      navigate("link", data.link.id);
      setNotice("Your link is ready to share.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink(shortUrl: string) {
    try {
      await navigator.clipboard.writeText(shortUrl);
      setNotice("Short link copied to clipboard.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the link instead.");
    }
  }

  async function manageLink(linkId: string, action: "archive" | "unarchive" | "duplicate") {
    setError(""); setNotice("");
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(linkId)}/${action}`, { method: "POST" });
      const data = await response.json() as { link?: LinkItem; error?: string };
      if (!response.ok || !data.link) throw new Error(data.error ?? `Couldn't ${action} this link.`);
      const nextView = action === "archive" ? "archived" : "active";
      setArchiveView(nextView);
      await refresh({ archive: nextView });
      if (action === "duplicate") { navigate("link", data.link.id); setNotice("Link duplicated with a new short URL."); }
      else { navigate("links"); setNotice(action === "archive" ? "Link archived. Its short URL still redirects." : "Link restored to active links."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Couldn't ${action} this link.`); }
  }

  async function saveTags(linkId: string) {
    setError(""); setNotice("");
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(linkId)}/tags`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: editTags.split(",").map((tag) => tag.trim()).filter(Boolean) }) });
      const data = await response.json() as { link?: LinkItem; error?: string };
      if (!response.ok || !data.link) throw new Error(data.error ?? "Couldn't save tags.");
      setNotice("Tags saved."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't save tags."); }
  }

  async function saveLink(event: React.FormEvent<HTMLFormElement>, linkId: string) {
    event.preventDefault(); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(linkId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, destinationUrl: editDestination }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Couldn't update this link.");
      setEditing(null); setNotice("Link updated. Your short URL hasn't changed."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't update this link."); }
  }

  const activeLink = links.find((link) => link.id === route.linkId) ?? null;
  const visibleLinks = links;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <a className="brand" href="#/overview" aria-label="Redirect Hub home"><span className="brand-mark" aria-hidden="true">↗</span><span>redirect<span className="brand-accent">hub</span></span></a>
        <nav className="workspace-nav" aria-label="Workspace sections"><a href="#/overview" aria-current={route.page === "overview" ? "page" : undefined}>Overview</a><a href="#/links" aria-current={route.page === "links" || route.page === "link" ? "page" : undefined}>Links <span className="count-pill">{links.length}</span></a><a href="#/analytics" aria-current={route.page === "analytics" ? "page" : undefined}>Analytics</a><a href="#/developer" aria-current={route.page === "developer" ? "page" : undefined}>Developer</a></nav>
        <div className="topbar-actions"><span className="account-email">{user.email}</span><button className="signout-button" onClick={() => void signOut()}>Sign out</button></div>
      </header>

      <main className="main-content" id="main-content">
        {route.page === "overview" && <>
          <section className="page-intro"><div><div className="eyebrow"><span className="status-dot" /> YOUR WORKSPACE</div><h1>Good links, clearly managed.</h1><p className="intro-copy">A calm home for your short links and where they take people.</p></div><button className="primary-button" onClick={() => navigate("create")}>Create a link <span aria-hidden="true">→</span></button></section>
          <section className="overview-metrics"><article><span>LINKS</span><strong>{loading ? "—" : links.length}</strong><small>In this workspace</small></article><article><span>ALL-TIME CLICKS</span><strong>{analytics.totalClicks.toLocaleString()}</strong><small>Bot traffic excluded</small></article><article><span>LAST 7 DAYS</span><strong>{analytics.lastSevenDays.toLocaleString()}</strong><small>Privacy-aware analytics</small></article></section>
          <section className="content-section"><div className="section-heading"><div><div className="eyebrow">RECENTLY CREATED</div><h2>Recent links</h2></div><button className="text-action" onClick={() => navigate("links")}>View all links →</button></div>{loading ? <div className="empty-state"><p>Loading your links…</p></div> : links.length === 0 ? <div className="empty-state"><span className="empty-icon">↗</span><h3>Your first link starts here</h3><p>Create a short link and it’ll be ready to share.</p><button className="primary-button" onClick={() => navigate("create")}>Create your first link</button></div> : <div className="link-list">{links.slice(0, 5).map((link) => <article className="link-card" key={link.id}><div className="link-card-top"><div className="link-description"><button className="link-name-button" onClick={() => navigate("link", link.id)}>{link.name}</button><time dateTime={link.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(link.createdAt))}</time></div><button className="copy-button" onClick={() => void copyLink(link.shortUrl)}>Copy</button></div><a className="short-link" href={link.shortUrl}>{link.shortUrl}</a></article>)}</div>}</section>
        </>}

        {route.page === "analytics" && <section id="analytics" className="analytics-section" aria-labelledby="analytics-heading">
          <div className="section-heading analytics-heading"><div><div className="eyebrow">PERFORMANCE</div><h2 id="analytics-heading">Traffic at a glance</h2></div><span className="analytics-note">Privacy-aware · bot traffic excluded</span></div>
          <section className="stats-strip" aria-label="Click analytics"><div><span>TOTAL CLICKS</span><strong>{analytics.totalClicks.toLocaleString()}</strong></div><div><span>LAST 7 DAYS</span><strong>{analytics.lastSevenDays.toLocaleString()}</strong></div><p>No raw IP addresses are stored.</p></section>
          {analytics.totalClicks === 0 && <div className="empty-state analytics-empty"><span className="empty-icon" aria-hidden="true">▥</span><h3>No traffic to report yet</h3><p>Share a short link to start seeing real visits here.</p></div>}
          {((analytics.countries?.length ?? 0) > 0 || (analytics.rules?.length ?? 0) > 0) && <div className="insight-grid" aria-label="Traffic breakdown">{(analytics.countries?.length ?? 0) > 0 && <article className="insight-panel"><div className="insight-title">TOP COUNTRIES</div>{analytics.countries?.slice(0, 5).map((item) => <div className="insight-row" key={item.countryCode}><span>{item.countryCode}</span><strong>{item.clicks.toLocaleString()}</strong></div>)}</article>}{(analytics.rules?.length ?? 0) > 0 && <article className="insight-panel"><div className="insight-title">ROUTING RULE MATCHES</div>{analytics.rules?.slice(0, 5).map((item) => <div className="insight-row" key={item.ruleId}><span>{item.linkName} · {[item.countryCode, item.device].filter(Boolean).join(" / ")}</span><strong>{item.clicks.toLocaleString()}</strong></div>)}</article>}</div>}
        </section>}

        {error && <div className="feedback error" role="alert"><span aria-hidden="true">!</span><span>{error}</span><button className="feedback-close" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        {notice && <div className="feedback success" role="status"><span aria-hidden="true">✓</span><span>{notice}</span><button className="feedback-close" onClick={() => setNotice("")} aria-label="Dismiss message">×</button></div>}

        <div className="workspace-grid">
          {route.page === "create" && <section id="create-link" className="panel create-panel" aria-labelledby="create-heading">
            <div className="panel-heading"><span className="heading-icon" aria-hidden="true">＋</span><div><h2 id="create-heading">Create a link</h2><p>Give a destination a short, memorable address.</p></div></div>
            <form onSubmit={createLink} className="link-form">
              <label htmlFor="link-name">Link name <span className="required">*</span></label>
              <input id="link-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product launch" maxLength={80} required />
              <label htmlFor="destination">Destination URL <span className="required">*</span></label>
              <input id="destination" type="url" value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} placeholder="https://example.com/your-page" maxLength={2048} required />
              <label htmlFor="custom-slug">Short code <span className="optional">OPTIONAL</span></label>
              <div className="slug-input"><span className="slug-prefix">/l/</span><input id="custom-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="auto-generated" maxLength={48} pattern="[a-zA-Z0-9_-]{3,48}" title="Use 3–48 letters, numbers, hyphens, or underscores." /><span className="slug-hint" aria-hidden="true">↗</span></div>
              <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Creating link…" : "Create short link"}<span aria-hidden="true">→</span></button>
              <p className="form-footnote"><span aria-hidden="true">◉</span> Your destination stays editable after sharing.</p>
            </form>
          </section>}

          {route.page === "links" && <section id="links" className="links-section" aria-labelledby="links-heading">
            <div className="page-intro"><div><div className="eyebrow">LINK LIBRARY</div><h1 id="links-heading">Your links <span className="count-pill">{loading ? "…" : links.length}</span></h1><p className="intro-copy">Find, copy, and manage every destination in your collection.</p></div><button className="primary-button" onClick={() => navigate("create")}>Create link →</button></div>
            <div className="link-tools"><label className="search-field"><span aria-hidden="true">⌕</span><span className="visually-hidden">Search links</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search links by name, code, or destination" /></label><button className="refresh-button" onClick={() => void refresh()} aria-label="Refresh links">↻</button></div>
            <div className="link-filters" aria-label="Filter links"><div className="archive-tabs" role="group" aria-label="Link status">{(["active", "archived", "all"] as const).map((view) => <button key={view} type="button" aria-pressed={archiveView === view} onClick={() => setArchiveView(view)}>{view === "active" ? "Active" : view === "archived" ? "Archived" : "All links"}</button>)}</div><label className="tag-filter">Tag<select value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name} ({tag.linkCount})</option>)}</select></label></div>
            {loading ? <div className="empty-state"><span className="empty-icon" aria-hidden="true">◌</span><p>Loading your links…</p></div> : visibleLinks.length === 0 ? <div className="empty-state"><span className="empty-icon" aria-hidden="true">↗</span><h3>{search || selectedTag ? "No matching links" : archiveView === "archived" ? "No archived links" : archiveView === "active" ? "No active links yet" : "No links yet"}</h3><p>{search || selectedTag ? "Try a different search or tag." : archiveView === "archived" ? "Archived links stay available here and keep redirecting." : "Create a short link and it’ll be ready to share."}</p>{archiveView !== "archived" && !search && !selectedTag && <button className="primary-button" onClick={() => navigate("create")}>Create a link</button>}</div> : <div className="link-list">{visibleLinks.map((link) => <article className="link-card" key={link.id}><div className="link-card-top"><div className="link-description"><button className="link-name-button" onClick={() => navigate("link", link.id)}>{link.name}</button><time dateTime={link.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(link.createdAt))}{link.archivedAt ? " · Archived" : ""}</time></div><span className="link-clicks">{typeof link.clickCount === "number" ? `${link.clickCount} clicks` : "— clicks"}</span><button className="copy-button" onClick={() => void copyLink(link.shortUrl)}>Copy</button><button className="copy-button" onClick={() => navigate("link", link.id)}>Details</button></div><a className="short-link" href={link.shortUrl}>{link.shortUrl}</a><div className="destination"><span>GOES TO</span><a href={link.destinationUrl} target="_blank" rel="noreferrer" title={link.destinationUrl}>{link.destinationUrl}<span aria-hidden="true"> ↗</span></a></div><div className="link-card-bottom">{(link.tags ?? []).length ? <div className="tag-chips">{link.tags!.map((tag) => <span key={tag}>{tag}</span>)}</div> : <span className="no-tags">No tags</span>}<div className="link-actions"><button className="copy-button" onClick={() => void manageLink(link.id, "duplicate")}>Duplicate</button><button className="copy-button" onClick={() => void manageLink(link.id, link.archivedAt ? "unarchive" : "archive")}>{link.archivedAt ? "Restore" : "Archive"}</button></div></div></article>)}</div>}
          </section>}
        </div>
        {route.page === "link" && (activeLink ? <section className="link-detail-page">
          <button className="back-link" onClick={() => navigate("links")}>← Back to links</button>
          <div className="page-intro detail-intro"><div><div className="eyebrow">LINK DETAILS · /l/{activeLink.slug}</div><h1>{activeLink.name}</h1><p className="intro-copy">{activeLink.destinationUrl}</p></div><button className="copy-button" onClick={() => void copyLink(activeLink.shortUrl)}>Copy short link</button></div>
          <nav className="detail-tabs" aria-label="Link sections">{(["overview", "routing", "analytics", "settings"] as const).map((section) => <button key={section} aria-current={detailSection === section ? "page" : undefined} onClick={() => { setDetailSection(section); setEditName(activeLink.name); setEditDestination(activeLink.destinationUrl); setEditTags((activeLink.tags ?? []).join(", ")); }}>{section[0].toUpperCase() + section.slice(1)}</button>)}</nav>
          {detailSection === "overview" && <section className="detail-grid"><article className="panel detail-card"><span className="eyebrow">SHORT LINK</span><a className="detail-short-url" href={activeLink.shortUrl}>{activeLink.shortUrl}</a><button className="copy-button" onClick={() => void copyLink(activeLink.shortUrl)}>Copy URL</button></article><article className="panel detail-card"><span className="eyebrow">DESTINATION</span><a className="detail-destination" href={activeLink.destinationUrl} target="_blank" rel="noreferrer">{activeLink.destinationUrl} ↗</a><small>Created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(activeLink.createdAt))}</small></article><article className="panel detail-card"><span className="eyebrow">LINK ACTIVITY</span><strong className="detail-metric">{typeof activeLink.clickCount === "number" ? activeLink.clickCount.toLocaleString() : "—"}</strong><small>{typeof activeLink.clickCount === "number" ? "Recorded clicks" : "Open workspace analytics for activity"}</small></article></section>}
          {detailSection === "routing" && <section className="panel detail-wide"><div className="section-heading"><div><div className="eyebrow">DESTINATION RULES</div><h2>Routing</h2><p>Send different visitors to a destination that fits them.</p></div></div><RoutingEditor key={activeLink.id} link={activeLink}/></section>}
          {detailSection === "analytics" && <section className="panel detail-wide"><div className="eyebrow">LINK PERFORMANCE</div><h2>Analytics for {activeLink.name}</h2><div className="empty-state"><p>Per-link analytics are not available yet. Workspace-wide traffic is available on Analytics.</p><button className="text-action" onClick={() => navigate("analytics")}>Open workspace analytics →</button></div></section>}
          {detailSection === "settings" && <section className="panel detail-wide"><div className="eyebrow">LINK SETTINGS</div><h2>Update this link</h2><p>The short URL stays the same when you change its name or destination.</p><form className="link-form settings-form" onSubmit={(event) => void saveLink(event, activeLink.id)}><label htmlFor={`edit-name-${activeLink.id}`}>Link name</label><input id={`edit-name-${activeLink.id}`} value={editName} onChange={(event) => setEditName(event.target.value)} required maxLength={80}/><label htmlFor={`edit-destination-${activeLink.id}`}>Destination URL</label><input id={`edit-destination-${activeLink.id}`} type="url" value={editDestination} onChange={(event) => setEditDestination(event.target.value)} required maxLength={2048}/><div className="form-actions"><button className="primary-button" type="submit">Save changes</button><button className="copy-button" type="button" onClick={() => setDetailSection("overview")}>Cancel</button></div></form><form className="link-form settings-form tag-editor" onSubmit={(event) => { event.preventDefault(); void saveTags(activeLink.id); }}><label htmlFor={`edit-tags-${activeLink.id}`}>Tags <span className="optional">COMMA SEPARATED</span></label><input id={`edit-tags-${activeLink.id}`} value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="Launch, Social, Q4"/><button className="copy-button" type="submit">Save tags</button></form><div className="archive-control"><div><strong>{activeLink.archivedAt ? "This link is archived" : "Archive this link"}</strong><p>{activeLink.archivedAt ? "It remains reachable and continues redirecting visitors." : "The short URL will keep redirecting after you archive it."}</p></div><button className="copy-button" onClick={() => void manageLink(activeLink.id, activeLink.archivedAt ? "unarchive" : "archive")}>{activeLink.archivedAt ? "Restore link" : "Archive link"}</button></div><div className="form-actions duplicate-control"><button className="copy-button" onClick={() => void manageLink(activeLink.id, "duplicate")}>Duplicate link</button></div></section>}
        </section> : <div className="empty-state"><h1>Link not found</h1><p>This link may have been removed or belongs to another workspace.</p><button className="primary-button" onClick={() => navigate("links")}>Back to links</button></div>)}
        {route.page === "developer" && <section className="developer-page"><div className="page-intro"><div><div className="eyebrow">BUILD WITH REDIRECT HUB</div><h1>Developer access</h1><p className="intro-copy">Manage credentials for your API tools and local MCP setup.</p></div></div><ApiTokenPanel presentation="page" onClose={() => undefined}/></section>}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
