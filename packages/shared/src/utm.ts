export const UTM_FIELDS = ["source", "medium", "campaign", "term", "content"] as const;

export type UtmField = (typeof UTM_FIELDS)[number];
export type UtmConfiguration = Partial<Record<UtmField, string | null | undefined>>;

const canonicalKeys = new Set(UTM_FIELDS.map((field) => `utm_${field}`));

/**
 * Compose a selected destination with a link's configured UTM values.
 * Existing occurrences of standard UTM keys (including case variants) are
 * removed before configured values are appended. Other query pairs and the
 * fragment are preserved by the URL implementation.
 */
export function composeDestinationUrl(destinationUrl: string, utm: UtmConfiguration = {}): string {
  const url = new URL(destinationUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("UTM destinations must use HTTP or HTTPS.");
  for (const key of [...url.searchParams.keys()]) {
    if (canonicalKeys.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  for (const field of UTM_FIELDS) {
    const value = utm[field];
    if (typeof value === "string" && value.length > 0) url.searchParams.append(`utm_${field}`, value);
  }
  return url.toString();
}
