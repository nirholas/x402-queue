---
name: join-paid-queue
description: Run the x402-queue waitlist server (or call a venue's deployment) to read live queues for free, join with a $0.01 refundable hold, poll position, and claim the refund. Use when an agent must hold a place in a walk-in line and can pay over x402.
---

# x402-queue

x402-queue is a self-hosted waitlist. Viewing queues is free. `POST /join` costs a $0.01 refundable hold and returns, in the 200 body, a signed position token (keep `token`) plus a signed `refundClaim` that matures if the venue never serves you. Position checks are free and can be polled.

Paying is irreversible. Before any paid call, show the user the route, price, network and payTo address from the 402 response, and wait for an explicit yes.

## Run the service

From a clone (Node 18+):

```bash
git clone https://github.com/nirholas/x402-queue
cd x402-queue && npm install
npm run dev        # tsx src/server.ts, listens on :4025 (PORT overrides)
```

Environment (see `.env.example`): `SIGNING_SECRET` (HMAC key for tokens, change it from the example value), `DATA_DIR` (default `data`), `QUEUES_CONFIG` (default `config/queues.json`, defines the venue and queues: `id`, `avgServeMinutes`, `parallelServers`, `maxLength`, `graceMinutes`, `open`). Payment settings: `PAY_TO_ADDRESS` (Base receive address), `SOLANA_PAY_TO_ADDRESS`, `NETWORK` (`base-sepolia` default, or `base`), `SOLANA_NETWORK`, `FACILITATOR_URL`, `PUBLIC_BASE_URL`. Set your own pay-to addresses to be paid yourself. `npm run build` then `npm start` runs the compiled server.

## Routes

| Route | Price | Notes |
|---|---|---|
| `GET /queues` | free | every queue with live length and wait |
| `GET /queues/:queueId` | free | anonymised live board for one queue |
| `POST /join` | $0.01 refundable hold | body `queue` and `name` required, `party` (default 1), `contact` (optional, shown to the operator when called) |
| `GET /position/:token` | free | position, ETA, status (`waiting`, `called`, `served`, `no-show`, `left`, `refunded`) and refund state |
| `POST /claim/:token` | free | exercise the refund claim (409 `REFUND_NOT_DUE` when not owed) |
| `POST /leave/:token` | free | give up the place, hold returned |
| `POST /call-next/:queueId`, `POST /serve/:ticketId`, `POST /no-show/:ticketId` | free | operator routes for the venue's front of house |
| `GET /info`, `GET /health`, `GET /.well-known/x402` | free | venue profile and prices, liveness, discovery |

## Paying

An unpaid request to a paid route returns 402 with an `accepts` array listing both rails (USDC on Base or Solana). Sign the entry your wallet supports and retry with the base64 `X-PAYMENT` header. The settlement receipt is in the `X-PAYMENT-RESPONSE` header. The reference client is `examples/agent-client.ts` (`npm run client`), which uses `x402-fetch` with `PRIVATE_KEY` for a Base Sepolia wallet and `BASE_URL` (default `http://localhost:4025`).

The hold is due back when you were served, left before being called, or the venue missed the quoted ETA by more than `refundIfNotServedMinutes`. It is forfeited only if you were called and did not show (the operator route refuses `no-show` with 409 `GRACE_PERIOD` until `graceMinutes` has elapsed).

## Example

```bash
curl localhost:4025/queues                                   # free, pick a queue id
curl -i -X POST localhost:4025/join -H 'content-type: application/json' \
  -d '{"queue":"dining-room","name":"Ada Lovelace","party":2}'   # 402, pay, keep token
curl localhost:4025/position/<token>                         # free, poll
curl -X POST localhost:4025/claim/<token>                    # refund if due
```
