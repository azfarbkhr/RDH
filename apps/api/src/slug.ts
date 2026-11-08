import { randomBytes } from "node:crypto";

const MAX_GENERATED_SLUG_ATTEMPTS = 5;

function isSlugUniqueConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:\s*links\.slug\b/.test(error.message);
}

export class GeneratedSlugUnavailableError extends Error {
  constructor() {
    super("Couldn't generate a unique short code. Try again or choose one manually.");
    this.name = "GeneratedSlugUnavailableError";
  }
}

export function insertWithGeneratedSlug<T>(
  insert: (slug: string) => T,
  generate: () => string = () => randomBytes(5).toString("base64url"),
  maxAttempts = MAX_GENERATED_SLUG_ATTEMPTS,
): { slug: string; value: T } {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const slug = generate();
    try {
      return { slug, value: insert(slug) };
    } catch (error) {
      if (!isSlugUniqueConflict(error)) throw error;
    }
  }
  throw new GeneratedSlugUnavailableError();
}

export function isSlugUniqueConflictError(error: unknown): boolean {
  return isSlugUniqueConflict(error);
}
