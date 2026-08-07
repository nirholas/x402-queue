# x402-queue

**Hold your place, keep the claim** — a self-hosted live waitlist server for
walk-in lists, counters, and service desks, payable with [x402](https://x402.org)
micropayments. Seeing the wait is **free**. $0.01 holds your place and hands back
a **signed position token** and a **signed refund claim** that matures on its own
if you are never served. Checking your position afterwards is free, forever.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![x402](https://img.shields.io/badge/payments-x402%20%C2%B7%20USDC-0052ff.svg)](https://x402.org)
[![rails](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#how-x402-works)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-0052ff.svg)](https://nirholas.github.io/x402-queue/)

## Why x402 for this

Waitlists fail in one specific way: they are free to join, so people join five of
them and show up to one. A tiny refundable hold fixes that without a card, an
account, or an app — and x402 makes the hold a two-second HTTP exchange instead
of a payments integration. For agents it is better still: an assistant can watch
a line for nothing, commit $0.01 when the wait passes a threshold, and poll the
position at zero marginal cost until it's time to go.

## The pay-now-deliver-later problem, solved

A queue is the textbook case the x402 suite's contract forbids: **every paid
route must return the purchased artifact in the 200 body**, and "a table, in
about forty minutes" is not that.

This service resolves it by returning **instruments, not promises**:

- a **signed position token** — proof of when you joined and what ETA you were
  quoted, tamper-evident in both directions;
- a **signed refund claim** — proof of what you are owed if that ETA is blown by
  more than the policy window, carrying its own `claimId`, `amount` and
  `claimableAfter`.

Both are in your hands before the response closes. Everything afterwards —
checking, claiming, leaving — is free, because you already bought the thing.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-queue
cd x402-queue && npm install

# your queues, service rates and hold policy live in config/queues.json
npm run dev
```

The server ships with the suite's public receive addresses so it runs out of the
box. Set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env`
to receive the payments yourself.

Then, in another terminal, run the full agent flow (watch → join → poll → served):

```bash
PRIVATE_KEY=0xFundedBaseSepoliaKey npm run client
```

Fund the client wallet with testnet USDC at
[faucet.circle.com](https://faucet.circle.com). Open <http://localhost:4025> for
the human checkout demo.

## API

| Route | Price | What you get back |
|---|---|---|
| `GET /queues` | free | Every queue with its live length, estimated wait, capacity, and whether it is accepting joins |
| `GET /queues/:id` | free | Live board for one queue — everyone in order, anonymised to an initial |
| `POST /join` | $0.01 (refundable hold) | `{ticketId, token, position, ahead, eta, graceMinutes, refundClaim, positionUrl, signature}` |
| `GET /position/:token` | free | Live position, ETA, serve status, refund status. **Pollable** — you paid for the place, not the look |
| `POST /claim/:token` | free | Signed refund record. Idempotent, authenticated by the token itself |
| `POST /leave/:token` | free | Give up your place; the hold is returned |
| `POST /call-next/:queueId` · `/serve/:id` · `/no-show/:id` | free | Operator routes for the front of house |
| `GET /info`, `GET /health`, `GET /.well-known/x402` | free | Venue profile / liveness / machine-readable payment manifest |

Full reference: [docs/api.md](docs/api.md) · [openapi.json](openapi.json)

## How the hold resolves

| Outcome | Hold |
|---|---|
| Served | **returned** |
| You left before being called | **returned** |
| Venue missed your quoted ETA by more than `refundIfNotServedMinutes` | **returned** — that's the auto-refund |
| Called, and you didn't appear within `graceMinutes` | forfeited |

`POST /no-show/:ticketId` is refused with `409 GRACE_PERIOD` until the full grace
window has elapsed, so nobody can be written off early. That guard is what makes
the hold fair in both directions.

## ETA arithmetic

Deliberately simple and legible, and echoed back in the artifact as `eta.basis`:

```
estimatedWaitMinutes = floor(ahead / parallelServers) × avgServeMinutes
```

Tune `avgServeMinutes` and `parallelServers` per queue against your real service
times, and the quotes — and therefore the auto-refunds — get honest fast.

## How x402 works

**Pay in USDC on Base or Solana — your client picks the rail.**

1. Client calls the paid route with no payment → server answers **`402 Payment
   Required`** with an `accepts[]` array holding **both rails**: USDC on Base
   (`base-sepolia` by default) and USDC on Solana, each with amount, token
   address, and recipient.
2. Client picks one and signs — EVM: an EIP-3009 `transferWithAuthorization`;
   Solana: an SPL `transferChecked` — then retries with the **`X-PAYMENT`**
   header.
3. The facilitator for that rail **verifies and settles** on the chosen chain —
   x402.org's for Base, PayAI's for Solana (each overridable by env; no public
   facilitator settles both).
4. Server responds **`200`** with the purchased artifact in the body and a
   settlement receipt in **`X-PAYMENT-RESPONSE`**.

Settlement is deliberately last: the payment only settles when the route returns
`2xx`, so a queue that filled up between the client's `/queues` read and its join
returns `409 QUEUE_FULL` and never charges the payer.

No API keys, no invoices, no minimums — each request pays for itself. Raw
wire-level walkthrough: [examples/curl.md](examples/curl.md).

## Real backend / configuration

This server runs **real queues you configure** — there are no fixtures and no
external API keys:

- `config/queues.json` — your venue profile and each queue's `avgServeMinutes`,
  `parallelServers`, `maxLength`, `graceMinutes` and `open` flag, plus the hold
  policy (`joinPrice`, `refundIfNotServedMinutes`, and the wording customers
  see).
- Tickets persist to `data/tickets.json` (file-based, no database), so a restart
  never loses someone's place in line.
- `SIGNING_SECRET` — set in production; it signs the position tokens and refund
  claims, whose whole point is that `joinedAt` and `quotedEta` can't be edited
  after the fact.
- `PUBLIC_BASE_URL` — set in production so `positionUrl` points at your real
  origin rather than `localhost`.
- Payment addresses: `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS`
  (Solana). Both default to the suite's public receive addresses so the demo runs
  unconfigured — the server prints a reminder while the defaults are active.
- Facilitators are per-rail: `FACILITATOR_URL` (EVM, default x402.org) and
  `SOLANA_FACILITATOR_URL` (Solana, default PayAI). No public facilitator settles
  both chains.
- Mainnet: `NETWORK=base` + a production EVM `FACILITATOR_URL`. Solana defaults
  to mainnet; `SOLANA_NETWORK=devnet` switches it. Use a dedicated
  `SOLANA_RPC_URL` in production.

The refund record is signed and returned in-response; moving the USDC back
on-chain is the operator's action (or an automation you attach). The operator
routes (`/call-next`, `/serve`, `/no-show`) are free and unauthenticated by
design — put them behind your own staff auth or bind them to the host stand's
network before going live.

All variables: [.env.example](.env.example)

## Human checkout

`public/index.html` is a live-board checkout: watch the waits for free, pick a
queue, join with the drop-in
[`@three-ws/x402-payment-modal`](https://www.npmjs.com/package/@three-ws/x402-payment-modal)
(loaded from CDN), and your position ticks down on screen — polled for free every
15 seconds, with buttons to claim the refund or leave. The modal reads the
dual-rail 402 and offers **Phantom/Solflare/Backpack on Solana or MetaMask on
Base** automatically. It also brings **SIWX wallet re-entry** (a wallet that
already paid signs back in instead of reconnecting) and **client-side spending
caps** (per-call / hourly / daily), so a regular doesn't re-approve every visit.

The Solana browser path needs one small server route — Phantom signs serialized
transactions, so the SPL transfer has to be built somewhere. `src/checkout.ts`
mounts the package's own Express adapter at `/api/x402-checkout`; if the optional
peer deps aren't installed, that path degrades and the Base path keeps working.
Agent clients build their own transaction and never touch it.

## For AI agents

- **[skill.md](skill.md)** — agent-facing service description (endpoints, prices,
  schemas, both payment rails).
- **[/.well-known/x402](public/.well-known/x402)** — machine-readable manifest
  served by the app; indexable by [x402scan.com](https://x402scan.com), the x402
  Bazaar, and [agentic.market](https://agentic.market). Deploy publicly and
  submit your base URL to be discovered.
- **MCP**: wrap the endpoints as Claude tools in ~90 lines — see
  [examples/mcp-tool.md](examples/mcp-tool.md), including a polling loop that
  costs nothing after the join.
- **Client**: [examples/agent-client.ts](examples/agent-client.ts) is the
  complete watch-join-poll-served loop via `x402-fetch`, including a forged-token
  rejection, with the Solana alternative documented inline.
- Agent guide: [docs/agents.md](docs/agents.md)

## Docs

Site: **<https://nirholas.github.io/x402-queue/>** · [Tutorial](docs/tutorial.md)
· [API reference](docs/api.md) · [For agents](docs/agents.md)

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, integration help, or a bug report: **nichxbt@gmail.com** — or open an
[issue](https://github.com/nirholas/x402-queue/issues).

## License

[Apache-2.0](LICENSE)
