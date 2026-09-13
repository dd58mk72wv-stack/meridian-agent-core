/**
 * Routing a sentence to a department.
 *
 * This is the only place in Meridian where a model decides where something
 * goes, so the interesting tests are all about what it does when it is wrong,
 * unsure, or unavailable. Every one of those paths must end at a human.
 *
 * The pure parts — the catalogue the model is shown, and what is read off the
 * trigger — are tested directly. The call itself is exercised against the live
 * API in resolver.live.test.mts, because a mocked client only ever agrees with
 * the mock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Manager } from '../manager.js';
import { Context } from '../context.js';
import { catalogueOf, triggerText, llmResolver } from '../resolver.js';
import { CONFIDENCE_FLOOR } from '../cmo.js';

const agent = (name: string, department: string, handles: string[]) => ({
  name, department, handles,
  run: async () => ({ ok: true, summary: 'did nothing' }),
});

const managers = () => [
  new Manager({
    name: 'sales', owns: 'anything that could become money',
    agents: [agent('test_drive_booking', 'sales', ['book_test_drive', 'ask_about_stock'])],
  }),
  new Manager({
    name: 'service', owns: 'the workshop diary',
    agents: [agent('service_booking', 'service', ['book_service'])],
  }),
];

const ctx = (text: string) => new Context({
  clientId: 'c1',
  trigger: { kind: 'call', payload: { text }, receivedAt: new Date() },
});

test('the catalogue offers every registered intent and nothing else', () => {
  // The model is given a closed list. An intent it invents routes nowhere and
  // the caller is never helped, so the list has to be complete and exact.
  const c = catalogueOf(managers());
  for (const i of ['book_test_drive', 'ask_about_stock', 'book_service']) {
    assert.ok(c.includes(i), `${i} is registered but was not offered to the model`);
  }
  assert.ok(c.includes('sales'), 'the department is named so the model can tell them apart');
  assert.ok(c.includes('anything that could become money'), 'and what it owns');
});

test('the catalogue is built from the registry, not written by hand', () => {
  // A hand-maintained prompt goes stale the first time an agent is added. This
  // is the property that stops that: register an agent, it becomes routable.
  const before = catalogueOf(managers());
  const withNew = managers();
  withNew.push(new Manager({
    name: 'parts', owns: 'ordering parts',
    agents: [agent('parts_enquiry', 'parts', ['order_part'])],
  }));
  const after = catalogueOf(withNew);
  assert.ok(!before.includes('order_part'));
  assert.ok(after.includes('order_part'), 'a newly registered agent must be offered');
});

test('only the trigger is shown, never what earlier layers concluded', () => {
  // Notes carry previous decisions. Feeding them back makes the resolver agree
  // with whatever happened last time instead of reading what was said.
  const c = ctx('I need my car looked at');
  c.add('cmo', 'previously routed to book_test_drive', {});
  const text = triggerText(c);
  assert.ok(text.includes('I need my car looked at'));
  assert.doesNotMatch(text, /previously routed/,
    'a prior decision must not be visible to the next one');
});

test('a transcript is read as well as a text body', () => {
  const c = new Context({
    clientId: 'c1',
    trigger: { kind: 'call', payload: { transcript: 'hello is that the garage' }, receivedAt: new Date() },
  });
  assert.ok(triggerText(c).includes('hello is that the garage'));
});

test('with no key it resolves to nothing rather than guessing', async () => {
  const had = process.env['ANTHROPIC_API_KEY'];
  try {
    delete process.env['ANTHROPIC_API_KEY'];
    const r = llmResolver({ managers: managers() });
    assert.deepEqual(await r.resolve(ctx('book me in')), [],
      'no key must mean no route — the CMO then asks a human');
  } finally {
    if (had === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = had;
  }
});

test('a failed call resolves to nothing rather than guessing', async () => {
  // A network fault must not become a route. The CMO's needsHuman path is a
  // better outcome than dispatching on the strength of a call that failed.
  const r = llmResolver({ managers: managers(), apiKey: 'sk-ant-not-a-real-key' });
  assert.deepEqual(await r.resolve(ctx('book me in')), []);
});

test('the floor it reports against is the one the CMO applies', () => {
  // If these drifted apart, the resolver would be hedging against a number
  // nobody enforces.
  assert.equal(CONFIDENCE_FLOOR, 0.6);
});
