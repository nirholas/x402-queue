/**
 * Per-route request/response schemas published in the x402 402 challenge.
 *
 * The x402scan discovery audit reads `accepts[0].outputSchema.input` and
 * `accepts[0].outputSchema.output` from the *runtime* 402 body, and runtime
 * behaviour is authoritative — so these must not contradict openapi.json.
 * They are generated from `public/openapi.json` ($refs inlined) and keyed
 * exactly like the paywall route map, so they can be spread straight into a
 * route declaration.
 *
 * Regenerate after editing openapi.json rather than hand-editing.
 *
 * `input` follows the x402 Bazaar convention: `{ type: "http", method, ... }`
 * with `pathParams`/`queryParams` for the URL and `bodyType`/`bodyFields` for
 * routes that take a JSON body. `output` is the 200 response schema.
 */

export type RouteSchema = {
  outputSchema: {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  };
};

export const ROUTE_SCHEMAS = {
  "POST /join": {
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        bodyFields: {
          queue: {
            type: "string",
            example: "dining-room"
          },
          name: {
            type: "string"
          },
          party: {
            type: "integer",
            minimum: 1,
            default: 1
          },
          contact: {
            type: "string",
            description: "Optional; shown to the operator only when your party is called"
          }
        },
        required: [
          "queue",
          "name"
        ]
      },
      output: {
        type: "object",
        description: "The purchased artifact, returned in the 200 body of POST /join.",
        properties: {
          ticketId: {
            type: "string"
          },
          token: {
            type: "string",
            description: "base64url(canonical payload) + '.' + hex HMAC-SHA256 — proves when you joined and what ETA you were quoted"
          },
          position: {
            type: "integer"
          },
          ahead: {
            type: "integer"
          },
          party: {
            type: "integer"
          },
          holder: {
            type: "string"
          },
          queue: {
            type: "object"
          },
          venue: {
            type: "string"
          },
          eta: {
            type: "object",
            properties: {
              minutes: {
                type: "integer"
              },
              at: {
                type: "string",
                format: "date-time"
              },
              basis: {
                type: "string"
              }
            }
          },
          graceMinutes: {
            type: "integer"
          },
          holdPolicy: {
            type: "object",
            properties: {
              joinPrice: {
                type: "string",
                example: "$0.01"
              },
              refundIfNotServedMinutes: {
                type: "integer",
                example: 30
              },
              description: {
                type: "string"
              }
            }
          },
          refundClaim: {
            type: "object",
            description: "A signed instrument, in the buyer's hands at join time — not a promise of one.",
            properties: {
              claimId: {
                type: "string"
              },
              ticketId: {
                type: "string"
              },
              amount: {
                type: "string"
              },
              reason: {
                type: "string"
              },
              claimableAfter: {
                type: "string",
                format: "date-time"
              },
              claimEndpoint: {
                type: "string"
              },
              signature: {
                type: "string"
              }
            }
          },
          positionUrl: {
            type: "string",
            format: "uri"
          },
          positionEndpoint: {
            type: "string"
          },
          leaveEndpoint: {
            type: "string"
          },
          joinedAt: {
            type: "string",
            format: "date-time"
          },
          signature: {
            type: "string"
          }
        }
      },
    },
  },
} satisfies Record<string, RouteSchema>;
