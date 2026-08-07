import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 signing over canonical JSON.
 *
 * Set SIGNING_SECRET in production. The default is a development-only
 * secret so the demo runs out of the box — documented in the README.
 */
const SECRET = process.env.SIGNING_SECRET ?? "x402-queue-dev-secret-do-not-use-in-prod";

/** Deterministically serialize a JSON value (sorted object keys). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Sign a payload; returns hex HMAC-SHA256 over its canonical JSON. */
export function sign(payload: unknown): string {
  return createHmac("sha256", SECRET).update(canonicalize(payload)).digest("hex");
}

/** Verify a payload/signature pair produced by sign(). */
export function verify(payload: unknown, signature: string): boolean {
  const expected = sign(payload);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
