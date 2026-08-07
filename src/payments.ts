/**
 * Dual-rail x402 paywall — USDC on Base (EVM) **and** Solana (SVM).
 *
 * A 402 challenge from this middleware advertises BOTH rails in `accepts`;
 * the client picks whichever it can pay with. Verification and settlement are
 * delegated to an x402 facilitator — one per rail, because no public facilitator
 * settles both chains: x402.org for Base (EIP-3009 `transferWithAuthorization`)
 * and PayAI for Solana (SPL `transferChecked`).
 *
 * `x402-express`'s own middleware cannot do this: it takes a single `payTo` and
 * therefore a single rail. Hence this hand-rolled version, built on x402 core's
 * `processPriceToAtomicAmount` (which already knows the USDC address/mint per
 * network) and `useFacilitator`.
 *
 * Flow:
 *   1. No `X-PAYMENT` header  -> 402 + { x402Version, error, accepts: [evm, svm] }
 *   2. `X-PAYMENT` present    -> decode, match the rail it targets, verify
 *   3. verified               -> run the route handler
 *   4. handler returns 2xx    -> settle, attach `X-PAYMENT-RESPONSE`, send body
 *      handler returns 4xx/5xx-> never settle (the payer is not charged)
 *
 * Settling only on success is what makes the "artifact in the 200 body"
 * contract safe: a failed booking never moves money. If settlement itself
 * fails after the handler already committed state, the route's registered
 * `res.locals.x402Rollback` is invoked so nothing is left half-done.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { processPriceToAtomicAmount } from "x402/shared";
import {
  settleResponseHeader,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
} from "x402/types";
import { useFacilitator } from "x402/verify";

/** Suite default receive addresses. Override with env to get paid yourself. */
export const DEFAULT_EVM_PAY_TO = "0x40252CFDF8B20Ed757D61ff157719F33Ec332402";
export const DEFAULT_SOLANA_PAY_TO = "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW";

export const EVM_PAY_TO = process.env.PAY_TO_ADDRESS || DEFAULT_EVM_PAY_TO;
export const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO_ADDRESS || DEFAULT_SOLANA_PAY_TO;
export const USING_DEFAULT_PAY_TO =
  EVM_PAY_TO === DEFAULT_EVM_PAY_TO && SOLANA_PAY_TO === DEFAULT_SOLANA_PAY_TO;

/** EVM network: `base-sepolia` (default, testnet) or `base` (mainnet). */
export const EVM_NETWORK = (process.env.NETWORK || "base-sepolia") as Network;
/** SVM network: `mainnet-beta` -> `solana`, `devnet` -> `solana-devnet`. */
export const SOLANA_NETWORK = (
  process.env.SOLANA_NETWORK === "devnet" ? "solana-devnet" : "solana"
) as Network;

/**
 * Facilitators are per-rail: no single public facilitator settles both chains.
 * x402.org's only handles base-sepolia; PayAI's handles Solana. Override either
 * with FACILITATOR_URL / SOLANA_FACILITATOR_URL (e.g. a CDP facilitator on Base
 * mainnet).
 */
export const FACILITATOR_URL = (process.env.FACILITATOR_URL ||
  "https://x402.org/facilitator") as `${string}://${string}`;
export const SOLANA_FACILITATOR_URL = (process.env.SOLANA_FACILITATOR_URL ||
  "https://facilitator.payai.network") as `${string}://${string}`;

/** Advertised to Solana clients so they can build the transfer transaction. */
export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (SOLANA_NETWORK === "solana-devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com");

const evmFacilitator = useFacilitator({ url: FACILITATOR_URL });
const svmFacilitator = useFacilitator({ url: SOLANA_FACILITATOR_URL });

/** Route verify/settle to the facilitator that speaks the payment's chain. */
function facilitatorFor(network: string) {
  return String(network).startsWith("solana") ? svmFacilitator : evmFacilitator;
}

/** One paid route: its price and what the buyer gets back. */
export interface PaidRoute {
  /** Human price string, e.g. "$0.01". Converted to USDC base units (6dp). */
  price: string;
  /** Shown in the 402 challenge and in discovery listings. */
  description: string;
  /** Optional JSON schema of the 200 body, surfaced to agents. */
  outputSchema?: Record<string, unknown>;
}

/** Route map keyed by `"<METHOD> <path>"`; `:params` are supported. */
export type RouteMap = Record<string, PaidRoute>;

export interface PaywallOptions {
  /** Absolute base URL used to build the `resource` field of a challenge. */
  baseUrl?: string;
  /** Seconds a client has to produce a payment for a challenge. */
  maxTimeoutSeconds?: number;
}

/** Settlement details handed to the route handler via `res.locals.x402`. */
export interface PaymentContext {
  rail: "evm" | "solana";
  network: Network;
  payer?: string;
  amount: string;
  asset: string;
}

interface CompiledRoute {
  method: string;
  regex: RegExp;
  route: PaidRoute;
}

function compile(key: string): Omit<CompiledRoute, "route"> {
  const [rawMethod, rawPath = "/"] = key.trim().split(/\s+/);
  const pattern = rawPath
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { method: rawMethod.toUpperCase(), regex: new RegExp(`^${pattern}/?$`) };
}

/** Build the `accepts` array for one route — one entry per available rail. */
export function buildAccepts(
  route: PaidRoute,
  resource: string,
  opts: PaywallOptions = {},
): PaymentRequirements[] {
  const rails: Array<{ network: Network; payTo: string; svm: boolean }> = [
    { network: EVM_NETWORK, payTo: EVM_PAY_TO, svm: false },
    { network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO, svm: true },
  ];

  const accepts: PaymentRequirements[] = [];
  for (const rail of rails) {
    // A rail whose price/asset cannot be resolved (unknown network, missing
    // address) is omitted rather than crashing the server.
    if (!rail.payTo) {
      console.warn(`[x402] skipping ${rail.network} rail — no payTo address configured`);
      continue;
    }
    const priced = processPriceToAtomicAmount(route.price, rail.network);
    if ("error" in priced) {
      console.warn(`[x402] skipping ${rail.network} rail — ${priced.error}`);
      continue;
    }
    accepts.push({
      scheme: "exact",
      network: rail.network,
      maxAmountRequired: priced.maxAmountRequired,
      resource: resource as `${string}://${string}`,
      description: route.description,
      mimeType: "application/json",
      payTo: rail.payTo,
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 300,
      asset: String(priced.asset.address),
      ...(route.outputSchema ? { outputSchema: route.outputSchema } : {}),
      // EVM clients need the EIP-712 domain to sign; Solana clients need an RPC
      // to build the SPL transfer against.
      extra: rail.svm
        ? { rpcUrl: SOLANA_RPC_URL }
        : ((priced.asset as { eip712?: Record<string, unknown> }).eip712 ?? {}),
    });
  }
  return accepts;
}

/**
 * Express middleware enforcing dual-rail x402 payment on the given routes.
 * Routes not in the map pass straight through (free routes stay free).
 */
export function paywall(routes: RouteMap, opts: PaywallOptions = {}): RequestHandler {
  const compiled: CompiledRoute[] = Object.entries(routes).map(([key, route]) => ({
    ...compile(key),
    route,
  }));

  return async function x402Paywall(req: Request, res: Response, next: NextFunction) {
    const path = req.path;
    const match = compiled.find((c) => c.method === req.method.toUpperCase() && c.regex.test(path));
    if (!match) return next();

    const base = opts.baseUrl || `${req.protocol}://${req.get("host") ?? "localhost"}`;
    const resource = `${base}${req.originalUrl.split("?")[0]}`;
    const accepts = buildAccepts(match.route, resource, opts);

    if (accepts.length === 0) {
      res.status(500).json({
        error: "NO_PAYMENT_RAIL",
        message: "No payment rail is configured. Set PAY_TO_ADDRESS or SOLANA_PAY_TO_ADDRESS.",
      });
      return;
    }

    const header = req.header("X-PAYMENT");
    if (!header) return challenge(res, accepts, "X-PAYMENT header is required");

    // ---- decode the payment payload -------------------------------------
    // Envelopes are matched on `scheme` + `network` rather than strict schema
    // parsing, so both the EVM (EIP-3009) and Solana (signed SPL transfer)
    // encodings pass through untouched to the facilitator that understands them.
    let envelope: { scheme?: string; network?: string };
    try {
      envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      return challenge(res, accepts, "X-PAYMENT is not a valid base64 JSON x402 payload");
    }
    const payload = envelope as unknown as PaymentPayload;

    const selected =
      accepts.find((a) => a.network === envelope.network && a.scheme === envelope.scheme) ??
      accepts.find((a) => a.network === envelope.network);
    if (!selected) {
      return challenge(
        res,
        accepts,
        `payment targets network "${envelope.network}" which this resource does not accept`,
      );
    }
    const rail: PaymentContext["rail"] = String(selected.network).startsWith("solana")
      ? "solana"
      : "evm";

    // ---- verify (does not move funds) -----------------------------------
    const { verify, settle } = facilitatorFor(selected.network);
    try {
      const result = await verify(payload, selected);
      if (!result.isValid) {
        return challenge(res, accepts, result.invalidReason ?? "payment verification failed");
      }
      res.locals.x402 = {
        rail,
        network: selected.network,
        payer: (result as { payer?: string }).payer,
        amount: selected.maxAmountRequired,
        asset: selected.asset,
      } satisfies PaymentContext;
    } catch (err) {
      return challenge(res, accepts, `facilitator unreachable: ${(err as Error).message}`);
    }

    // ---- settle only if the handler actually produced the artifact ------
    const sendJson = res.json.bind(res);
    let settling = false;
    res.json = (body: unknown): Response => {
      if (settling || res.statusCode < 200 || res.statusCode >= 300) return sendJson(body);
      settling = true;
      void (async () => {
        try {
          const receipt = await settle(payload, selected);
          if (!receipt.success) throw new Error(receipt.errorReason ?? "settlement failed");
          res.setHeader("X-PAYMENT-RESPONSE", settleResponseHeader(receipt));
          res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
          sendJson(body);
        } catch (err) {
          // Payment did not settle — undo whatever the handler committed.
          const rollback = res.locals.x402Rollback as (() => void) | undefined;
          try {
            rollback?.();
          } catch (rollbackErr) {
            console.error("[x402] rollback failed", rollbackErr);
          }
          res.status(402);
          sendJson({
            x402Version: 1,
            error: `settlement failed: ${(err as Error).message}`,
            accepts,
          });
        }
      })();
      return res;
    };

    next();
  };
}

/** Emit the dual-rail 402 challenge. */
function challenge(res: Response, accepts: PaymentRequirements[], error: string): void {
  res.status(402).json({ x402Version: 1, error, accepts });
}

/** One-line startup summary of the configured rails. */
export function railSummary(): string[] {
  return [
    `EVM     ${EVM_NETWORK} -> ${EVM_PAY_TO}`,
    `        facilitator ${FACILITATOR_URL}`,
    `Solana  ${SOLANA_NETWORK} -> ${SOLANA_PAY_TO}`,
    `        facilitator ${SOLANA_FACILITATOR_URL}`,
  ];
}
