/**
 * Full agent flow against x402-queue:
 *   1. read the free manifest + queue board (seeing the wait costs nothing)
 *   2. pay $0.01 to join — the signed position token, the ETA and the signed
 *      refund claim all come back in the same 200 response
 *   3. poll GET /position/:token for free
 *   4. walk the ticket through call → serve using the free operator routes
 *   5. show the refund resolving, and a forged token being rejected
 *
 * Usage:
 *   PRIVATE_KEY=0x... BASE_URL=http://localhost:4025 npx tsx examples/agent-client.ts
 *
 * The wallet needs base-sepolia USDC — faucet: https://faucet.circle.com
 *
 * ── Which rail? ────────────────────────────────────────────────────────────
 * Every 402 from this server carries BOTH rails in `accepts`:
 *   [0] network "base-sepolia" | "base"    USDC via EIP-3009 transferWithAuthorization
 *   [1] network "solana" | "solana-devnet" USDC via SPL transferChecked
 * `x402-fetch` (used below) picks the EVM entry automatically. The Solana
 * alternative is at the bottom of this file.
 */
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4025";
const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Set PRIVATE_KEY to a funded base-sepolia key (https://faucet.circle.com)");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

function receipt(res: Response): unknown {
  const header = res.headers.get("x-payment-response");
  return header ? decodeXPaymentResponse(header) : null;
}

// 1. free discovery — seeing the wait costs nothing
const manifest = await fetch(`${BASE_URL}/.well-known/x402`).then((r) => r.json());
console.log("Manifest:", manifest.name, "-", manifest.description);
console.log("Rails:", manifest.payment.rails.map((r: { network: string }) => r.network).join(" | "), "\n");

const board = await fetch(`${BASE_URL}/queues`).then((r) => r.json());
console.log(`${board.venue.name}:`);
for (const q of board.queues) {
  console.log(
    `  ${q.id.padEnd(14)} ${String(q.waiting).padStart(3)} waiting · ~${q.estimatedWaitMinutes} min · ${q.acceptingJoins ? "open" : "closed"}`,
  );
}
const queue = board.queues.find((q: { acceptingJoins: boolean }) => q.acceptingJoins);
if (!queue) throw new Error("every queue is closed or full");
console.log(`\nJoining ${queue.name} (~${queue.estimatedWaitMinutes} min quoted)\n`);

// 2. paid join
const joinRes = await payFetch(`${BASE_URL}/join`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-payer-address": account.address },
  body: JSON.stringify({ queue: queue.id, name: "Agent Ada", party: 2 }),
});
if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status} ${await joinRes.text()}`);
const ticket = await joinRes.json();

console.log("=== QUEUE TICKET ARTIFACT ===");
console.log(JSON.stringify(ticket, null, 2));
console.log("\nX-PAYMENT-RESPONSE settlement receipt:");
console.log(receipt(joinRes));
console.log(
  `\nPosition ${ticket.position} (${ticket.ahead} ahead), ETA ${ticket.eta.minutes} min — ${ticket.eta.basis}`,
);
console.log(
  `Refund claim ${ticket.refundClaim.claimId} matures ${ticket.refundClaim.claimableAfter}` +
    ` — that instrument is in hand now, not promised later.`,
);

// 3. checking your position is free — poll as often as you like
const position = await fetch(`${BASE_URL}/position/${ticket.token}`).then((r) => r.json());
console.log("\n=== POSITION (free) ===");
console.log(
  JSON.stringify(
    { status: position.status, position: position.position, eta: position.eta, refund: position.refund },
    null,
    2,
  ),
);

// A forged token is rejected — the HMAC covers joinedAt and the quoted ETA.
const forged = ticket.token.slice(0, -2) + (ticket.token.endsWith("ff") ? "00" : "ff");
const forgedRes = await fetch(`${BASE_URL}/position/${forged}`);
console.log("\nForged token:", forgedRes.status, (await forgedRes.json()).message);

// Claiming before the hold is due is refused, with the reason.
const earlyClaim = await fetch(`${BASE_URL}/claim/${ticket.token}`, { method: "POST" });
console.log("Early claim:", earlyClaim.status, (await earlyClaim.json()).message);

// 4. the operator side (free routes — front of house, or your POS integration)
const called = await fetch(`${BASE_URL}/call-next/${queue.id}`, { method: "POST" }).then((r) => r.json());
console.log(`\nOperator called: ${called.called?.holder} (party of ${called.called?.party})`);

const afterCall = await fetch(`${BASE_URL}/position/${ticket.token}`).then((r) => r.json());
console.log(`Our ticket is now: ${afterCall.status}`);

if (afterCall.status === "called") {
  const served = await fetch(`${BASE_URL}/serve/${ticket.ticketId}`, { method: "POST" }).then((r) => r.json());
  console.log("\n=== SERVED ===");
  console.log(JSON.stringify(served, null, 2));
}

// 5. the hold resolves
const final = await fetch(`${BASE_URL}/position/${ticket.token}`).then((r) => r.json());
console.log("\n=== FINAL STATE ===");
console.log(JSON.stringify({ status: final.status, refund: final.refund }, null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// Paying on the SOLANA rail instead
// ─────────────────────────────────────────────────────────────────────────────
//
// `x402-fetch` signs the EVM entry. To settle in USDC on Solana, read the same
// 402 body and act on the `solana` entry:
//
//   const res = await fetch(`${BASE_URL}/join`, { method: "POST" });
//   const { accepts } = await res.json();
//   const sol = accepts.find((a) => a.network.startsWith("solana"));
//   // sol = { scheme: "exact", network: "solana",
//   //         asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",   // USDC mint
//   //         payTo: "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
//   //         maxAmountRequired: "10000",                              // 0.01 USDC, 6dp
//   //         extra: { rpcUrl: "https://api.mainnet-beta.solana.com" } }
//
// Build an SPL `transferChecked` of `maxAmountRequired` units of `asset` to
// `payTo`, sign it with your Solana keypair, then base64 the x402 envelope into
// `X-PAYMENT` and retry. Verification and settlement happen server-side through
// that rail's facilitator (PayAI for Solana, x402.org for Base).
//
// Browser clients can reuse the checkout helper this server mounts at
// `POST /api/x402-checkout?action=prepare` (build the transaction) and
// `?action=encode` (wrap the signed transaction into the X-PAYMENT envelope).
//
// ── Raw dual-rail 402, for reference ────────────────────────────────────────
//
//   $ curl -s -X POST http://localhost:4025/join | jq '.accepts[] | {network, payTo, asset}'
//   { "network": "base-sepolia",
//     "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
//     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }
//   { "network": "solana",
//     "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
//     "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
