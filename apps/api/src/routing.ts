import type { DatabaseSync } from "node:sqlite";
import type { LinkRecord } from "./db.js";

export type VisitorContext = { countryCode: string | null; device: "mobile" | "desktop" | "unknown" };

type RouteRule = { id: string; priority: number; country_code: string | null; device: "mobile" | "desktop" | null; destination_url: string };

export function resolveDestination(database: DatabaseSync, link: LinkRecord, context: VisitorContext) {
  const rules = database.prepare("SELECT id, priority, country_code, device, destination_url FROM redirect_rules WHERE link_id = ? ORDER BY priority ASC, created_at ASC, id ASC").all(link.id) as unknown as RouteRule[];
  const trace: Array<{ ruleId: string; priority: number; matched: boolean; reasons: string[] }> = [];
  for (const rule of rules) {
    const reasons: string[] = [];
    if (rule.country_code && rule.country_code !== context.countryCode) {
      reasons.push(context.countryCode === null ? "Country condition could not be checked because visitor country is unknown." : "Country condition did not match.");
    }
    if (rule.device && rule.device !== context.device) {
      reasons.push(context.device === "unknown" ? "Device condition could not be checked because visitor device is unknown." : "Device condition did not match.");
    }
    const matched = reasons.length === 0;
    trace.push({ ruleId: rule.id, priority: rule.priority, matched, reasons: matched ? ["All conditions for this rule matched."] : reasons });
    if (matched) {
      return { destinationUrl: rule.destination_url, matchedRuleId: rule.id, matchedPriority: rule.priority, trace };
    }
  }
  return { destinationUrl: link.destination_url, matchedRuleId: null, matchedPriority: null, trace };
}
