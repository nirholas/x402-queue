# API reference

Base URL: your deployment (default `http://localhost:4025`). Machine-readable
spec: [`openapi.json`](https://github.com/nirholas/x402-queue/blob/main/openapi.json).
Only one route is paid — joining. Seeing the wait, checking your position,
claiming your refund and leaving are all free. The paid route returns
`402 Payment Required` until called with a valid `X-PAYMENT` header, and its
successful response carries an `X-PAYMENT-RESPONSE` settlement receipt header.

---

## GET /queues — free

Every queue with its live length and current wait.

**200**

```json
{
  "venue": { "name": "402 Walk-ins", "timezone": "America/New_York", "address": "402 Payment Ave" },
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
`acceptingJoins` is false when the queue is closed or at `maxLength`.

## GET /queues/:queueId — free

The live board for one queue. Names are reduced to an initial — the board is
public, the identities are not.

```json
{
  "queueId": "dining-room",
  "name": "Dining room walk-in list",
  "open": true,
  "waiting": 3,
  "estimatedWaitMinutes": 12,
  "generatedAt": "2026-08-07T18:00:00.000Z",
  "entries": [
    { "position": 1, "holder": "A.", "party": 2, "status": "waiting", "joinedAt": "…" },
    { "position": null, "holder": "B.", "party": 4, "status": "called", "joinedAt": "…", "calledAt": "…" }
  ]
}
```

**Errors**: `404 UNKNOWN_QUEUE`.

---

## POST /join — $0.01 (refundable hold)

**Body**

```json
{ "queue": "dining-room", "name": "Ada Lovelace", "party": 2, "contact": "+15550402402" }
```

| Field | Required | Notes |
|---|---|---|
| `queue` | yes | Queue id from `/queues`. |
| `name` | yes | Shown to the operator when your party is called. |
| `party` | no | Positive integer, defaults to 1. |
| `contact` | no | Only surfaced to the operator at call time. |

**200 — the purchased artifact**

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
  "eta": { "minutes": 36, "at": "2026-08-07T18:36:00.000Z", "basis": "7 ahead, 2 server(s), ~12 min each" },
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
  "positionUrl": "https://queue.example.com/position/<token>",
  "positionEndpoint": "GET /position/<token>",
  "leaveEndpoint": "POST /leave/<token>",
  "joinedAt": "2026-08-07T18:00:00.000Z",
  "signature": "hex HMAC-SHA256"
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_QUEUE` / `INVALID_NAME` / `INVALID_PARTY` | malformed body |
| 402 | — | payment missing/invalid |
| 404 | `UNKNOWN_QUEUE` | no such queue id |
| 409 | `QUEUE_CLOSED` | the queue is not accepting anyone |
| 409 | `QUEUE_FULL` | at `maxLength` waiting |

None of the `4xx` cases charge the caller: settlement is deferred until the
handler returns `2xx`.

---

## GET /position/:token — free

Live position, serve status and refund status. **Free and pollable** — you paid
once for the place in line, not for the right to look at it.

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
  "closedAt": null,
  "closedReason": null,
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

`status` is one of:

| Status | Meaning | Hold |
|---|---|---|
| `waiting` | in line | held |
| `called` | your turn — `graceMinutes` to appear | held |
| `served` | seen | returned |
| `left` | you gave up your place | returned |
| `no-show` | called and never appeared | forfeited |
| `refunded` | claim exercised while still in line | returned |

`position` and `eta` are `null` once you are no longer `waiting`.

**Errors**: `400 BAD_TOKEN` (malformed, altered, or forged), `404 TICKET_NOT_FOUND`.

---

## POST /claim/:token — free

Exercise the refund claim. Idempotent, and authenticated by the token itself —
the instrument was handed over at join time.

The hold is **due back** when you were served, when you left before being called,
or when the venue missed the quoted ETA by more than `refundIfNotServedMinutes`.
It is **forfeited** only when you were called and did not show up.

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

A repeat call returns the same record with `alreadyIssued: true`.

**Errors**: `409 REFUND_NOT_DUE` (message carries the reason), `400 BAD_TOKEN`,
`404 TICKET_NOT_FOUND`.

## POST /leave/:token — free

Give up your place. The hold is returned and the queue closes up behind you.

**Errors**: `409 ALREADY_CLOSED`, `400 BAD_TOKEN`, `404 TICKET_NOT_FOUND`.

---

## Operator routes (free)

Front of house, or your POS integration.

| Route | Effect |
|---|---|
| `POST /call-next/:queueId` | Calls the oldest waiting party. Returns their name, party size, `contact`, and `graceMinutes`. `409 QUEUE_EMPTY` if nobody is waiting. |
| `POST /serve/:ticketId` | Marks a called party served; the hold is returned. `409 ALREADY_SERVED` / `409 ALREADY_CLOSED`. |
| `POST /no-show/:ticketId` | Called but never appeared; the hold is forfeited. `409 NOT_CALLED` if they were never called, and `409 GRACE_PERIOD` until the full `graceMinutes` has elapsed — nobody can be written off early. |

## Other free routes

| Route | Returns |
|---|---|
| `GET /info` | venue profile, hold policy, prices, payment rails |
| `GET /health` | liveness |
| `GET /.well-known/x402` | x402 discovery manifest (resources, prices, schemas, both rails) |

---

## 402 response shape

The paid route answers an unpaid request with a `402` whose `accepts` array
carries **both payment rails**. Pick one, sign it, retry with `X-PAYMENT`.

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4025/join",
      "description": "Join a live waitlist with a refundable hold…",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4025/join",
      "description": "Join a live waitlist with a refundable hold…",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 300,
      "extra": { "rpcUrl": "https://api.mainnet-beta.solana.com" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `network` | `base-sepolia`/`base` = EVM rail; `solana`/`solana-devnet` = SVM rail |
| `maxAmountRequired` | price in atomic USDC units (6 decimals) — `10000` = $0.01 |
| `asset` | USDC contract address (EVM) or SPL mint (Solana) |
| `payTo` | merchant receive address on that network |
| `extra` | EVM: the EIP-712 domain to sign against. Solana: the RPC to build against. |

Configure the rails with `NETWORK` / `PAY_TO_ADDRESS` / `FACILITATOR_URL` (EVM)
and `SOLANA_NETWORK` / `SOLANA_PAY_TO_ADDRESS` / `SOLANA_RPC_URL` /
`SOLANA_FACILITATOR_URL` (Solana). Each rail settles through its own facilitator
because no public one handles both chains. Drop an address and that rail is
omitted from every challenge.

## Settlement receipt

A successful paid call returns `X-PAYMENT-RESPONSE`: base64 JSON of
`{ success, transaction, network, payer }`. `network` tells you which rail
settled. Settlement is deferred until the handler returns `2xx` — an error
response (e.g. `409 QUEUE_FULL`) never moves funds.

## Contact

**nichxbt@gmail.com** · [issues](https://github.com/nirholas/x402-queue/issues)
