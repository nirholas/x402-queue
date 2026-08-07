# x402-queue

Self-hosted live waitlist server payable with x402 micropayments (USDC) — walk-in lists, counters, and service desks that AI agents and humans can join without an app, a phone number, or a text-message loop. Seeing the wait is **free**. Joining costs a $0.01 refundable hold, and the payment returns everything in the 200 body: a **signed queue-position token**, your position and ETA at issue time, and a **signed refund claim** that matures automatically if the venue never serves you. Checking your position is free and pollable forever — you paid once for the place in line, not for the right to look at it.

**Base URL**: `https://YOUR-DEPLOYMENT.example.com` (self-hosted — each venue runs its own instance)

**Machine-readable manifest**: `GET /.well-known/x402` (free)

## Why the artifact is a claim, not a promise

Queues are the classic "pay now, get served later" shape, which the x402 suite's
contract forbids. This service resolves it by handing over an **instrument**
instead: the 200 body contains a signed position token (proof of when you joined
and what ETA you were quoted) and a signed `refundClaim` (proof of what you are
owed if that ETA is blown by more than the policy window). Both are in your hands
before you leave the request. Nothing is deferred.

## Endpoints

### GET /queues — free

Every queue with its live length and current wait.

```json
{
  "venue": { "name": "402 Walk-ins", "timezone": "America/New_York", "address": "…" },
  "holdPolicy": { "joinPrice": "$0.01", "refundIfNotServedMinutes": 30, "description": "…" },
  "generatedAt": "2026-08-07T18:00:00.000Z",
  "queues": [
    {
      "id": "dining-room",
      "name": "Dining room walk-in list",
      "description": "Tables for parties of 1–6…",
      "open": true,
      "avgServeMinutes": 12,
      "parallelServers": 2,
      "maxLength": 40,
      "graceMinutes": 5,
      "waiting": 7,
      "beingServed": 2,
      "spaceLeft": 33,
      "estimatedWaitMinutes": 36,
      "acceptingJoins": true
    }
  ]
}
```

`estimatedWaitMinutes` = `floor(waiting / parallelServers) × avgServeMinutes`.

### GET /queues/:queueId — free

The live board for one queue: everyone in order, anonymised to an initial.

```json
{
  "queueId": "dining-room",
  "name": "Dining room walk-in list",
  "waiting": 3,
  "estimatedWaitMinutes": 12,
  "entries": [
    { "position": 1, "holder": "A.", "party": 2, "status": "waiting", "joinedAt": "…" },
    { "position": null, "holder": "B.", "party": 4, "status": "called", "calledAt": "…" }
  ]
}
```

Errors: `404 UNKNOWN_QUEUE`.

### POST /join — $0.01 (refundable hold)

Body:
```json
{ "queue": "dining-room", "name": "Ada Lovelace", "party": 2, "contact": "+15550402402" }
```

`queue` and `name` are required; `party` defaults to 1; `contact` is optional and only shown to the operator when your party is called.

Response (the purchased artifact — keep `token`):
```json
{
  "ticketId": "tkt_1a2b3c4d5e6f",
  "token": "<base64url payload>.<hex HMAC>",
  "position": 8,
  "ahead": 7,
  "party": 2,
  "holder": "Ada Lovelace",
  "queue": { "id": "dining-room", "name": "Dining room walk-in list", "description": "…" },
  "venue": "402 Walk-ins",
  "eta": {
    "minutes": 36,
    "at": "2026-08-07T18:36:00.000Z",
    "basis": "7 ahead, 2 server(s), ~12 min each"
  },
  "graceMinutes": 5,
  "holdPolicy": { "joinPrice": "$0.01", "refundIfNotServedMinutes": 30, "description": "…" },
  "refundClaim": {
    "claimId": "clm_9f8e7d6c5b4a",
    "ticketId": "tkt_1a2b3c4d5e6f",
    "amount": "$0.01",
    "reason": "auto-refund if not served within 30 minutes of the quoted ETA",
    "claimableAfter": "2026-08-07T19:06:00.000Z",
    "claimEndpoint": "POST /claim/<token>",
    "signature": "hex HMAC-SHA256"
  },
  "positionUrl": "https://YOUR-DEPLOYMENT.example.com/position/<token>",
  "positionEndpoint": "GET /position/<token>",
  "leaveEndpoint": "POST /leave/<token>",
  "joinedAt": "2026-08-07T18:00:00.000Z",
  "signature": "hex HMAC-SHA256 over the canonical artifact JSON"
}
```

Errors: `400 INVALID_QUEUE|INVALID_NAME|INVALID_PARTY`, `404 UNKNOWN_QUEUE`, `409 QUEUE_CLOSED|QUEUE_FULL`.

### GET /position/:token — free

Live position, serve status, and refund status. Poll it as often as you like.

```json
{
  "ticketId": "tkt_1a2b3c4d5e6f",
  "queue": { "id": "dining-room", "name": "Dining room walk-in list" },
  "venue": "402 Walk-ins",
  "holder": "Ada Lovelace",
  "party": 2,
  "status": "waiting",
  "position": 3,
  "ahead": 2,
  "eta": { "minutes": 12, "at": "2026-08-07T18:24:00.000Z", "quotedAtJoin": "2026-08-07T18:36:00.000Z" },
  "calledAt": null,
  "servedAt": null,
  "overdueByMinutes": 0,
  "refund": {
    "issued": false,
    "due": false,
    "reason": "still in line and inside the promised window",
    "claimableAfter": "2026-08-07T19:06:00.000Z",
    "amount": "$0.01"
  },
  "holdPolicy": { … },
  "checkedAt": "2026-08-07T18:12:00.000Z"
}
```

`status` is one of `waiting` · `called` · `served` · `no-show` · `left` · `refunded`. `position` and `eta` are `null` once you are no longer waiting.

Errors: `400 BAD_TOKEN` (malformed, altered, or forged), `404 TICKET_NOT_FOUND`.

### POST /claim/:token — free

Exercise the refund claim. Idempotent, and authenticated by the token itself — you were handed the instrument at join time.

The hold is **due back** when you were served, when you left before being called, or when the venue missed your quoted ETA by more than `refundIfNotServedMinutes`. It is **forfeited** only when you were called and did not show up.

```json
{
  "ticketId": "tkt_1a2b3c4d5e6f",
  "queueId": "dining-room",
  "refunded": true,
  "amount": "$0.01",
  "reason": "not served within 30 minutes of the quoted ETA — the hold is returned",
  "wallet": "0x…",
  "issuedAt": "2026-08-07T19:07:00.000Z",
  "signature": "…"
}
```

Errors: `409 REFUND_NOT_DUE` (with the reason), `400 BAD_TOKEN`, `404 TICKET_NOT_FOUND`.

### POST /leave/:token — free

Give up your place. The hold is returned and the queue closes up behind you.

Errors: `409 ALREADY_CLOSED`, `400 BAD_TOKEN`, `404 TICKET_NOT_FOUND`.

### Free operator routes (front of house)

- `POST /call-next/:queueId` — call the next waiting party. Returns their name, party size, contact, and the grace window.
- `POST /serve/:ticketId` — mark a called party served; the hold is returned.
- `POST /no-show/:ticketId` — they were called and never appeared; the hold is forfeited. Refused with `409 GRACE_PERIOD` until the full `graceMinutes` has elapsed, so nobody can be written off early.

### Other free routes

- `GET /info` — venue profile, hold policy, prices, payment rails
- `GET /health` — liveness
- `GET /.well-known/x402` — this service's payment manifest

## Payment

**Pay in USDC on Base or Solana — your client picks the rail.** The paid route
answers an unpaid request with a `402` whose `accepts` array carries both rails;
choose the one your wallet can settle and ignore the other.

- Protocol: [x402](https://x402.org) (HTTP 402 Payment Required), `x402Version: 1`, scheme `exact`
- **EVM rail** — network `base-sepolia` (default; `NETWORK=base` for mainnet), asset USDC
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on base-sepolia), payTo
  `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`
- **Solana rail** — network `solana` (`SOLANA_NETWORK=devnet` for `solana-devnet`), asset USDC
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), payTo
  `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`
- Facilitators (one per rail): EVM `https://x402.org/facilitator` (`FACILITATOR_URL`), Solana `https://facilitator.payai.network` (`SOLANA_FACILITATOR_URL`)
- Flow: call the route → receive `402` + `accepts[]` → sign the USDC payment for one rail
  (EVM: EIP-3009 `transferWithAuthorization`; Solana: SPL `transferChecked`) → retry with the
  `X-PAYMENT` header → receive `200` + the artifact in the body + an
  `X-PAYMENT-RESPONSE` settlement receipt naming the rail and transaction.
- Clients: `x402-fetch` (EVM), `@three-ws/x402-payment-modal` (browser, both rails),
  or any x402-compatible client.
- Settlement happens only when the route returns `2xx`. A queue that filled up between your
  `/queues` read and your join returns `409 QUEUE_FULL` and costs you nothing.

Example 402 body:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxAmountRequired": "10000",
      "resource": "https://YOUR-DEPLOYMENT.example.com/join", "mimeType": "application/json",
      "maxTimeoutSeconds": 300, "description": "Join a live waitlist with a refundable hold…" },
    { "scheme": "exact", "network": "solana", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxAmountRequired": "10000",
      "resource": "https://YOUR-DEPLOYMENT.example.com/join", "mimeType": "application/json",
      "maxTimeoutSeconds": 300, "description": "Join a live waitlist with a refundable hold…" }
  ]
}
```

## Queue guidance for agents

- `GET /queues` is free — check `acceptingJoins` and `estimatedWaitMinutes` before spending anything.
- On `409 QUEUE_FULL`, pick another queue from `/queues` rather than retrying.
- Joining is **not idempotent**: two `POST /join` calls take two places. Record `ticketId` before retrying a network failure.
- Poll `GET /position/:token` freely — it costs nothing. A sensible cadence is every 30–60 seconds, or once the reported `eta.minutes` gets small.
- Watch `status` moving to `called`: you then have `graceMinutes` to appear before the venue may mark you a no-show, which forfeits the hold.
- If `refund.due` turns true, call `POST /claim/:token`. It is idempotent, so a retry is safe.
- `POST /leave/:token` as soon as plans change — leaving before being called always returns the hold and shortens the queue for everyone else.

## Verifying signatures

Signatures are HMAC-SHA256 (hex) over canonical JSON (sorted keys, `signature` excluded) using the server's `SIGNING_SECRET`. The position token is `base64url(canonical payload) + "." + signature`, so its `joinedAt` and `quotedEta` are tamper-evident: the venue cannot quietly re-quote your ETA, and you cannot claim you joined earlier than you did. Verify with the exported `verify()` in `src/sign.ts` if you share the secret, or treat the signature as a tamper-evidence tag issued by the venue.

## Contact

Questions, integration help, or a bug: **nichxbt@gmail.com** ·
[github.com/nirholas/x402-queue](https://github.com/nirholas/x402-queue)
