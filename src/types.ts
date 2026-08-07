/** Shared types for x402-queue. */

export interface VenueInfo {
  name: string;
  description: string;
  timezone: string;
  address: string;
  phone: string;
}

export interface QueueDef {
  id: string;
  name: string;
  description: string;
  /** Average minutes one server takes to handle one party. */
  avgServeMinutes: number;
  /** How many parties can be served concurrently. */
  parallelServers: number;
  /** Refuse joins beyond this many waiting parties. */
  maxLength: number;
  /** Minutes a called party has to show up before they are a no-show. */
  graceMinutes: number;
  open: boolean;
}

export interface HoldPolicy {
  joinPrice: string;
  /** Auto-refund if not served this many minutes past the quoted ETA. */
  refundIfNotServedMinutes: number;
  description: string;
}

export interface QueueConfig {
  venue: VenueInfo;
  queues: QueueDef[];
  holdPolicy: HoldPolicy;
}

export type TicketStatus =
  | "waiting"
  | "called"
  | "served"
  | "no-show"
  | "left"
  | "refunded";

export interface Ticket {
  ticketId: string;
  queueId: string;
  holder: string;
  party: number;
  contact?: string;
  payerWallet?: string;
  status: TicketStatus;
  joinedAt: string;
  /** ETA quoted at join time — the reference point for the auto-refund. */
  quotedEta: string;
  calledAt?: string;
  servedAt?: string;
  closedAt?: string;
  /** Reason the ticket left the queue, for the audit trail. */
  closedReason?: string;
  refundIssued: boolean;
  refundReason?: string;
}

/** The signed payload inside a queue-position token. */
export interface TicketPayload {
  ticketId: string;
  queueId: string;
  holder: string;
  party: number;
  joinedAt: string;
  quotedEta: string;
  venue: string;
}

/**
 * A signed, self-contained promise: if the venue has not served this ticket by
 * `claimableAfter`, the holder is owed the hold back. Returned at join time so
 * the buyer leaves with the instrument in hand, not a promise of one.
 */
export interface RefundClaim {
  claimId: string;
  ticketId: string;
  amount: string;
  reason: string;
  claimableAfter: string;
  claimEndpoint: string;
  signature: string;
}
