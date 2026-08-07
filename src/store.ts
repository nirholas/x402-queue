import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Ticket } from "./types.js";

/**
 * File-backed persistence. Tickets live in data/tickets.json so a restart never
 * loses someone's place in line. No database required.
 */

const DATA_DIR = process.env.DATA_DIR ?? "data";
const TICKETS_FILE = `${DATA_DIR}/tickets.json`;

function load<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // corrupt file — start fresh rather than crash
  }
  return fallback;
}

function save(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Still in line: waiting to be called, or called and not yet resolved. */
const LIVE: Ticket["status"][] = ["waiting", "called"];

export class Store {
  private tickets: Ticket[] = load<Ticket[]>(TICKETS_FILE, []);

  all(): Ticket[] {
    return this.tickets;
  }

  get(ticketId: string): Ticket | undefined {
    return this.tickets.find((t) => t.ticketId === ticketId);
  }

  /** Everyone still in the given queue, oldest first. */
  live(queueId: string): Ticket[] {
    return this.tickets
      .filter((t) => t.queueId === queueId && LIVE.includes(t.status))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  waiting(queueId: string): Ticket[] {
    return this.live(queueId).filter((t) => t.status === "waiting");
  }

  add(t: Ticket): void {
    this.tickets.push(t);
    save(TICKETS_FILE, this.tickets);
  }

  update(t: Ticket): void {
    const i = this.tickets.findIndex((x) => x.ticketId === t.ticketId);
    if (i >= 0) this.tickets[i] = t;
    save(TICKETS_FILE, this.tickets);
  }

  /** Used to roll back a join when payment settlement fails. */
  remove(ticketId: string): void {
    this.tickets = this.tickets.filter((t) => t.ticketId !== ticketId);
    save(TICKETS_FILE, this.tickets);
  }
}

export const store = new Store();
