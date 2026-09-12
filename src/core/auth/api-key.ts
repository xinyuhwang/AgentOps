import { createHash, randomBytes } from "node:crypto";

/**
 * Keys are hashed at rest (§7.5). The plaintext is shown once at creation and
 * never stored, so a database dump does not hand over the ability to spend
 * money through `POST /api/workflows/:id/run`.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
} {
  const plaintext = `ao_${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    // Stored so the UI can show "ao_a1b2…" next to a key it cannot reveal.
    prefix: plaintext.slice(0, 11),
  };
}
