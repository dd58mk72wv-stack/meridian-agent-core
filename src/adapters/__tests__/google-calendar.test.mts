/**
 * Booking logic, without a network.
 *
 * These are the bugs that actually happen in booking code: an hour out at the
 * clock change, a slot that runs past closing, three offers in a row that read
 * as an empty diary, and a slot offered for twenty minutes' time. All four are
 * reproducible from a date and a config, and none of them should need a live
 * Google account to catch.
 *
 * The times below are deliberately UK-specific. Europe/London is the zone every
 * client is in, and it is the zone where "just use UTC" quietly breaks for
 * seven months of the year.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  googleCalendar, localParts, planSlots, type GoogleCalendarConfig,
} from '../google-calendar.js';

const BASE: GoogleCalendarConfig = {
  clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
  calendarId: 'primary',
  timezone: 'Europe/London',
  openDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  openFrom: '09:00',
  openTo: '17:00',
  defaultDurationMinutes: 30,
  minNoticeHours: 2,
  spacingHours: 2,
};

// A Wednesday in British Summer Time. 08:00 UTC is 09:00 in London.
const SUMMER_WED_0800Z = new Date('2026-07-01T08:00:00Z');
// A Wednesday in GMT. 09:00 UTC is 09:00 in London.
const WINTER_WED_0900Z = new Date('2026-01-07T09:00:00Z');

test('the working day is read in the business timezone, not the server timezone', () => {
  // The whole bug in one assertion. On a UTC host, 08:00Z in July reads as
  // 08:00 — an hour before opening — and the slot is silently dropped. In
  // London it is 09:00 and the practice is open.
  assert.equal(localParts(SUMMER_WED_0800Z, 'Europe/London').minutes, 9 * 60);
  assert.equal(localParts(SUMMER_WED_0800Z, 'UTC').minutes, 8 * 60);
  assert.equal(localParts(WINTER_WED_0900Z, 'Europe/London').minutes, 9 * 60);
});

test('a summer morning slot is offered at the right local hour', () => {
  const slots = planSlots(
    BASE,
    { kind: 'checkup', from: SUMMER_WED_0800Z, to: new Date('2026-07-01T16:00:00Z'), limit: 1 },
    [],
    new Date('2026-07-01T00:00:00Z'),
  );
  assert.equal(slots.length, 1);
  assert.equal(localParts(slots[0]!.start, 'Europe/London').minutes, 9 * 60);
});

test('nothing is offered before the notice period, whatever the caller asks for', () => {
  // A slot in twenty minutes reads as an empty diary, and mostly produces a
  // no-show because the customer already had a day planned.
  const now = new Date('2026-07-01T08:00:00Z');           // 09:00 London, open
  const slots = planSlots(
    BASE,
    { kind: 'checkup', from: now, to: new Date('2026-07-01T16:00:00Z'), limit: 3 },
    [],
    now,
  );
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.ok(s.start.getTime() >= now.getTime() + 2 * 3_600_000,
      `${s.start.toISOString()} is inside the two-hour notice period`);
  }
});

test('offers are spaced out rather than three in a row', () => {
  const now = new Date('2026-07-01T06:00:00Z');
  const slots = planSlots(
    BASE,
    { kind: 'checkup', from: now, to: new Date('2026-07-01T16:00:00Z'), limit: 3 },
    [],
    now,
  );
  assert.equal(slots.length, 3);
  for (let i = 1; i < slots.length; i++) {
    const gap = slots[i]!.start.getTime() - slots[i - 1]!.start.getTime();
    assert.ok(gap >= 2 * 3_600_000, `offers ${i - 1} and ${i} are only ${gap / 60000} min apart`);
  }
});

test('a slot that would run past closing is never offered', () => {
  // A 60-minute appointment at 16:45 ends at 17:45. The practice shut at 17:00
  // and somebody would be sitting in a waiting room with the lights off.
  const cfg: GoogleCalendarConfig = { ...BASE, durations: { long: 60 }, spacingHours: 0.5 };
  const now = new Date('2026-07-01T06:00:00Z');
  const slots = planSlots(
    cfg,
    { kind: 'long', from: now, to: new Date('2026-07-01T23:00:00Z'), limit: 40 },
    [],
    now,
  );
  assert.ok(slots.length > 0);
  for (const s of slots) {
    const endMin = localParts(s.end, 'Europe/London').minutes;
    // An end exactly at 17:00 is fine; anything later, or wrapped past midnight
    // into a small number, is not.
    assert.ok(endMin <= 17 * 60 && endMin > 9 * 60,
      `${s.start.toISOString()}–${s.end.toISOString()} runs outside opening hours`);
  }
});

test('a busy block is never offered, including one that only overlaps the edge', () => {
  const now = new Date('2026-07-01T06:00:00Z');
  const busy = [{
    start: new Date('2026-07-01T08:00:00Z'),   // 09:00 London
    end: new Date('2026-07-01T08:15:00Z'),     // 09:15 — clips the 09:00 slot only
  }];
  const slots = planSlots(
    { ...BASE, spacingHours: 0.5 },
    { kind: 'checkup', from: now, to: new Date('2026-07-01T16:00:00Z'), limit: 3 },
    busy,
    now,
  );
  assert.ok(slots.length > 0);
  for (const s of slots) {
    for (const b of busy) {
      assert.ok(!(s.start < b.end && s.end > b.start),
        `${s.start.toISOString()} overlaps a busy block`);
    }
  }
  // And the first offer moved past the clash rather than the whole day being lost.
  assert.equal(localParts(slots[0]!.start, 'Europe/London').minutes, 9 * 60 + 30);
});

test('a closed day yields nothing at all', () => {
  const sunday = new Date('2026-07-05T08:00:00Z');
  const slots = planSlots(
    BASE,
    { kind: 'checkup', from: sunday, to: new Date('2026-07-05T16:00:00Z'), limit: 3 },
    [],
    new Date('2026-07-05T00:00:00Z'),
  );
  assert.deepEqual(slots, [], 'a Sunday must offer nothing');
});

test('an impossible window returns nothing rather than reaching past it', () => {
  const now = new Date('2026-07-01T08:00:00Z');
  // Window closes before the notice period even ends.
  const slots = planSlots(
    BASE,
    { kind: 'checkup', from: now, to: new Date('2026-07-01T09:00:00Z'), limit: 3 },
    [],
    now,
  );
  assert.deepEqual(slots, []);
});

test('a per-kind duration wins over the default', () => {
  const cfg: GoogleCalendarConfig = { ...BASE, durations: { consult: 45 } };
  const now = new Date('2026-07-01T06:00:00Z');
  const [slot] = planSlots(
    cfg, { kind: 'consult', from: now, to: new Date('2026-07-01T16:00:00Z'), limit: 1 }, [], now);
  assert.equal((slot!.end.getTime() - slot!.start.getTime()) / 60000, 45);

  const [other] = planSlots(
    cfg, { kind: 'unlisted', from: now, to: new Date('2026-07-01T16:00:00Z'), limit: 1 }, [], now);
  assert.equal((other!.end.getTime() - other!.start.getTime()) / 60000, 30);
});

test('the adapter claims appointments and nothing else', () => {
  // The capability declaration is a promise made before an agent relies on it.
  // A calendar is not a patient record and not a price list, and an adapter
  // that claimed otherwise would be found out halfway through a live call.
  const caps = googleCalendar(BASE).capabilities();
  assert.equal(caps.readAppointments, true);
  assert.equal(caps.writeAppointments, true);
  assert.equal(caps.readCustomers, false);
  assert.equal(caps.writeCustomers, false);
  assert.equal(caps.readCatalogue, false);
});

test('it does not announce itself as a stub', () => {
  // `stubbed()` filters on this prefix to drive the health view. A real adapter
  // carrying it would hide a live integration behind a warning; a stub without
  // it would hide invented availability behind silence.
  assert.equal(googleCalendar(BASE).name, 'google-calendar');
  assert.doesNotMatch(googleCalendar(BASE).name, /^stub:/);
});

test('nothing is read from the environment', async () => {
  // Two client systems in one process must not be able to book into each
  // other's diary. Every credential arrives through the config argument.
  //
  // Comments are stripped first — the file says "nothing here reads
  // process.env" in its header, and a check that cannot tell the promise from
  // the breach is not a check.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../google-calendar.ts', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const offending = code.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((x) => x.line.includes('process.env'));
  assert.deepEqual(offending, [],
    `credentials must arrive through config: ${offending.map((o) => `line ${o.n}`).join(', ')}`);
});
