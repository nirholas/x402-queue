/**
 * Signed queue-position tokens.
 *
 * A token is `base64url(canonical JSON payload) + "." + hex HMAC`. It is
 * self-contained: it proves *when* you joined and *what* you were promised, so
 * a dispute about your place in line has an answer that neither side can edit
 * after the fact. The live position itself is not in the token — that changes
 * by the minute and is served by the free `GET /position/:token`.
 */

import { canonicalize, sign, verify } from "./sign.js";
import type { TicketPayload } from "./types.js";

/** Encode a payload + signature into a compact, URL-safe token. */
export function encodeToken(payload: TicketPayload): string {
  const body = Buffer.from(canonicalize(payload), "utf8").toString("base64url");
  return `${body}.${sign(payload)}`;
}

export interface DecodedToken {
  valid: boolean;
  reason?: string;
  payload?: TicketPayload;
}

/** Decode and authenticate a token. Never throws. */
export function decodeToken(token: string): DecodedToken {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return { valid: false, reason: "malformed token" };
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
  } catch {
    return { valid: false, reason: "payload is not valid JSON" };
  }
  if (!/^[0-9a-f]+$/i.test(signature) || !verify(payload, signature)) {
    return { valid: false, reason: "signature does not match — token was altered or forged" };
  }
  return { valid: true, payload };
}
