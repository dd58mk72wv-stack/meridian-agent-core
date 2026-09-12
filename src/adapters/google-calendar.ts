/**
 * Google Calendar, as a client's real diary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 *
 * `stubScheduling()` — which invents availability. The stub announces itself
 * (`stub:scheduling`) and the health view surfaces it, because the failure
 * being guarded against is not a stub that breaks but a stub that WORKS,
 * quietly, in production, while somebody reads its invented availability as a
 * real diary. This is the thing that makes that unnecessary.
 * ---------------------------------------------------------------------------
 *
 * CREDENTIALS ARE PER CLIENT. Every argument comes in through `config`; nothing
 * here reads `process.env`. A dental practice's diary and a dealership's diary
 * are different Google accounts, and an adapter that reached for a shared
 * ambient credential would book one client's appointment into another's
 * calendar the first time two systems ran in one process.
 *
 * IT CLAIMS ONLY WHAT IT IS. `capabilities()` reports appointments read and
 * write, and customers and catalogue false. A calendar is not a patient record
 * and not a price list. An adapter that claimed otherwise would be discovered
 * halfway through a live call, which is exactly what the capability declaration
 * exists to prevent.
 */

import { google, type calendar_v3 } from 'googleapis';

import type {
  Appointment, AppointmentSlot, Capabilities, SchedulingAdapter,
} from './types.js';
import { log } from '../core/logger.js';

export interface GoogleCalendarConfig {
  /** OAuth client, from the client's own Google Cloud project or ours acting for them. */
  clientId: string;
  clientSecret: string;
  /** Long-lived. Exchanged for an access token per call; nothing here caches one. */
  refreshToken: string;
  /** Usually 'primary', or a shared diary's address. */
  calendarId: string;
  /** IANA zone, e.g. 'Europe/London'. Not a UTC offset — offsets break at the clock change. */
  timezone: string;

  /** Days the business is open, lowercase three-letter: mon, tue, ... */
  openDays?: string[];
  /** Local opening time, 24h 'HH:MM'. */
  openFrom?: string;
  openTo?: string;
  /** How long a booking of each kind runs. Falls back to `defaultDurationMinutes`. */
  durations?: Record<string, number>;
  defaultDurationMinutes?: number;
  /** Nothing is offered sooner than this. A slot in twenty minutes reads as an empty diary. */
  minNoticeHours?: number;
  /** Offered slots are spaced by at least this, so three in a row do not look like an empty week. */
  spacingHours?: number;
}

const CAPABILITIES: Capabilities = {
  readCustomers: false,
  writeCustomers: false,
  readAppointments: true,
  writeAppointments: true,
  readCatalogue: false,
};

const DEFAULTS = {
  openDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  openFrom: '09:00',
  openTo: '17:00',
  defaultDurationMinutes: 30,
  minNoticeHours: 2,
  spacingHours: 2,
};

/** Half-hour probing. Finer granularity produces slots nobody wants offering — "10:47?". */
const PROBE_MS = 1_800_000;

export interface BusyBlock { start: Date; end: Date }

/**
 * Where a moment falls in the BUSINESS's week, not the server's.
 *
 * Reading `Date.getHours()` gives the host's timezone, which on Railway is UTC.
 * For half the year that is an hour out, and an appointment confirmed an hour
 * out is worse than no appointment at all — the customer arrives to a locked
 * door and the business never learns why.
 */
export function localParts(at: Date, timezone: string): { weekday: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    weekday: (p.weekday ?? '').slice(0, 3).toLowerCase(),
    minutes: Number(p.hour ?? 0) * 60 + Number(p.minute ?? 0),
  };
}

/**
 * Choosing which slots to offer, given what is already in the diary.
 *
 * Pure, and separated from the API on purpose: every bug that has ever mattered
 * in booking code lives in here — the clock change, the slot that runs past
 * closing, the three back-to-back offers, the slot offered for twenty minutes'
 * time. None of those need a network to reproduce, and none of them should need
 * one to catch.
 */
export function planSlots(
  config: GoogleCalendarConfig,
  request: { kind: string; from: Date; to: Date; limit?: number },
  busy: BusyBlock[],
  now: Date = new Date(),
): AppointmentSlot[] {
  const openDays = (config.openDays ?? DEFAULTS.openDays).map((d) => d.slice(0, 3).toLowerCase());
  const openFrom = hhmmToMinutes(config.openFrom ?? DEFAULTS.openFrom, 540);
  const openTo = hhmmToMinutes(config.openTo ?? DEFAULTS.openTo, 1020);
  const spacingMs = (config.spacingHours ?? DEFAULTS.spacingHours) * 3_600_000;
  const minNoticeMs = (config.minNoticeHours ?? DEFAULTS.minNoticeHours) * 3_600_000;

  const durationMinutes = config.durations?.[request.kind]
    ?? config.defaultDurationMinutes
    ?? DEFAULTS.defaultDurationMinutes;
  const durationMs = durationMinutes * 60_000;
  const limit = request.limit ?? 3;

  // The caller's `from` is a request, not permission. Whichever is later of
  // their window and our notice period wins.
  const earliest = new Date(Math.max(request.from.getTime(), now.getTime() + minNoticeMs));
  if (earliest >= request.to) return [];

  const clashes = (s: Date, e: Date): boolean => busy.some((b) => s < b.end && e > b.start);

  const slots: AppointmentSlot[] = [];
  const probe = new Date(Math.ceil(earliest.getTime() / PROBE_MS) * PROBE_MS);

  while (probe.getTime() + durationMs <= request.to.getTime() && slots.length < limit) {
    const end = new Date(probe.getTime() + durationMs);
    const { weekday, minutes } = localParts(probe, config.timezone);
    const open = openDays.includes(weekday)
      && minutes >= openFrom
      && minutes + durationMinutes <= openTo;

    if (open && !clashes(probe, end)) {
      slots.push({ start: new Date(probe.getTime()), end });
      // Leave a gap rather than offering three back-to-back, which reads as a
      // diary with nothing in it.
      probe.setTime(probe.getTime() + spacingMs);
      continue;
    }
    probe.setTime(probe.getTime() + PROBE_MS);
  }

  return slots;
}

function hhmmToMinutes(hhmm: string, fallback: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) ? (h as number) * 60 + (m ?? 0) : fallback;
}

export function googleCalendar(config: GoogleCalendarConfig): SchedulingAdapter {
  const openDays = (config.openDays ?? DEFAULTS.openDays).map((d) => d.slice(0, 3).toLowerCase());
  const openFrom = hhmmToMinutes(config.openFrom ?? DEFAULTS.openFrom, 540);
  const openTo = hhmmToMinutes(config.openTo ?? DEFAULTS.openTo, 1020);

  function durationFor(kind: string): number {
    return config.durations?.[kind]
      ?? config.defaultDurationMinutes
      ?? DEFAULTS.defaultDurationMinutes;
  }

  function api(): calendar_v3.Calendar {
    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    return google.calendar({ version: 'v3', auth });
  }

  function isOpen(start: Date, durationMinutes: number): boolean {
    const { weekday, minutes } = localParts(start, config.timezone);
    return openDays.includes(weekday)
      && minutes >= openFrom
      && minutes + durationMinutes <= openTo;
  }

  /** Busy blocks from the real diary. Throws rather than guessing. */
  async function busyBetween(from: Date, to: Date): Promise<BusyBlock[]> {
    let res;
    try {
      res = await api().freebusy.query({
        requestBody: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          timeZone: config.timezone,
          items: [{ id: config.calendarId }],
        },
      });
    } catch (err) {
      // Offering slots without knowing what is already in the diary is worse
      // than offering none. A double-booked appointment is a worse outcome for
      // the business than a caller being asked to try again.
      log.error({ err, calendarId: config.calendarId }, 'could not read calendar availability');
      throw new Error('calendar_unavailable');
    }

    return (res.data.calendars?.[config.calendarId]?.busy ?? [])
      .filter((b): b is { start: string; end: string } =>
        typeof b.start === 'string' && typeof b.end === 'string')
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  function toAppointment(
    ev: calendar_v3.Schema$Event,
    fallback: { customerId: string; kind: string; start: Date; end: Date },
  ): Appointment {
    // Never a vendor shape. The moment a Google event object reaches an agent,
    // swapping Google stops being possible.
    const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : fallback.start;
    const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : fallback.end;
    return {
      id: ev.id ?? '',
      customerId: fallback.customerId,
      kind: fallback.kind,
      start,
      end,
      status: ev.status === 'cancelled' ? 'cancelled' : 'booked',
      ...(ev.description ? { notes: ev.description } : {}),
    };
  }

  return {
    name: 'google-calendar',
    capabilities: () => CAPABILITIES,

    availableSlots: async (request) => {
      const minNoticeMs = (config.minNoticeHours ?? DEFAULTS.minNoticeHours) * 3_600_000;
      const earliest = new Date(Math.max(request.from.getTime(), Date.now() + minNoticeMs));
      if (earliest >= request.to) return [];
      // Read the diary, then hand both to the pure planner. Everything the
      // network knows is in `busy`; everything a decision depends on is in
      // planSlots, where a test can reach it.
      const busy = await busyBetween(earliest, request.to);
      return planSlots(config, request, busy);
    },

    book: async (input) => {
      const durationMinutes = durationFor(input.kind);
      const end = new Date(input.start.getTime() + durationMinutes * 60_000);

      if (!isOpen(input.start, durationMinutes)) throw new Error('outside_opening_hours');

      // Google will cheerfully double-book. It has no idea this diary is the
      // only one a business has. So the clash check happens here, immediately
      // before the write.
      //
      // HONEST LIMIT: this is check-then-write, so two bookings landing inside
      // the same few hundred milliseconds can both pass. Narrowing it further
      // needs a lock the Calendar API does not offer. The mitigation that
      // matters is that a voice agent holds one call at a time.
      const busy = await busyBetween(input.start, end);
      if (busy.some((b) => input.start < b.end && end > b.start)) throw new Error('slot_taken');

      let created: calendar_v3.Schema$Event;
      try {
        const res = await api().events.insert({
          calendarId: config.calendarId,
          requestBody: {
            summary: input.kind,
            ...(input.notes ? { description: input.notes } : {}),
            start: { dateTime: input.start.toISOString(), timeZone: config.timezone },
            end: { dateTime: end.toISOString(), timeZone: config.timezone },
            // Carried so a booking can be traced back to who it is for without
            // parsing a summary line somebody will eventually reword.
            extendedProperties: {
              private: {
                meridianCustomerId: input.customerId,
                ...(input.subjectId ? { meridianSubjectId: input.subjectId } : {}),
                meridianKind: input.kind,
              },
            },
          },
        });
        created = res.data;
      } catch (err) {
        // Loud, and never swallowed into a success. An agent that believes it
        // booked has already told the customer it did.
        log.error({ err, calendarId: config.calendarId }, 'failed to write calendar event');
        throw new Error('calendar_write_failed');
      }

      if (!created.id) throw new Error('calendar_write_failed');

      return toAppointment(created, {
        customerId: input.customerId, kind: input.kind, start: input.start, end,
      });
    },

    cancel: async (appointmentId, reason) => {
      try {
        await api().events.delete({ calendarId: config.calendarId, eventId: appointmentId });
      } catch (err) {
        const status = (err as { code?: number }).code;
        // Already gone is the outcome the caller wanted. Anything else is not.
        if (status === 404 || status === 410) {
          log.info({ appointmentId }, 'cancel: appointment was already gone');
          return;
        }
        log.error({ err, appointmentId, reason }, 'failed to cancel appointment');
        throw new Error('calendar_write_failed');
      }
    },

    reschedule: async (appointmentId, start) => {
      let existing: calendar_v3.Schema$Event;
      try {
        const got = await api().events.get({
          calendarId: config.calendarId, eventId: appointmentId,
        });
        existing = got.data;
      } catch {
        throw new Error('appointment_not_found');
      }

      const kind = existing.extendedProperties?.private?.meridianKind ?? existing.summary ?? '';
      const customerId = existing.extendedProperties?.private?.meridianCustomerId ?? '';
      const durationMinutes = durationFor(kind);
      const end = new Date(start.getTime() + durationMinutes * 60_000);

      if (!isOpen(start, durationMinutes)) throw new Error('outside_opening_hours');

      // The same clash check as a new booking. A reschedule is a booking that
      // happens to free a slot first, and nothing about that makes it safe to
      // drop the check.
      const busy = (await busyBetween(start, end))
        .filter((b) => !(b.start.getTime() === new Date(existing.start?.dateTime ?? 0).getTime()));
      if (busy.some((b) => start < b.end && end > b.start)) throw new Error('slot_taken');

      try {
        const res = await api().events.patch({
          calendarId: config.calendarId,
          eventId: appointmentId,
          requestBody: {
            start: { dateTime: start.toISOString(), timeZone: config.timezone },
            end: { dateTime: end.toISOString(), timeZone: config.timezone },
          },
        });
        return toAppointment(res.data, { customerId, kind, start, end });
      } catch (err) {
        log.error({ err, appointmentId }, 'failed to reschedule appointment');
        throw new Error('calendar_write_failed');
      }
    },

    /**
     * Slots that freed up, for the waiting-list agent to fill.
     *
     * `updatedMin` is when the event was last CHANGED, not when it starts — so
     * this asks Google for everything touched since `since`, then keeps the
     * cancellations that are still in the future. A cancellation of yesterday's
     * appointment is not a slot anybody can take.
     */
    cancellations: async (since) => {
      let items: calendar_v3.Schema$Event[];
      try {
        const res = await api().events.list({
          calendarId: config.calendarId,
          showDeleted: true,
          singleEvents: true,
          updatedMin: since.toISOString(),
          timeMin: new Date().toISOString(),
          maxResults: 250,
        });
        items = res.data.items ?? [];
      } catch (err) {
        log.error({ err }, 'could not read cancellations');
        throw new Error('calendar_unavailable');
      }

      return items
        .filter((ev) => ev.status === 'cancelled' && ev.start?.dateTime)
        .map((ev) => toAppointment(ev, {
          customerId: ev.extendedProperties?.private?.meridianCustomerId ?? '',
          kind: ev.extendedProperties?.private?.meridianKind ?? ev.summary ?? '',
          start: new Date(ev.start!.dateTime!),
          end: new Date(ev.end?.dateTime ?? ev.start!.dateTime!),
        }));
    },
  };
}
