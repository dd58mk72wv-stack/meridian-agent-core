import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context, type Trigger } from '../context.js';
import { defineAgent, type AgentResult } from '../agent.js';
import { Manager } from '../manager.js';
import { CMO, declaredIntentResolver, type IntentResolver } from '../cmo.js';

function trigger(payload: Record<string, unknown> = {}): Trigger {
  return { kind: 'call', payload, receivedAt: new Date(), from: '+441726812345' };
}

function ctx(payload: Record<string, unknown> = {}): Context {
  return new Context({ trigger: trigger(payload), clientId: 'bay-motors' });
}

const ok = (summary: string): AgentResult => ({ status: 'done', summary });

function stubAgent(name: string, department: string, handles: string[]) {
  return defineAgent({
    name, department, handles, reasons: false,
    does: `handles ${handles[0]} only`,
    run: async () => ok(`${name} ran`),
  });
}

// ---------------------------------------------------------------------------
// The context rule — enforced by the type, not by a README
// ---------------------------------------------------------------------------

test('context is append-only: there is no way to remove or truncate a note', () => {
  const c = ctx();
  c.add('cmo', 'first').add('manager:sales', 'second');

  const surface = new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(c)),
    ...Object.keys(c),
  ]);
  for (const forbidden of ['clear', 'reset', 'truncate', 'summarise', 'summarize', 'remove', 'set']) {
    assert.ok(!surface.has(forbidden), `Context must not expose ${forbidden}()`);
  }
});

test('notes() returns a copy, so a caller cannot splice the original', () => {
  const c = ctx();
  c.add('cmo', 'first');
  const taken = c.notes();
  taken.length = 0;
  assert.equal(c.notes().length, 1, 'the record survives a caller emptying its copy');
});

test('a revised fact keeps the original rather than overwriting it', () => {
  // A later layer quietly overwriting what an earlier one established is the
  // same information loss the context rule exists to prevent.
  const c = ctx();
  c.learn('agent:triage', 'urgency', 'routine');
  c.learn('agent:vet', 'urgency', 'urgent');

  const facts = c.facts();
  assert.equal(facts.urgency, 'routine', 'the original stands');
  assert.equal(facts['urgency#2'], 'urgent', 'the revision is kept alongside');
  assert.ok(c.notes().some((n) => n.note.includes('revised urgency')));
});

test('render() shows everything and summarises nothing', () => {
  const c = ctx();
  c.learn('cmo', 'reg', 'AB12 CDE');
  for (let i = 0; i < 40; i++) c.add('agent:x', `step ${i}`);

  const rendered = c.render();
  assert.ok(rendered.includes('AB12 CDE'));
  assert.ok(rendered.includes('step 0'), 'the earliest note survives');
  assert.ok(rendered.includes('step 39'), 'the latest note survives');
});

// ---------------------------------------------------------------------------
// One job per agent
// ---------------------------------------------------------------------------

test('an agent describing its job with "and" is rejected at definition time', () => {
  // Caught when it is introduced rather than a year later, when the second job
  // has become invisible.
  assert.throws(
    () => defineAgent({
      name: 'booking', department: 'service', handles: ['book'], reasons: false,
      does: 'handles booking requests and sends the confirmation',
      run: async () => ok('x'),
    }),
    /two agents/,
  );
});

test('an agent that handles nothing is rejected', () => {
  assert.throws(
    () => defineAgent({
      name: 'orphan', department: 'sales', handles: [], reasons: false,
      does: 'does something',
      run: async () => ok('x'),
    }),
    /handles nothing/,
  );
});

test('a legitimate single-job agent is accepted', () => {
  const agent = stubAgent('test_drive_booking', 'sales', ['book_test_drive']);
  assert.equal(agent.name, 'test_drive_booking');
});

// ---------------------------------------------------------------------------
// Routing must never be ambiguous
// ---------------------------------------------------------------------------

test('two agents claiming one intent is refused at construction', () => {
  assert.throws(
    () => new Manager({
      name: 'sales', owns: 'sales',
      agents: [
        stubAgent('a', 'sales', ['book_test_drive']),
        stubAgent('b', 'sales', ['book_test_drive']),
      ],
    }),
    /claimed by both/,
  );
});

test('an agent registered under the wrong department is refused', () => {
  assert.throws(
    () => new Manager({
      name: 'sales', owns: 'sales',
      agents: [stubAgent('a', 'service', ['book_service'])],
    }),
    /reports to "service"/,
  );
});

test('two departments claiming one intent is refused at construction', () => {
  const sales = new Manager({ name: 'sales', owns: 'x', agents: [stubAgent('a', 'sales', ['quote'])] });
  const service = new Manager({ name: 'service', owns: 'y', agents: [stubAgent('b', 'service', ['quote'])] });
  assert.throws(
    () => new CMO({ managers: [sales, service], resolver: declaredIntentResolver }),
    /claimed by both/,
  );
});

// ---------------------------------------------------------------------------
// The CMO's own job
// ---------------------------------------------------------------------------

test('a declared intent is routed without a model', async () => {
  const sales = new Manager({
    name: 'sales', owns: 'sales',
    agents: [stubAgent('lead_follow_up', 'sales', ['follow_up'])],
  });
  const cmo = new CMO({ managers: [sales], resolver: declaredIntentResolver });

  const c = ctx({ intent: 'follow_up' });
  const out = await cmo.dispatch(c);

  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.agent, 'lead_follow_up');
  assert.equal(out.results[0]!.status, 'done');
});

test('a low-confidence intent is never routed — it goes to a human', async () => {
  // A wrong route is worse than no route: the caller gets a confident answer to
  // a question they did not ask.
  const sales = new Manager({
    name: 'sales', owns: 'sales', agents: [stubAgent('a', 'sales', ['trade_in'])],
  });
  const unsure: IntentResolver = { resolve: async () => [{ name: 'trade_in', confidence: 0.4 }] };
  const cmo = new CMO({ managers: [sales], resolver: unsure });

  const out = await cmo.dispatch(ctx());
  assert.equal(out.results.length, 0);
  assert.match(out.needsHuman ?? '', /confidence floor/);
});

test('a call touching two departments is flagged as cross-department', async () => {
  // "Book it in for a service — and actually I've been thinking about trading
  // it in." Each department handles its half and neither knows about the other.
  const sales = new Manager({
    name: 'sales', owns: 'sales', agents: [stubAgent('trade_in', 'sales', ['trade_in'])],
  });
  const service = new Manager({
    name: 'service', owns: 'service', agents: [stubAgent('booking', 'service', ['book_service'])],
  });
  const both: IntentResolver = {
    resolve: async () => [
      { name: 'book_service', confidence: 0.9 },
      { name: 'trade_in', confidence: 0.8 },
    ],
  };
  const cmo = new CMO({ managers: [sales, service], resolver: both });

  const c = ctx();
  const out = await cmo.dispatch(c);

  assert.deepEqual(out.crossDepartment, ['service', 'sales']);
  assert.equal(out.results.length, 2);
  assert.deepEqual(c.fact('cross_department'), ['service', 'sales']);
});

test('the second department sees what the first one did', async () => {
  // The whole point of passing full context down rather than a task.
  let sawFirst = false;
  const first = new Manager({
    name: 'service', owns: 'x',
    agents: [defineAgent({
      name: 'booking', department: 'service', handles: ['book_service'], reasons: false,
      does: 'books service slots only',
      run: async (c) => { c.learn('agent:booking', 'slot', 'Tuesday 10am'); return ok('booked'); },
    })],
  });
  const second = new Manager({
    name: 'sales', owns: 'y',
    agents: [defineAgent({
      name: 'trade_in', department: 'sales', handles: ['trade_in'], reasons: false,
      does: 'handles valuation enquiries only',
      run: async (c) => { sawFirst = c.fact('slot') === 'Tuesday 10am'; return ok('valued'); },
    })],
  });
  const resolver: IntentResolver = {
    resolve: async () => [
      { name: 'book_service', confidence: 0.9 },
      { name: 'trade_in', confidence: 0.9 },
    ],
  };

  await new CMO({ managers: [first, second], resolver }).dispatch(ctx());
  assert.ok(sawFirst, 'the second department must see what the first established');
});

test('an agent that throws escalates rather than failing silently', async () => {
  // Somebody is usually on the phone.
  const m = new Manager({
    name: 'sales', owns: 'x',
    agents: [defineAgent({
      name: 'flaky', department: 'sales', handles: ['quote'], reasons: false,
      does: 'quotes only',
      run: async () => { throw new Error('DMS timed out'); },
    })],
  });
  const out = await m.delegate('quote', ctx());
  assert.equal(out.status, 'escalate');
  assert.match(out.reason ?? '', /DMS timed out/);
});

test('an unrouted intent escalates rather than being swallowed', async () => {
  const m = new Manager({ name: 'sales', owns: 'x', agents: [stubAgent('a', 'sales', ['quote'])] });
  const out = await m.delegate('something_else', ctx());
  assert.equal(out.status, 'escalate');
  assert.equal(out.agent, null);
});

// ---------------------------------------------------------------------------
// Job failures must reach somebody
// ---------------------------------------------------------------------------

test('a job that exhausts its retries has somewhere to report to', async () => {
  // The core has no events table of its own, so the reporter is registered by
  // the consumer. A job failing with nobody listening is exactly the silent
  // failure this whole system exists to avoid.
  const { onJobFailure, hasFailureReporter } = await import('../queue.js');
  assert.equal(hasFailureReporter(), false, 'nothing is registered by default');

  onJobFailure(async () => {});
  assert.equal(hasFailureReporter(), true, 'and a consumer can register one');
});
