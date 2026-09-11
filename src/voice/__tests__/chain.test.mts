import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifySignature, lastUtterance, handleVoiceTurn, type Turn } from '../chain.js';
import { defineAgent } from '../../core/agent.js';
import { Manager } from '../../core/manager.js';
import { CMO, type IntentResolver } from '../../core/cmo.js';

// ---------------------------------------------------------------------------
// Signature verification — the endpoint is an open microphone without it
// ---------------------------------------------------------------------------

const SECRET = 'a-real-secret';
const sign = (body: string): string =>
  createHmac('sha256', SECRET).update(body).digest('hex');

test('a correctly signed request verifies', () => {
  const body = '{"callId":"abc"}';
  assert.ok(verifySignature(body, sign(body), SECRET));
});

test('a tampered body does not verify', () => {
  const body = '{"callId":"abc"}';
  assert.equal(verifySignature('{"callId":"xyz"}', sign(body), SECRET), false);
});

test('a missing signature does not verify', () => {
  assert.equal(verifySignature('{}', undefined, SECRET), false);
});

test('a missing secret refuses rather than allowing', () => {
  // The wrong default here would accept every request from anywhere.
  const body = '{}';
  assert.equal(verifySignature(body, sign(body), ''), false);
});

test('a signature of the wrong length is rejected without throwing', () => {
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  assert.equal(verifySignature('{}', 'short', SECRET), false);
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

test('the last thing the CALLER said is found, not the last thing said', () => {
  const turns: Turn[] = [
    { role: 'user', content: 'I need an MOT' },
    { role: 'assistant', content: 'What is the registration?' },
  ];
  assert.equal(lastUtterance(turns), 'I need an MOT');
});

test('an empty transcript yields an empty utterance rather than throwing', () => {
  assert.equal(lastUtterance([]), '');
});

// ---------------------------------------------------------------------------
// The turn handler
// ---------------------------------------------------------------------------

function cmoWith(resolver: IntentResolver, say?: string): CMO {
  const manager = new Manager({
    name: 'service', owns: 'service',
    agents: [defineAgent({
      name: 'booking', department: 'service', handles: ['book_service'], reasons: false,
      does: 'books service slots only',
      run: async () => ({ status: 'done', summary: 'booked', ...(say ? { say } : {}) }),
    })],
  });
  return new CMO({ managers: [manager], resolver });
}

const confident: IntentResolver = {
  resolve: async () => [{ name: 'book_service', confidence: 0.95 }],
};

const base = {
  callId: 'call-1',
  from: '+441726812345',
  turns: [{ role: 'user' as const, content: 'Can I book an MOT?' }],
  event: 'turn' as const,
};

test('the greeting is said when the call connects', async () => {
  const res = await handleVoiceTurn(
    { ...base, event: 'call.started' },
    { cmo: cmoWith(confident), clientId: 'bay', greeting: 'Bay Motors, how can I help?' },
  );
  assert.equal(res.say, 'Bay Motors, how can I help?');
});

test('an agent that speaks has its words returned', async () => {
  const res = await handleVoiceTurn(base, {
    cmo: cmoWith(confident, 'Tuesday at ten, is that any good?'),
    clientId: 'bay', greeting: 'hi',
  });
  assert.equal(res.say, 'Tuesday at ten, is that any good?');
});

test('an agent that acts without speaking never produces dead air', async () => {
  // Silence on a phone call reads as the line having dropped.
  const res = await handleVoiceTurn(base, {
    cmo: cmoWith(confident), clientId: 'bay', greeting: 'hi',
  });
  assert.notEqual(res.say.trim(), '');
});

test('an unroutable turn transfers to a human rather than guessing', async () => {
  // On a live call a guess is worse than a transfer, because the caller acts
  // on it.
  const unsure: IntentResolver = {
    resolve: async () => [{ name: 'book_service', confidence: 0.3 }],
  };
  const res = await handleVoiceTurn(base, {
    cmo: cmoWith(unsure), clientId: 'bay', greeting: 'hi', humanNumber: '+441726999999',
  });
  assert.equal(res.transferTo, '+441726999999');
});

test('with no human to transfer to, it says so rather than inventing an answer', async () => {
  const unsure: IntentResolver = {
    resolve: async () => [{ name: 'book_service', confidence: 0.3 }],
  };
  const res = await handleVoiceTurn(base, {
    cmo: cmoWith(unsure), clientId: 'bay', greeting: 'hi',
  });
  assert.equal(res.transferTo, undefined);
  assert.match(res.say, /call you (straight )?back/i);
});

test('a dispatch that throws mid-call does not become dead air', async () => {
  const exploding: IntentResolver = {
    resolve: async () => { throw new Error('model unreachable'); },
  };
  const res = await handleVoiceTurn(base, {
    cmo: cmoWith(exploding), clientId: 'bay', greeting: 'hi', humanNumber: '+441726999999',
  });
  assert.equal(res.transferTo, '+441726999999');
});

test('a cross-department turn says both halves, in the order they ran', async () => {
  const sales = new Manager({
    name: 'sales', owns: 'sales',
    agents: [defineAgent({
      name: 'trade_in', department: 'sales', handles: ['trade_in'], reasons: false,
      does: 'handles valuations only',
      run: async () => ({ status: 'done', summary: 'valued', say: 'And I can value your current car.' }),
    })],
  });
  const service = new Manager({
    name: 'service', owns: 'service',
    agents: [defineAgent({
      name: 'booking', department: 'service', handles: ['book_service'], reasons: false,
      does: 'books service slots only',
      run: async () => ({ status: 'done', summary: 'booked', say: 'Tuesday at ten for the service.' }),
    })],
  });
  const both: IntentResolver = {
    resolve: async () => [
      { name: 'book_service', confidence: 0.9 },
      { name: 'trade_in', confidence: 0.85 },
    ],
  };
  const cmo = new CMO({ managers: [sales, service], resolver: both });

  const res = await handleVoiceTurn(base, { cmo, clientId: 'bay', greeting: 'hi' });
  assert.equal(res.say, 'Tuesday at ten for the service. And I can value your current car.');
});
