# Tutorial — from zero to a place in line

This walkthrough takes you from clone to a paid place in a live queue, using real
x402 payments — **USDC on Base Sepolia or on Solana**, your choice.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-queue
cd x402-queue
npm install
```

Requirements: Node 18+.

## 2. Configure

The server runs unconfigured — `.env.example` ships with the suite's public
receive addresses on both rails, and the startup banner reminds you they're the
defaults. To take the money yourself, copy the template and set both:

```bash
cp .env.example .env
# edit .env →
#   PAY_TO_ADDRESS=0xYourBaseAddress            (EVM rail)
#   SOLANA_PAY_TO_ADDRESS=YourSolanaAddress     (Solana rail)
```

You can also run one rail only: drop an address and that rail is omitted from
every 402 (the server logs which one it skipped).

Describe your real waitlists in `config/queues.json`:

- `venue` — name, description, timezone, address, phone
- `queues` — each with `id`, `name`, `description`, `avgServeMinutes` (how long
  one party takes), `parallelServers` (how many at once), `maxLength` (refuse
  joins beyond this), `graceMinutes` (how long a called party has to appear), and
  `open`
- `holdPolicy` — the join price, `refundIfNotServedMinutes` (the promise you are
  making), and the wording customers see

The ETA maths is deliberately simple and legible:
`floor(ahead / parallelServers) × avgServeMinutes`. Tune `avgServeMinutes`
against your real service times and the quotes get honest fast.

**Set `SIGNING_SECRET` before you sell anything real.** It signs the position
tokens, and their whole point is that neither side can edit `joinedAt` or
`quotedEta` after the fact.

## 3. Run the server

```bash
npm run dev
```

You'll see the banner with the paid route, its price, and both rails. Sanity
checks:

```bash
curl -s http://localhost:4025/health | jq
curl -s http://localhost:4025/queues | jq '.queues[] | {id, waiting, estimatedWaitMinutes, acceptingJoins}'
curl -s http://localhost:4025/.well-known/x402 | jq
```

Note that `/queues` needs no payment. Seeing the wait is free.

## 4. Your first 402

Call the paid route without paying:

```bash
curl -si -X POST http://localhost:4025/join \
  -H 'content-type: application/json' \
  -d '{"queue":"dining-room","name":"Ada","party":2}' | head -20
```

You get `HTTP/1.1 402 Payment Required` and a JSON body whose `accepts[]` array
has **two entries** — one per rail:

```bash
curl -s -X POST http://localhost:4025/join \
  | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

```json
{ "network": "base-sepolia", "payTo": "0x40252CFD…", "asset": "0x036CbD53…", "maxAmountRequired": "10000" }
{ "network": "solana",       "payTo": "WwwuGbqH…",  "asset": "EPjFWdd5…",  "maxAmountRequired": "10000" }
```

Each entry states the exact amount (atomic USDC units, 6 decimals), the token
address, the recipient, and the network. This is the whole protocol: the 402 *is*
the price list, and it quotes in two currencies of the same dollar.

## 5. Fund a client wallet

**Base rail (what the bundled client uses):** create a throwaway key (e.g.
`openssl rand -hex 32` prefixed with `0x`, or export one from a test wallet) and
fund it with **Base Sepolia USDC** from <https://faucet.circle.com>. A few cents'
worth is plenty.

**Solana rail:** any wallet holding USDC works — Phantom in the browser demo, or
a keypair in an agent. Set `SOLANA_NETWORK=devnet` to test against devnet USDC
instead of mainnet.

## 6. Join the list

```bash
PRIVATE_KEY=0xYourFundedKey npm run client
```

`examples/agent-client.ts` will:

1. read the free manifest and queue board,
2. pick a queue that is accepting joins,
3. pay **$0.01** for `POST /join`,
4. print the artifact — position, ETA and its basis, the signed token, and the
   signed refund claim — plus the decoded `X-PAYMENT-RESPONSE` settlement
   receipt, which names the rail and the transaction,
5. read `GET /position/:token` (free), then show a forged token being rejected
   and an early refund claim being refused with its reason,
6. drive the operator routes: call the next party, mark them served, and show the
   hold resolving to refunded.

## 7. Reading the artifact

Everything you paid for is in the 200 body — and crucially, **nothing is
deferred**. Queues are the classic "pay now, get served later" shape; this
service resolves that by handing over instruments instead of promises:

- `token` — **the ticket**. `base64url(canonical payload) + "." + hex HMAC`. The
  payload carries `joinedAt` and `quotedEta`, so the venue cannot quietly
  re-quote you and you cannot claim you joined earlier than you did.
- `position` / `ahead` / `eta` — where you stood at issue time, and the `basis`
  string explaining the arithmetic.
- `refundClaim` — a signed instrument with its own `claimId`, `amount`, `reason`
  and `claimableAfter`. It matures on its own; you already hold it.
- `graceMinutes` — how long you have to appear once you are called.
- `positionUrl` — a ready-made link to your free live status page.

## 8. Watching your place (free)

```bash
TOKEN=$(jq -r .token ticket.json)
curl -s "http://localhost:4025/position/$TOKEN" | jq '{status, position, ahead, eta, refund}'
```

Poll it every 30 seconds if you like — it costs nothing. Tamper with one
character and it stops validating:

```bash
curl -s "http://localhost:4025/position/${TOKEN%??}ff" | jq .message
# "signature does not match — token was altered or forged"
```

## 9. Working the front of house

```bash
curl -s -X POST http://localhost:4025/call-next/dining-room | jq
curl -s -X POST http://localhost:4025/serve/tkt_XXXX | jq       # they turned up
curl -s -X POST http://localhost:4025/no-show/tkt_XXXX | jq     # they didn't
```

`no-show` is refused with `409 GRACE_PERIOD` until the queue's full
`graceMinutes` has elapsed since the call, so nobody can be written off early.
That guard is what makes the hold fair in both directions.

## 10. Refunds

The hold is **due back** when you were served, when you left before being called,
or when the venue missed your quoted ETA by more than
`refundIfNotServedMinutes`. It is **forfeited** only when you were called and did
not show up.

```bash
curl -s -X POST "http://localhost:4025/claim/$TOKEN" | jq
curl -s -X POST "http://localhost:4025/leave/$TOKEN" | jq
```

`POST /claim` is idempotent — a retry returns the same record with
`alreadyIssued: true`. The signed record is the customer's claim; moving the USDC
back on-chain is the operator's action (or an automation you attach).

## 11. The human checkout

Open <http://localhost:4025> — a live-board page using the drop-in
`@three-ws/x402-payment-modal`. Watch the waits for free, pick a queue, join from
a browser wallet — **Phantom / Solflare / Backpack on Solana, or MetaMask on
Base** — and your position ticks down on screen (polled for free every 15
seconds). The modal reads the dual-rail 402 and offers the wallets it detects;
SIWX re-entry means a regular signs in instead of reconnecting, and spending caps
bound what the page can charge.

The Solana browser path needs one server route (Phantom signs serialized
transactions, so the SPL transfer has to be built server-side). `src/checkout.ts`
mounts it at `/api/x402-checkout`; if its optional peer deps are missing the
banner says `Solana browser checkout: disabled` and the Base path still works.
Agent clients build their own transaction and never touch that route.

## 12. Going to mainnet

1. Set `NETWORK=base` (the Solana rail already defaults to mainnet — set
   `SOLANA_NETWORK=devnet` if you want it on devnet instead).
2. Point `FACILITATOR_URL` at a production facilitator for Base (e.g. Coinbase
   Developer Platform's x402 facilitator). The Solana rail settles through
   `SOLANA_FACILITATOR_URL`, which defaults to PayAI's
   (`https://facilitator.payai.network`) — no public facilitator handles both
   chains.
3. Replace the public Solana RPC: set `SOLANA_RPC_URL` to a dedicated endpoint
   (Helius / Triton / QuickNode). The default is rate-limited and will fail
   under load.
4. Set a strong `SIGNING_SECRET`.
5. Set `PUBLIC_BASE_URL` so `positionUrl` points at your real origin, not
   `localhost`.
6. Use real merchant wallets for `PAY_TO_ADDRESS` **and**
   `SOLANA_PAY_TO_ADDRESS`.
7. Wire `POST /call-next`, `/serve` and `/no-show` to whatever the host stand
   actually uses — a tablet, your POS, or a pager system. The server is the
   source of truth for the line; the UI on top is yours.
8. Deploy behind HTTPS (agents will refuse to pay plaintext endpoints) and keep
   `data/` on a persistent volume.

Prices stay in dollar strings (`$0.01`) — the paywall converts to atomic USDC on
whichever network the client picks.
