import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sign } from "./sign.js";
import { store } from "./store.js";
import { decodeToken, encodeToken } from "./token.js";
import type {
  QueueConfig,
  QueueDef,
  RefundClaim,
  Ticket,
  TicketPayload,
} from "./types.js";

const CONFIG_PATH = process.env.QUEUES_CONFIG ?? "config/queues.json";

export const config: QueueConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

export class QueueError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function findQueue(queueId: string): QueueDef | undefined {
  return config.queues.find((q) => q.id === queueId);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Minutes until a party at `aheadCount` positions gets called, given how many
 * servers work in parallel and how long one party takes.
 */
function etaMinutes(queue: QueueDef, aheadCount: number): number {
  const rounds = Math.floor(aheadCount / Math.max(1, queue.parallelServers));
  return rounds * queue.avgServeMinutes;
}

// ---- free GET /queues ------------------------------------------------------

/** The free board: every queue, its length, and its current wait. */
export function getQueues() {
  return {
    venue: config.venue,
    holdPolicy: config.holdPolicy,
    generatedAt: new Date().toISOString(),
    queues: config.queues.map((q) => {
      const waiting = store.waiting(q.id);
      const called = store.live(q.id).filter((t) => t.status === "called");
      return {
        id: q.id,
        name: q.name,
        description: q.description,
        open: q.open,
        avgServeMinutes: q.avgServeMinutes,
        parallelServers: q.parallelServers,
        maxLength: q.maxLength,
        graceMinutes: q.graceMinutes,
        waiting: waiting.length,
        beingServed: called.length,
        spaceLeft: Math.max(0, q.maxLength - waiting.length),
        estimatedWaitMinutes: etaMinutes(q, waiting.length),
        acceptingJoins: q.open && waiting.length < q.maxLength,
      };
    }),
  };
}

/** The free live board for one queue: anonymised, in order. */
export function getBoard(queueId: string) {
  const queue = findQueue(queueId);
  if (!queue) throw new QueueError(404, "UNKNOWN_QUEUE", `no queue "${queueId}" — see GET /queues`);
  const live = store.live(queueId);
  return {
    queueId,
    name: queue.name,
    open: queue.open,
    generatedAt: new Date().toISOString(),
    waiting: store.waiting(queueId).length,
    estimatedWaitMinutes: etaMinutes(queue, store.waiting(queueId).length),
    entries: live.map((t, i) => ({
      position: t.status === "waiting" ? i + 1 : null,
      // Only an initial — the board is public, the identity is not.
      holder: `${t.holder.slice(0, 1).toUpperCase()}.`,
      party: t.party,
      status: t.status,
      joinedAt: t.joinedAt,
      calledAt: t.calledAt,
    })),
  };
}

// ---- paid POST /join -------------------------------------------------------

export interface JoinRequest {
  queue?: string;
  name?: string;
  party?: number;
  contact?: string;
  payerWallet?: string;
  /** Absolute origin, used to build the position URL in the artifact. */
  baseUrl: string;
}

/**
 * The paid POST /join artifact: a signed queue-position token, the live
 * position and ETA at issue time, and a signed refund claim — all in the 200
 * body. Nothing here is a promise of a later delivery; the claim instrument
 * itself is the thing you bought.
 */
export function join(req: JoinRequest) {
  const queue = req.queue ? findQueue(req.queue) : undefined;
  if (!req.queue) throw new QueueError(400, "INVALID_QUEUE", "queue is required");
  if (!queue)
    throw new QueueError(404, "UNKNOWN_QUEUE", `no queue "${req.queue}" — see GET /queues`);
  if (!req.name || typeof req.name !== "string")
    throw new QueueError(400, "INVALID_NAME", "name is required");
  const party = req.party ?? 1;
  if (!Number.isInteger(party) || party < 1)
    throw new QueueError(400, "INVALID_PARTY", "party must be a positive integer");
  if (!queue.open)
    throw new QueueError(409, "QUEUE_CLOSED", `${queue.name} is not accepting anyone right now`);

  const ahead = store.waiting(queue.id).length;
  if (ahead >= queue.maxLength)
    throw new QueueError(
      409,
      "QUEUE_FULL",
      `${queue.name} is at capacity (${queue.maxLength} waiting) — see GET /queues for alternatives`,
    );

  const now = new Date();
  const waitMinutes = etaMinutes(queue, ahead);
  const quotedEta = new Date(now.getTime() + waitMinutes * 60_000).toISOString();
  const ticketId = id("tkt");

  const ticket: Ticket = {
    ticketId,
    queueId: queue.id,
    holder: req.name,
    party,
    contact: req.contact,
    payerWallet: req.payerWallet,
    status: "waiting",
    joinedAt: now.toISOString(),
    quotedEta,
    refundIssued: false,
  };
  store.add(ticket);

  const payload: TicketPayload = {
    ticketId,
    queueId: queue.id,
    holder: req.name,
    party,
    joinedAt: ticket.joinedAt,
    quotedEta,
    venue: config.venue.name,
  };
  const token = encodeToken(payload);

  const claimableAfter = new Date(
    Date.parse(quotedEta) + config.holdPolicy.refundIfNotServedMinutes * 60_000,
  ).toISOString();
  const claimBody = {
    claimId: id("clm"),
    ticketId,
    amount: config.holdPolicy.joinPrice,
    reason: `auto-refund if not served within ${config.holdPolicy.refundIfNotServedMinutes} minutes of the quoted ETA`,
    claimableAfter,
    claimEndpoint: `POST /claim/${token}`,
  };
  const refundClaim: RefundClaim = { ...claimBody, signature: sign(claimBody) };

  const artifact = {
    ticketId,
    token,
    position: ahead + 1,
    ahead,
    party,
    holder: req.name,
    queue: { id: queue.id, name: queue.name, description: queue.description },
    venue: config.venue.name,
    eta: {
      minutes: waitMinutes,
      at: quotedEta,
      basis: `${ahead} ahead, ${queue.parallelServers} server(s), ~${queue.avgServeMinutes} min each`,
    },
    graceMinutes: queue.graceMinutes,
    holdPolicy: config.holdPolicy,
    refundClaim,
    positionUrl: `${req.baseUrl}/position/${token}`,
    positionEndpoint: `GET /position/${token}`,
    leaveEndpoint: `POST /leave/${token}`,
    joinedAt: ticket.joinedAt,
  };
  return { ...artifact, signature: sign(artifact) };
}

/** Roll back a join — used when payment settlement fails after the fact. */
export function releaseTicket(ticketId: string): void {
  store.remove(ticketId);
}

// ---- free GET /position/:token --------------------------------------------

function resolveTicket(token: string): Ticket {
  const decoded = decodeToken(token);
  if (!decoded.valid || !decoded.payload)
    throw new QueueError(400, "BAD_TOKEN", decoded.reason ?? "invalid token");
  const ticket = store.get(decoded.payload.ticketId);
  if (!ticket)
    throw new QueueError(
      404,
      "TICKET_NOT_FOUND",
      "signature is good but this ticket is not on the list — it may have been rolled back",
    );
  return ticket;
}

/**
 * Live position, serve status and refund status. Free and pollable — this is
 * the pay-per-poll inverse: you paid once for the place in line, checking it is
 * free forever.
 */
export function getPosition(token: string) {
  const ticket = resolveTicket(token);
  const queue = findQueue(ticket.queueId)!;
  const live = store.live(ticket.queueId);
  const idx = live.findIndex((t) => t.ticketId === ticket.ticketId);
  const ahead = idx < 0 ? 0 : live.slice(0, idx).filter((t) => t.status === "waiting").length;

  const overdueBy = Math.max(
    0,
    Math.round((Date.now() - Date.parse(ticket.quotedEta)) / 60_000),
  );
  const refundDue = refundIsDue(ticket);

  return {
    ticketId: ticket.ticketId,
    queue: { id: queue.id, name: queue.name },
    venue: config.venue.name,
    holder: ticket.holder,
    party: ticket.party,
    status: ticket.status,
    position: ticket.status === "waiting" ? ahead + 1 : null,
    ahead: ticket.status === "waiting" ? ahead : null,
    eta:
      ticket.status === "waiting"
        ? {
            minutes: etaMinutes(queue, ahead),
            at: new Date(Date.now() + etaMinutes(queue, ahead) * 60_000).toISOString(),
            quotedAtJoin: ticket.quotedEta,
          }
        : null,
    calledAt: ticket.calledAt,
    servedAt: ticket.servedAt,
    closedAt: ticket.closedAt,
    closedReason: ticket.closedReason,
    overdueByMinutes: overdueBy,
    refund: {
      issued: ticket.refundIssued,
      due: refundDue.due,
      reason: ticket.refundReason ?? refundDue.reason,
      claimableAfter: new Date(
        Date.parse(ticket.quotedEta) + config.holdPolicy.refundIfNotServedMinutes * 60_000,
      ).toISOString(),
      amount: config.holdPolicy.joinPrice,
    },
    holdPolicy: config.holdPolicy,
    checkedAt: new Date().toISOString(),
  };
}

/** Is the hold owed back right now? */
function refundIsDue(ticket: Ticket): { due: boolean; reason: string } {
  if (ticket.refundIssued) return { due: false, reason: "already refunded" };
  if (ticket.status === "served") return { due: true, reason: "served — the hold is returned" };
  if (ticket.status === "left")
    return { due: true, reason: "left the queue before being called — the hold is returned" };
  if (ticket.status === "no-show")
    return { due: false, reason: "did not show up when called — the hold is forfeited" };
  const deadline =
    Date.parse(ticket.quotedEta) + config.holdPolicy.refundIfNotServedMinutes * 60_000;
  if (Date.now() >= deadline)
    return {
      due: true,
      reason: `not served within ${config.holdPolicy.refundIfNotServedMinutes} minutes of the quoted ETA — the hold is returned`,
    };
  return { due: false, reason: "still in line and inside the promised window" };
}

// ---- free POST /claim/:token, POST /leave/:token ---------------------------

/**
 * Exercise the refund claim. Free, idempotent, and authenticated by the token
 * itself — the claim instrument was already in the buyer's hands at join time.
 */
export function claimRefund(token: string) {
  const ticket = resolveTicket(token);
  const due = refundIsDue(ticket);
  if (ticket.refundIssued) {
    return {
      ticketId: ticket.ticketId,
      refunded: true,
      alreadyIssued: true,
      amount: config.holdPolicy.joinPrice,
      reason: ticket.refundReason,
      wallet: ticket.payerWallet,
      issuedAt: ticket.closedAt,
    };
  }
  if (!due.due)
    throw new QueueError(409, "REFUND_NOT_DUE", due.reason);

  ticket.refundIssued = true;
  ticket.refundReason = due.reason;
  if (ticket.status === "waiting" || ticket.status === "called") {
    ticket.status = "refunded";
    ticket.closedAt = new Date().toISOString();
    ticket.closedReason = due.reason;
  }
  store.update(ticket);

  const record = {
    ticketId: ticket.ticketId,
    queueId: ticket.queueId,
    refunded: true,
    amount: config.holdPolicy.joinPrice,
    reason: due.reason,
    wallet: ticket.payerWallet,
    issuedAt: new Date().toISOString(),
  };
  return { ...record, signature: sign(record) };
}

/** Free POST /leave/:token — give up your place; the hold is returned. */
export function leave(token: string) {
  const ticket = resolveTicket(token);
  if (["served", "no-show", "left", "refunded"].includes(ticket.status))
    throw new QueueError(409, "ALREADY_CLOSED", `ticket is already ${ticket.status}`);
  ticket.status = "left";
  ticket.closedAt = new Date().toISOString();
  ticket.closedReason = "left the queue voluntarily";
  ticket.refundIssued = true;
  ticket.refundReason = "left the queue before being called — the hold is returned";
  store.update(ticket);
  const record = {
    ticketId: ticket.ticketId,
    queueId: ticket.queueId,
    status: "left" as const,
    refunded: true,
    amount: config.holdPolicy.joinPrice,
    reason: ticket.refundReason,
    leftAt: ticket.closedAt,
  };
  return { ...record, signature: sign(record) };
}

// ---- free operator routes --------------------------------------------------

/** Free POST /call-next/:queueId — front-of-house calls the next party. */
export function callNext(queueId: string) {
  const queue = findQueue(queueId);
  if (!queue) throw new QueueError(404, "UNKNOWN_QUEUE", `no queue "${queueId}"`);
  const next = store.waiting(queueId)[0];
  if (!next) throw new QueueError(409, "QUEUE_EMPTY", `nobody is waiting in ${queue.name}`);
  next.status = "called";
  next.calledAt = new Date().toISOString();
  store.update(next);
  return {
    queueId,
    called: {
      ticketId: next.ticketId,
      holder: next.holder,
      party: next.party,
      contact: next.contact,
      calledAt: next.calledAt,
      graceMinutes: queue.graceMinutes,
    },
    stillWaiting: store.waiting(queueId).length,
  };
}

/** Free POST /serve/:ticketId — mark a called party served; the hold returns. */
export function serve(ticketId: string) {
  const ticket = store.get(ticketId);
  if (!ticket) throw new QueueError(404, "TICKET_NOT_FOUND", `no ticket ${ticketId}`);
  if (ticket.status === "served")
    throw new QueueError(409, "ALREADY_SERVED", "ticket is already served");
  if (!["waiting", "called"].includes(ticket.status))
    throw new QueueError(409, "ALREADY_CLOSED", `ticket is ${ticket.status}`);
  ticket.status = "served";
  ticket.servedAt = new Date().toISOString();
  ticket.closedAt = ticket.servedAt;
  ticket.closedReason = "served";
  ticket.refundIssued = true;
  ticket.refundReason = "served — the hold is returned";
  store.update(ticket);
  const record = {
    ticketId,
    queueId: ticket.queueId,
    status: "served" as const,
    servedAt: ticket.servedAt,
    refunded: true,
    amount: config.holdPolicy.joinPrice,
    reason: ticket.refundReason,
  };
  return { ...record, signature: sign(record) };
}

/** Free POST /no-show/:ticketId — called but never appeared; hold forfeited. */
export function noShow(ticketId: string) {
  const ticket = store.get(ticketId);
  if (!ticket) throw new QueueError(404, "TICKET_NOT_FOUND", `no ticket ${ticketId}`);
  if (ticket.status !== "called")
    throw new QueueError(
      409,
      "NOT_CALLED",
      `only a called party can be a no-show (ticket is ${ticket.status})`,
    );
  const queue = findQueue(ticket.queueId)!;
  const graceEnds = Date.parse(ticket.calledAt!) + queue.graceMinutes * 60_000;
  if (Date.now() < graceEnds)
    throw new QueueError(
      409,
      "GRACE_PERIOD",
      `give them the full ${queue.graceMinutes} minutes — grace ends at ${new Date(graceEnds).toISOString()}`,
    );
  ticket.status = "no-show";
  ticket.closedAt = new Date().toISOString();
  ticket.closedReason = "did not show up when called";
  ticket.refundReason = "did not show up when called — the hold is forfeited";
  store.update(ticket);
  const record = {
    ticketId,
    queueId: ticket.queueId,
    status: "no-show" as const,
    closedAt: ticket.closedAt,
    refunded: false,
    reason: ticket.refundReason,
  };
  return { ...record, signature: sign(record) };
}
