import "dotenv/config";
import express from "express";
import { CHECKOUT_PATH, mountSolanaCheckout } from "./checkout.js";
import {
  EVM_NETWORK,
  EVM_PAY_TO,
  SOLANA_NETWORK,
  SOLANA_PAY_TO,
  USING_DEFAULT_PAY_TO,
  paywall,
  railSummary,
  type RouteMap,
} from "./payments.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import {
  QueueError,
  callNext,
  claimRefund,
  config,
  getBoard,
  getPosition,
  getQueues,
  join,
  leave,
  noShow,
  releaseTicket,
  serve,
} from "./service.js";

const PORT = Number(process.env.PORT || 4025);

export const PRICES = {
  join: "$0.01",
} as const;

/** Paid routes. Anything not listed here is free — checking your position included. */
const routes: RouteMap = {
  "POST /join": {
    price: PRICES.join,
    description:
      "Join a live waitlist with a refundable hold. Returns a signed queue-position token, your position and ETA, and a signed refund claim that auto-matures if you are never served",
    // Request/response schemas mirror openapi.json — see src/schemas.ts.
    ...ROUTE_SCHEMAS["POST /join"],
  },
};

const app = express();
app.use(express.json());
// Solana browser checkout for public/index.html (EVM needs no server help).
const solanaCheckout = await mountSolanaCheckout(app);
app.use(paywall(routes, { baseUrl: process.env.PUBLIC_BASE_URL }));
app.use(
  express.static("public", {
    setHeaders: (res, p) => {
      if (p.endsWith("/.well-known/x402")) res.setHeader("Content-Type", "application/json");
    },
  }),
);

function origin(req: express.Request): string {
  return (
    process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host") ?? `localhost:${PORT}`}`
  );
}

// ---- free routes -----------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-queue", venue: config.venue.name });
});

/** Free by design: seeing the wait is free, holding a place is what costs. */
app.get("/queues", (_req, res) => {
  res.json(getQueues());
});

app.get("/queues/:queueId", (req, res) => {
  try {
    res.json(getBoard(req.params.queueId));
  } catch (err) {
    handleError(err, res);
  }
});

/** Free and pollable — you paid once for the place, checking it is free forever. */
app.get("/position/:token", (req, res) => {
  try {
    res.json(getPosition(req.params.token));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/claim/:token", (req, res) => {
  try {
    res.json(claimRefund(req.params.token));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/leave/:token", (req, res) => {
  try {
    res.json(leave(req.params.token));
  } catch (err) {
    handleError(err, res);
  }
});

// ---- free operator routes (front-of-house) --------------------------------

app.post("/call-next/:queueId", (req, res) => {
  try {
    res.json(callNext(req.params.queueId));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/serve/:ticketId", (req, res) => {
  try {
    res.json(serve(req.params.ticketId));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/no-show/:ticketId", (req, res) => {
  try {
    res.json(noShow(req.params.ticketId));
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/info", (_req, res) => {
  res.json({
    venue: config.venue,
    holdPolicy: config.holdPolicy,
    prices: PRICES,
    payment: {
      rails: [
        { rail: "evm", network: EVM_NETWORK, asset: "USDC", payTo: EVM_PAY_TO },
        { rail: "solana", network: SOLANA_NETWORK, asset: "USDC", payTo: SOLANA_PAY_TO },
      ],
    },
  });
});

// ---- paid route (payment enforced by the paywall above) -------------------

app.post("/join", (req, res) => {
  try {
    const payer = req.header("x-payer-address") ?? res.locals.x402?.payer ?? req.body?.payerWallet;
    const artifact = join({ ...req.body, payerWallet: payer, baseUrl: origin(req) });
    // If settlement fails after this point, take them back off the list.
    res.locals.x402Rollback = () => releaseTicket(artifact.ticketId);
    res.json(artifact);
  } catch (err) {
    handleError(err, res);
  }
});

function handleError(err: unknown, res: express.Response): void {
  if (err instanceof QueueError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL", message: "unexpected error" });
}

app.listen(PORT, () => {
  console.log(`\n  x402-queue — ${config.venue.name}`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log("  Paid route — pay in USDC on Base or Solana, your client picks the rail:");
  console.log(`    POST /join              ${PRICES.join}  (refundable hold)`);
  console.log("  Free routes:");
  console.log("    GET  /queues  /queues/:id  /position/:token  /info  /health");
  console.log("    POST /claim/:token  /leave/:token");
  console.log("  Free operator routes:");
  console.log("    POST /call-next/:queueId  /serve/:ticketId  /no-show/:ticketId");
  console.log("");
  for (const line of railSummary()) console.log(`  ${line}`);
  console.log(
    `  Solana browser checkout: ${solanaCheckout ? `mounted at ${CHECKOUT_PATH}` : "disabled"}`,
  );
  if (USING_DEFAULT_PAY_TO) {
    console.log(
      "  NOTE: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself",
    );
  }
  console.log(`  Manifest: http://localhost:${PORT}/.well-known/x402`);
  console.log(`  Demo:     http://localhost:${PORT}/\n`);
});
