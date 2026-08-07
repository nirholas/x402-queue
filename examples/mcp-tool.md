# Exposing x402-queue as an MCP tool for Claude

Model Context Protocol (MCP) lets Claude call this waitlist server as a native
tool. The pattern: an MCP server wraps the one paid endpoint with `x402-fetch`,
so joining pays automatically from the agent's wallet. Everything else — the
board, the position check, the refund claim — is free and needs no wallet.

This shape suits an assistant unusually well: it can watch a queue for free,
join once when the wait is acceptable, and then poll the position as often as it
likes without spending another cent.

The server quotes both rails in every 402 (USDC on Base and USDC on Solana);
`x402-fetch` settles the Base entry. To have the MCP server pay on Solana
instead, swap the wrapper for your own Solana signer — see
[`agent-client.ts`](agent-client.ts) for the exact envelope.

## Minimal MCP server (`mcp-server.ts`)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.QUEUE_URL ?? "http://localhost:4025";
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

const server = new McpServer({ name: "queue", version: "0.1.0" });

server.tool(
  "check_waits",
  "See every queue with its live length and estimated wait (free — no payment)",
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/queues`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "join_queue",
  "Hold a place in line for $0.01 USDC via x402. Returns a signed position token, the position and ETA, and a signed refund claim. Keep the token — it is the ticket.",
  {
    queue: z.string(),
    name: z.string(),
    party: z.number().optional(),
    contact: z.string().optional(),
  },
  async (args) => {
    const res = await payFetch(`${BASE_URL}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "check_position",
  "Live position, ETA, serve status and refund status for a ticket (free — poll freely)",
  { token: z.string() },
  async ({ token }) => {
    const res = await fetch(`${BASE_URL}/position/${token}`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "claim_refund",
  "Exercise the refund claim on a ticket (free, idempotent). Due when served, when you left before being called, or when the quoted ETA was missed.",
  { token: z.string() },
  async ({ token }) => {
    const res = await fetch(`${BASE_URL}/claim/${token}`, { method: "POST" });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "leave_queue",
  "Give up your place; the hold is returned (free)",
  { token: z.string() },
  async ({ token }) => {
    const res = await fetch(`${BASE_URL}/leave/${token}`, { method: "POST" });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

Dependencies: `npm i @modelcontextprotocol/sdk x402-fetch viem zod`

Questions: **nichxbt@gmail.com**

## claude_desktop_config.json

```json
{
  "mcpServers": {
    "queue": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server.ts"],
      "env": {
        "QUEUE_URL": "http://localhost:4025",
        "PRIVATE_KEY": "0x...funded base-sepolia key"
      }
    }
  }
}
```

Claude can then be asked: *"Get us on the walk-in list if the wait is under half
an hour, and tell me when we're close"* — it checks the board for free, joins
only if the ETA passes the test, and polls the position at no further cost until
the status turns `called`.

## Watching without burning budget

`check_position` is free, so an assistant can poll it on a timer. A reasonable
loop:

1. `check_waits` → pick a queue where `acceptingJoins` and the ETA is acceptable.
2. `join_queue` → store `token`, `ticketId`, `graceMinutes`,
   `refundClaim.claimableAfter`.
3. `check_position` every 30–60 seconds, tightening as `eta.minutes` shrinks.
4. When `status` becomes `called`, tell the user immediately — they have
   `graceMinutes` before a no-show forfeits the hold.
5. If `refund.due` turns true, `claim_refund` (idempotent, so retries are safe).

## Spending safety

Give the MCP wallet a small, dedicated balance. `wrapFetchWithPayment` accepts a
`maxValue` (base units) to hard-cap what a single call may spend; combine with
per-session budgets in your agent framework. Because settlement is deferred until
the route returns `2xx`, a full queue never draws down that budget.

Joining is **not idempotent** — two `join_queue` calls take two places. Record
`ticketId` before retrying a network failure.
