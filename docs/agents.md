# For AI agents

x402-queue is built agent-first: no signup, no API key, no SMS loop. Seeing the
wait is free, so an agent can watch a line indefinitely for nothing; it spends
once, when it decides to hold a place — and checking that place afterwards is
free forever.

## Discovery

Two machine-readable entry points, both free:

1. **`GET /.well-known/x402`** — the x402 manifest: the paid resource, its price,
   both `accepts` rails, output schema, plus every free route. This is the format
   indexed by [x402scan.com](https://x402scan.com), the x402 Bazaar, and
   [agentic.market](https://agentic.market).
2. **[`skill.md`](https://github.com/nirholas/x402-queue/blob/main/skill.md)**
   (repo root) — a prose+schema skill file (the agentres.dev pattern) an LLM can
   read directly to learn endpoints, prices, request shapes, and error codes.

Recommended agent bootstrap: fetch `/.well-known/x402`, feed `skill.md` into
context, read `GET /queues` (free), then join.

## Protocol version

This service speaks **x402 v1**. Every challenge is
`{ x402Version: 1, error, accepts: [...] }`, and each `accepts[]` entry carries
`outputSchema.input` (how to call the route) and `outputSchema.output` (what
comes back), generated from `openapi.json` so the two can never drift.

Discovery audits flag v1 as the older wire format; that is expected. x402 **v2**
— payment options under `extensions.bazaar.schema` and CAIP-2 network ids — is a
planned upgrade for agentcash compatibility. It is not adopted yet because the
v2 challenge shape would break the v1 `x402-fetch` clients this repo ships as
working examples.

## Why the artifact is a claim, not a promise

A queue is the classic "pay now, get served later" shape, which the x402 suite's
contract forbids: every paid route must return the thing you bought in the 200
body. This service resolves that by handing over **instruments**:

- a **signed position token** — proof of when you joined and what ETA you were
  quoted, tamper-evident in both directions;
- a **signed refund claim** — proof of what you are owed if that ETA is blown by
  more than the policy window, with its own `claimId` and `claimableAfter`.

Both are in your hands before the response closes. `POST /claim/:token` later is
just exercising an instrument you already hold, and it is free.

## Two payment rails

The paid route answers an unpaid request with a `402` whose `accepts` array holds
**both** rails. Your agent picks whichever it can settle:

| Rail | `network` | Asset | payTo | How the client signs |
|---|---|---|---|---|
| EVM | `base-sepolia` (default) / `base` | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | EIP-3009 `transferWithAuthorization` — pure client-side signature |
| Solana | `solana` (default) / `solana-devnet` | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | SPL `transferChecked`, signed as a serialized transaction |

Each rail is verified and settled by its own facilitator — no public facilitator
settles both chains, so the EVM rail defaults to `https://x402.org/facilitator`
and the Solana rail to `https://facilitator.payai.network` (both overridable).
The `X-PAYMENT-RESPONSE` receipt names the rail the payment actually settled on.
Ignore the entry you can't pay; the server does not care which one you choose.

Settlement is deferred until the handler returns `2xx`, so a join that fails
(`409 QUEUE_FULL`) costs your agent nothing.

## Paying

Any x402 client works. With `x402-fetch` (EVM rail):

```ts
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(KEY));
const res = await payFetch(`${BASE}/join`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ queue: "dining-room", name: "Agent Ada", party: 2 }),
});
const ticket = await res.json();                          // token + eta + refundClaim
const receipt = decodeXPaymentResponse(res.headers.get("x-payment-response")!);

// everything after this is free
const pos = await fetch(ticket.positionUrl).then((r) => r.json());
```

The client handles the 402 → sign → retry loop automatically. Cap per-call spend
with the `maxValue` argument.

On the **Solana rail**, pick the `accepts[]` entry whose `network` starts with
`solana`, build an SPL `transferChecked` to its `payTo` for `maxAmountRequired`
atomic units of the `asset` mint (USDC, 6 decimals), sign it, and send the base64
x402 envelope in `X-PAYMENT`. Browser agents can reuse the checkout helper this
server mounts at `POST /api/x402-checkout?action=prepare` (build) and
`?action=encode` (wrap) — see
[`examples/agent-client.ts`](https://github.com/nirholas/x402-queue/blob/main/examples/agent-client.ts).

## What you get back (and should persist)

| Field | Why it matters |
|---|---|
| `token` | **the ticket** — a bearer credential; whoever holds it can check, claim, or leave |
| `ticketId` | canonical reference, and what the operator routes take |
| `eta.quotedAtJoin` | the promise the refund clock runs against |
| `refundClaim.claimableAfter` | when `POST /claim/:token` starts succeeding |
| `graceMinutes` | how long the holder has to appear once `status` turns `called` |
| `positionUrl` | a ready-made free status link, handy to hand to a human |
| `signature` | venue HMAC over the artifact — dispute evidence |
| `X-PAYMENT-RESPONSE` header | settlement receipt (tx hash/signature + network) — your proof of payment, on either rail |

Treat `token` like a ticket stub: it is a bearer credential, so keep it out of
shared transcripts.

## Polling policy

`GET /position/:token` is free and cheap. A sensible loop:

1. `GET /queues` → pick a queue where `acceptingJoins` and the ETA is acceptable.
2. `POST /join` → store `token`, `ticketId`, `graceMinutes`,
   `refundClaim.claimableAfter`.
3. `GET /position/:token` every 30–60 seconds, tightening as `eta.minutes`
   shrinks.
4. When `status` becomes `called`, surface it to the user **immediately** — the
   grace window is short and a no-show forfeits the hold.
5. If `refund.due` turns true, `POST /claim/:token`. It is idempotent, so retries
   are safe.

## Queue policy for agents

- On `409 QUEUE_FULL` or `409 QUEUE_CLOSED`, pick another queue from `/queues`
  rather than retrying.
- Joining is **not idempotent**: two `POST /join` calls take two places. Record
  `ticketId` before retrying a network failure.
- `POST /leave/:token` as soon as plans change — leaving before being called
  always returns the hold and shortens the line for everyone else.
- The refund rules are worth stating to a user before spending: served → refund,
  left → refund, venue missed the ETA → refund, called-and-absent → forfeit.

## MCP integration

Expose the service as Claude tools (`check_waits`, `join_queue`,
`check_position`, `claim_refund`, `leave_queue`) with the wrapper in
[`examples/mcp-tool.md`](https://github.com/nirholas/x402-queue/blob/main/examples/mcp-tool.md),
including a `claude_desktop_config.json` snippet and a polling loop that costs
nothing after the join.

## Listing your deployment

Running a public instance? Get discovered:

- **x402scan.com** — indexes services exposing `/.well-known/x402`; submit your
  base URL.
- **x402 Bazaar** — the facilitator-side discovery list; keep the manifest's
  resource description and output schema accurate so listings are useful.
- **agentic.market** — agent-service marketplace; list the base URL and point at
  `skill.md`.

Set `PUBLIC_BASE_URL` so `positionUrl` resolves to your public origin, and keep
the manifest served over HTTPS — indexers and agents will refuse plaintext
payment endpoints.

## Contact

**nichxbt@gmail.com**
