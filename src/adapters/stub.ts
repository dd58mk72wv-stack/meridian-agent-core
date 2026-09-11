/**
 * In-memory adapters, for proving logic before a client's real system is
 * connected.
 *
 * Every one of these announces itself. `name` begins with "stub:" and the
 * health view surfaces it, because the failure this guards against is not a
 * stub that breaks — it is a stub that WORKS, quietly, in production, while
 * somebody reads its invented availability as a real diary.
 *
 * They are also deliberately a bit awkward: the scheduling stub refuses to
 * double-book and the records stub will not invent a customer. A stub that says
 * yes to everything proves nothing about the logic built on top of it.
 */

import type {
  Adapters, Appointment, AppointmentSlot, Capabilities, CatalogueAdapter,
  CatalogueItem, CustomerRecord, KnowledgeAdapter, MessagingAdapter,
  PaymentAdapter, RecordsAdapter, SchedulingAdapter,
} from './types.js';
import { log } from '../core/logger.js';

export const STUB_PREFIX = 'stub:';

/** Is anything in this set of adapters still a stub? For the health view. */
export function stubbed(adapters: Adapters): string[] {
  return Object.values(adapters)
    .filter((a): a is { name: string } => Boolean(a) && typeof a === 'object' && 'name' in a)
    .map((a) => a.name)
    .filter((n) => n.startsWith(STUB_PREFIX));
}

const FULL: Capabilities = {
  readCustomers: true, writeCustomers: true,
  readAppointments: true, writeAppointments: true,
  readCatalogue: true,
};

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export function stubRecords(seed: CustomerRecord[] = []): RecordsAdapter {
  const customers = [...seed];

  return {
    name: `${STUB_PREFIX}records`,
    capabilities: () => FULL,

    findCustomer: async (query) => {
      const match = customers.find((c) =>
        (query.phone && c.phone === query.phone)
        || (query.email && c.email?.toLowerCase() === query.email.toLowerCase())
        || (query.name && c.name.toLowerCase() === query.name.toLowerCase()));
      // Null, not a fabricated record. An agent that is handed an invented
      // customer will address a stranger by someone else's name.
      return match ?? null;
    },

    createCustomer: async (input) => {
      const created: CustomerRecord = { id: nextId('cust'), ...input };
      customers.push(created);
      return created;
    },
  };
}

export function stubScheduling(options: {
  openHour?: number;
  closeHour?: number;
  slotMinutes?: number;
} = {}): SchedulingAdapter {
  const openHour = options.openHour ?? 9;
  const closeHour = options.closeHour ?? 17;
  const slotMinutes = options.slotMinutes ?? 30;
  const booked: Appointment[] = [];

  return {
    name: `${STUB_PREFIX}scheduling`,
    capabilities: () => FULL,

    availableSlots: async ({ from, to, limit = 5 }) => {
      const slots: AppointmentSlot[] = [];
      const probe = new Date(from);
      probe.setMinutes(Math.ceil(probe.getMinutes() / slotMinutes) * slotMinutes, 0, 0);

      while (probe < to && slots.length < limit) {
        const hour = probe.getHours();
        const day = probe.getDay();
        const end = new Date(probe.getTime() + slotMinutes * 60_000);

        const isWorking = day >= 1 && day <= 5 && hour >= openHour && hour < closeHour;
        const clash = booked.some((b) =>
          b.status === 'booked' && probe < b.end && end > b.start);

        if (isWorking && !clash) slots.push({ start: new Date(probe), end });
        probe.setTime(probe.getTime() + slotMinutes * 60_000);
      }
      return slots;
    },

    book: async (input) => {
      const end = new Date(input.start.getTime() + slotMinutes * 60_000);

      // Refuses to double-book on purpose. A stub that always says yes proves
      // nothing about the agent asking it.
      const clash = booked.find((b) =>
        b.status === 'booked' && input.start < b.end && end > b.start);
      if (clash) throw new Error('slot_taken');

      const appointment: Appointment = {
        id: nextId('appt'),
        customerId: input.customerId,
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        kind: input.kind,
        start: input.start,
        end,
        status: 'booked',
        ...(input.notes ? { notes: input.notes } : {}),
      };
      booked.push(appointment);
      return appointment;
    },

    cancel: async (appointmentId, reason) => {
      const found = booked.find((b) => b.id === appointmentId);
      if (!found) throw new Error('appointment_not_found');
      found.status = 'cancelled';
      if (reason) found.notes = `${found.notes ?? ''} cancelled: ${reason}`.trim();
    },

    reschedule: async (appointmentId, start) => {
      const found = booked.find((b) => b.id === appointmentId);
      if (!found) throw new Error('appointment_not_found');
      found.start = start;
      found.end = new Date(start.getTime() + slotMinutes * 60_000);
      return found;
    },

    cancellations: async (since) =>
      booked.filter((b) => b.status === 'cancelled' && b.start > since),
  };
}

export function stubCatalogue(items: CatalogueItem[] = []): CatalogueAdapter {
  return {
    name: `${STUB_PREFIX}catalogue`,
    search: async (query) => {
      const q = query.toLowerCase();
      return items.filter((i) => i.label.toLowerCase().includes(q));
    },
    get: async (id) => items.find((i) => i.id === id) ?? null,
  };
}

/**
 * Records what it would have sent, and sends nothing.
 *
 * The sent log is readable by tests. In production this adapter being active
 * means a client's reminders are going nowhere, which is exactly why its name
 * is surfaced on the health view.
 */
export function stubMessaging(): MessagingAdapter & { sent: { to: string; body: string }[] } {
  const sent: { to: string; body: string }[] = [];
  return {
    name: `${STUB_PREFIX}messaging`,
    sent,
    sendSms: async (to, body) => {
      sent.push({ to, body });
      log.info({ to, body }, 'stub SMS — nothing was actually sent');
      return true;
    },
    sendEmail: async (to, subject, body) => {
      sent.push({ to, body: `${subject}\n${body}` });
      log.info({ to, subject }, 'stub email — nothing was actually sent');
      return true;
    },
  };
}

export function stubPayments(): PaymentAdapter {
  return {
    name: `${STUB_PREFIX}payments`,
    createPaymentLink: async (input) => {
      const reference = nextId('pay');
      return { url: `https://example.invalid/pay/${reference}`, reference };
    },
    status: async () => 'pending',
  };
}

/**
 * Answers only from what it was given.
 *
 * Returns null for anything it does not hold, and that is the whole point: an
 * agent that cannot find the opening hours must say so, because a caller will
 * drive there on the answer.
 */
export function stubKnowledge(facts: Record<string, string> = {}): KnowledgeAdapter {
  return {
    name: `${STUB_PREFIX}knowledge`,
    lookup: async (question) => {
      const q = question.toLowerCase();
      for (const [key, answer] of Object.entries(facts)) {
        if (q.includes(key.toLowerCase())) return { answer, source: 'client knowledge base' };
      }
      return null;
    },
  };
}

/** A complete stubbed set, for tests and for a build before any client exists. */
export function stubAdapters(seed: {
  customers?: CustomerRecord[];
  catalogue?: CatalogueItem[];
  facts?: Record<string, string>;
} = {}): Adapters {
  return {
    records: stubRecords(seed.customers),
    scheduling: stubScheduling(),
    catalogue: stubCatalogue(seed.catalogue),
    messaging: stubMessaging(),
    payments: stubPayments(),
    knowledge: stubKnowledge(seed.facts),
  };
}
