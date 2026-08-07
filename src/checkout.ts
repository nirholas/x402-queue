/**
 * Solana browser-checkout mount for the human demo page.
 *
 * The EVM rail needs nothing server-side: the wallet signs an EIP-3009
 * authorization entirely in the browser. The Solana rail does — Phantom only
 * signs serialized transactions, so something must build the SPL
 * `transferChecked` the buyer signs. `@three-ws/x402-payment-modal/server`
 * does exactly that (`prepare` -> sign -> `encode`), and the modal calls it at
 * `/api/x402-checkout` by default.
 *
 * Loaded dynamically: if the package or its optional peer deps
 * (`@solana/web3.js`, `@solana/spl-token`) are absent, the Solana browser path
 * is simply unavailable and the EVM path keeps working. Agent clients paying
 * on Solana never touch this route — they build their own transaction.
 */

import type { Express } from "express";
import { SOLANA_RPC_URL } from "./payments.js";

export const CHECKOUT_PATH = "/api/x402-checkout";

/** Mount the Solana checkout router. Returns true when it is available. */
export async function mountSolanaCheckout(app: Express): Promise<boolean> {
  try {
    // Untyped subpath (`./server/express` ships no .d.ts) — narrow it here.
    const specifier = "@three-ws/x402-payment-modal/server/express";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      x402CheckoutRouter: (opts: Record<string, unknown>) => import("express").Router;
    };
    app.use(
      CHECKOUT_PATH,
      mod.x402CheckoutRouter({
        rpcUrl: SOLANA_RPC_URL,
        devnetRpcUrl: process.env.SOLANA_DEVNET_RPC_URL,
      }),
    );
    return true;
  } catch (err) {
    console.warn(
      `[x402] Solana browser checkout disabled (${(err as Error).message}). ` +
        "Install @three-ws/x402-payment-modal @solana/web3.js @solana/spl-token to enable it. " +
        "The EVM rail and both agent-side rails are unaffected.",
    );
    return false;
  }
}
