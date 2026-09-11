import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stubAdapters, stubScheduling, stubRecords, stubKnowledge, stubbed, STUB_PREFIX } from '../stub.js';

// ---------------------------------------------------------------------------
// Stubs must announce themselves
// ---------------------------------------------------------------------------

test('every stub names itself as one', () => {
  // The failure this guards against is not a stub that breaks. It is a stub
  // that WORKS, quietly, in production, while somebody reads its invented
  // availability as a real diary.
  const adapters = stubAdapters();
  const names = stubbed(adapters);
  assert.equal(names.length, 6, 'all six are reported as stubs');
  for (const n of names) assert.ok(n.startsWith(STUB_PREFIX), n);
});

// ---------------------------------------------------------------------------
// A stub that says yes to everything proves nothing
// ---------------------------------------------------------------------------

test('scheduling refuses to double-book', async () => {
  const s = stubScheduling();
  const monday = new Date('2026-09-14T10:00:00Z');

  await s.book({ customerId: 'c1', kind: 'mot', start: monday });
  await assert.rejects(
    () => s.book({ customerId: 'c2', kind: 'mot', start: monday }),
    /slot_taken/,
  );
});

test('a booked slot stops being offered', async () => {
  const s = stubScheduling();
  const from = new Date('2026-09-14T09:00:00Z');
  const to = new Date('2026-09-14T17:00:00Z');

  const before = await s.availableSlots({ kind: 'mot', from, to, limit: 20 });
  await s.book({ customerId: 'c1', kind: 'mot', start: before[0]!.start });
  const after = await s.availableSlots({ kind: 'mot', from, to, limit: 20 });

  assert.equal(after.length, before.length - 1);
  assert.notDeepEqual(after[0]!.start, before[0]!.start);
});

test('no slots are offered at the weekend', async () => {
  const s = stubScheduling();
  const saturday = new Date('2026-09-12T09:00:00Z');
  const sunday = new Date('2026-09-13T18:00:00Z');
  assert.deepEqual(await s.availableSlots({ kind: 'mot', from: saturday, to: sunday }), []);
});

test('cancelling frees the slot again', async () => {
  const s = stubScheduling();
  const monday = new Date('2026-09-14T10:00:00Z');
  const appt = await s.book({ customerId: 'c1', kind: 'mot', start: monday });
  await s.cancel!(appt.id, 'customer rang');
  // No longer clashing, so it can be rebooked.
  await s.book({ customerId: 'c2', kind: 'mot', start: monday });
});

// ---------------------------------------------------------------------------
// Nothing is invented
// ---------------------------------------------------------------------------

test('an unknown customer returns null rather than a fabricated record', async () => {
  // An agent handed an invented customer will address a stranger by someone
  // else's name.
  const r = stubRecords([{ id: 'c1', name: 'Jane Hall', phone: '+447700900123' }]);
  assert.equal(await r.findCustomer({ phone: '+447700900999' }), null);
});

test('a known customer is found by any of phone, email or name', async () => {
  const r = stubRecords([
    { id: 'c1', name: 'Jane Hall', phone: '+447700900123', email: 'jane@example.co.uk' },
  ]);
  assert.equal((await r.findCustomer({ phone: '+447700900123' }))?.id, 'c1');
  assert.equal((await r.findCustomer({ email: 'JANE@EXAMPLE.CO.UK' }))?.id, 'c1');
  assert.equal((await r.findCustomer({ name: 'jane hall' }))?.id, 'c1');
});

test('knowledge returns null for what it does not hold', async () => {
  // A caller will drive there on the answer. "I do not know" is the only
  // acceptable alternative to knowing.
  const k = stubKnowledge({ 'opening hours': 'Half eight to six, Monday to Friday.' });
  assert.equal(await k.lookup('do you do home visits?'), null);
  assert.match((await k.lookup('what are your opening hours?'))!.answer, /Half eight/);
});

// ---------------------------------------------------------------------------
// Capabilities are declared before they are relied on
// ---------------------------------------------------------------------------

test('adapters declare what they can do', async () => {
  // A practice management system with no write access is common. An agent that
  // discovers this halfway through booking has already told a caller the
  // appointment is made.
  const a = stubAdapters();
  assert.equal(a.scheduling.capabilities().writeAppointments, true);
  assert.equal(a.records.capabilities().readCustomers, true);
});

test('payments produce a link, never take a card number', async () => {
  // No agent in this system ever handles a PAN. A voice agent reading one back
  // is a PCI problem no amount of care makes acceptable, and the call is
  // recorded.
  const a = stubAdapters();
  const surface = Object.keys(a.payments!);
  for (const forbidden of ['charge', 'takePayment', 'chargeCard', 'capture']) {
    assert.ok(!surface.includes(forbidden), `payments must not expose ${forbidden}`);
  }
  const link = await a.payments!.createPaymentLink({
    customerId: 'c1', amountPence: 12_000, description: 'MOT',
  });
  assert.match(link.url, /^https:\/\//);
});
