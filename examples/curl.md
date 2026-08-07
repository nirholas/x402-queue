# Raw HTTP walkthrough: 402 → pay → 200

x402 is plain HTTP. Here is the exact wire flow with `curl` against a local
server (`npm run dev` — it ships with working default receive addresses).

## 1. Seeing the wait is free

```bash
curl -s http://localhost:4025/queues \
  | jq '.queues[] | {id, waiting, estimatedWaitMinutes, acceptingJoins}'

curl -s http://localhost:4025/queues/dining-room | jq
curl -s http://localhost:4025/.well-known/x402 | jq
```

The board is the shop window. Holding a place is what costs.

## 2. Calling the paid route without payment → HTTP 402

```bash
curl -si -X POST http://localhost:4025/join \
  -H 'content-type: application/json' \
  -d '{"queue":"dining-room","name":"Ada","party":2}'
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

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
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
      "maxTimeoutSeconds": 300,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "rpcUrl": "https://api.mainnet-beta.solana.com" }
    }
  ]
}
```

Two entries, two rails: **USDC on Base** and **USDC on Solana**. `10000` is
0.01 USDC in atomic units (6 decimals). Pick one, ignore the other.

```bash
# just the rails:
curl -s -X POST http://localhost:4025/join | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

## 3. Pay: sign the requirement, retry with X-PAYMENT

**Base rail:** the client signs an EIP-3009 `transferWithAuthorization` for the
amount in the `base-sepolia` entry and base64-encodes the signed payload into one
header.

**Solana rail:** the client builds an SPL `transferChecked` of `10000` USDC
atomic units to the `solana` entry's `payTo`, signs the serialized transaction,
and base64-encodes that envelope into the same header.

Either way it is one header. Doing it by hand is miserable — use the client
instead:

```bash
PRIVATE_KEY=0x... npm run client        # runs examples/agent-client.ts
```

Under the hood it retries:

```
POST /join
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLC...
Content-Type: application/json

{"queue":"dining-room","name":"Ada Lovelace","party":2}
```

## 4. 200 + the ticket + settlement receipt

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4YWJjLi4uIiwibmV0d29yayI6ImJhc2Utc2Vwb2xpYSJ9
Content-Type: application/json

{
  "ticketId": "tkt_1a2b3c4d5e6f",
  "token": "eyJob2xkZXIiOiJBZGEi….a91f…",
  "position": 8,
  "ahead": 7,
  "eta": { "minutes": 36, "at": "2026-08-07T18:36:00.000Z", "basis": "7 ahead, 2 server(s), ~12 min each" },
  "refundClaim": {
    "claimId": "clm_9f8e7d6c5b4a",
    "amount": "$0.01",
    "reason": "auto-refund if not served within 30 minutes of the quoted ETA",
    "claimableAfter": "2026-08-07T19:06:00.000Z",
    "claimEndpoint": "POST /claim/<token>",
    "signature": "…"
  },
  "positionUrl": "http://localhost:4025/position/eyJob2xkZXIi….a91f…",
  "signature": "…"
}
```

`X-PAYMENT-RESPONSE` base64-decodes to the settlement result — `{ success,
transaction, network, payer }`. The `network` field tells you which rail actually
settled.

Note what came back: a signed **token** (proof of when you joined and what you
were promised) and a signed **refund claim** (proof of what you are owed if that
promise is missed). Both instruments are in hand *now* — nothing is deferred.

Settlement runs *after* the handler succeeds: if the queue filled up in the
meantime you get `409 QUEUE_FULL` and no money moves.

## 5. Checking your position is free

```bash
TOKEN=$(jq -r .token ticket.json)

curl -s "http://localhost:4025/position/$TOKEN" \
  | jq '{status, position, ahead, eta, refund}'
```

Poll it every 30 seconds if you like — it costs nothing. You paid once for the
place in line, not for the right to look at it.

Tamper with one character and the token stops validating:

```bash
curl -s "http://localhost:4025/position/${TOKEN%??}ff" | jq
# {"error":"BAD_TOKEN","message":"signature does not match — token was altered or forged"}
```

## 6. The operator side (free)

```bash
# front of house calls the next party:
curl -s -X POST http://localhost:4025/call-next/dining-room | jq

# they turned up:
curl -s -X POST http://localhost:4025/serve/tkt_XXXX | jq

# they didn't (refused until the full grace period has elapsed):
curl -s -X POST http://localhost:4025/no-show/tkt_XXXX | jq
```

## 7. Refunds and leaving

```bash
# give up your place — the hold is returned, the queue closes up behind you:
curl -s -X POST "http://localhost:4025/leave/$TOKEN" | jq

# exercise the claim (idempotent; refused with the reason if not yet due):
curl -s -X POST "http://localhost:4025/claim/$TOKEN" | jq
```

The hold is **due back** when you were served, when you left before being called,
or when the venue missed your quoted ETA by more than
`refundIfNotServedMinutes`. It is **forfeited** only when you were called and did
not show up.
