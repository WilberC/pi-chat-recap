import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExchangeLog,
  detectLanguage,
  userText,
  assistantText,
  ABORTED_PI_MARKER,
  ABORTED_YOU_SUFFIX,
  EXCHANGE_STATUS,
} from './exchange.mjs';

test('R1: abort records exact user text and fixed pi marker, no summary', () => {
  const log = createExchangeLog();
  const sent = 'propongo hacer un modo configurable en el sidecar';
  log.beginUser(sent, '2026-11-20T10:00:00Z');
  const aborted = log.abort('2026-11-20T10:00:03Z');
  assert.equal(aborted.status, EXCHANGE_STATUS.aborted);
  assert.equal(aborted.user.text, sent);
  assert.equal(aborted.user.cancelled, true);
  assert.equal(aborted.assistant.text, null);
  assert.equal(aborted.assistant.marker, ABORTED_PI_MARKER);
  // The fixed marker is data for renderers; the you-side suffix is derived,
  // never stored as invented content.
  assert.equal(ABORTED_YOU_SUFFIX, '(operation cancelled)');
});

test('R1: abort with no pending exchange is a no-op, answered exchanges stay untouched', () => {
  const log = createExchangeLog();
  log.beginUser('hello', '2026-11-20T10:00:00Z');
  log.setAssistant('Hi! How can I help?', '2026-11-20T10:00:01Z');
  assert.equal(log.abort('2026-11-20T10:00:02Z'), null);
  const [first] = log.exchanges();
  assert.equal(first.status, EXCHANGE_STATUS.answered);
  assert.equal(first.user.cancelled, false);
  assert.equal(first.assistant.text, 'Hi! How can I help?');
});

test('R3: session language is fixed by the first detectable exchange', () => {
  const log = createExchangeLog();
  log.beginUser('que tal, vamos a agregar el modo nuevo', '2026-11-20T10:00:00Z');
  assert.equal(log.language(), 'es');
  log.beginUser('now switch to english please', '2026-11-20T10:01:00Z');
  assert.equal(log.language(), 'es');
});

test('R3: undetectable first message defers the decision, no guessing', () => {
  const log = createExchangeLog();
  log.beginUser('???', '2026-11-20T10:00:00Z');
  assert.equal(log.language(), null);
  log.beginUser('add the option', '2026-11-20T10:01:00Z');
  assert.equal(log.language(), 'en');
});

test('detectLanguage: null on empty or balanced input', () => {
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage(null), null);
  assert.equal(detectLanguage('que the for con'), null);
});

test('exchanges() returns copies; summary counts statuses', () => {
  const log = createExchangeLog();
  log.beginUser('hola que hace', '2026-11-20T10:00:00Z');
  log.setAssistant('hola, listo', '2026-11-20T10:00:01Z');
  log.beginUser('otra pregunta sobre el modo', '2026-11-20T10:02:00Z');
  log.abort('2026-11-20T10:02:05Z');
  const list = log.exchanges();
  assert.equal(list.length, 2);
  assert.equal(list[0].status, EXCHANGE_STATUS.answered);
  assert.equal(list[1].status, EXCHANGE_STATUS.aborted);
  const s = log.summary();
  assert.deepEqual(s.status, { pending: 0, answered: 1, aborted: 1 });
  assert.equal(s.language, 'es');
});

test('userText: string and text-block content; assistantText requires role', () => {
  assert.equal(userText({ content: 'plain' }), 'plain');
  assert.equal(
    userText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }),
    'a\nb'
  );
  assert.equal(userText(null), '');
  assert.equal(assistantText({ role: 'user', content: 'no' }), '');
  assert.equal(assistantText({ role: 'assistant', content: 'yes' }), 'yes');
});

// Smoke-test finding (2026-11-20): Escape during streaming delivers
// message_end with an empty assistant message, stopReason 'aborted'. The
// exchange must be recorded as aborted (R1 markers), never answered-empty.
test('setAssistant: empty assistant text with stopReason aborted records the abort', () => {
  const log = createExchangeLog();
  log.beginUser('escribe un ensayo largo sobre rios', '2026-11-20T10:00:00Z');
  log.setAssistant('', '2026-11-20T10:00:01Z', { stopReason: 'aborted' });
  const e = log.exchanges().at(-1);
  assert.equal(e.status, EXCHANGE_STATUS.aborted);
  assert.equal(e.user.cancelled, true);
  assert.equal(e.assistant.marker, ABORTED_PI_MARKER);
  assert.equal(e.assistant.text, null);
});

test('setAssistant: non-empty aborted assistant keeps the aborted status too', () => {
  const log = createExchangeLog();
  log.beginUser('para con esto', '2026-11-20T10:00:00Z');
  log.setAssistant('texto parcial d', '2026-11-20T10:00:01Z', { stopReason: 'aborted' });
  const e = log.exchanges().at(-1);
  assert.equal(e.status, EXCHANGE_STATUS.aborted);
  assert.equal(e.assistant.marker, ABORTED_PI_MARKER);
});

test('abort(): also overrides an empty answered exchange left by an aborted run', () => {
  const log = createExchangeLog();
  log.beginUser('continua el plan', '2026-11-20T10:00:00Z');
  log.setAssistant('', '2026-11-20T10:00:01Z'); // no stopReason passed; host variant
  log.abort('2026-11-20T10:00:02Z');
  const e = log.exchanges().at(-1);
  assert.equal(e.status, EXCHANGE_STATUS.aborted);
  assert.equal(e.assistant.marker, ABORTED_PI_MARKER);
});

// S10 (recap-deck, live probe 2026-11-21): a tool-using turn emits several
// assistant messages. Only the final one (stopReason other than 'toolUse')
// answers the exchange; the turn's tokens and tool calls accumulate.
test('S10: a toolUse message keeps the exchange pending and accumulates the turn', () => {
  const log = createExchangeLog();
  log.beginUser('corre echo y decime qué imprime', '2026-11-21T10:00:00.000Z');
  const mid = log.setAssistant('', '2026-11-21T10:00:00.010Z', {
    stopReason: 'toolUse', usage: { input: 900, output: 13 }, toolCalls: 1,
  });
  assert.equal(mid.status, EXCHANGE_STATUS.pending, 'a tool call is not the answer');
  assert.equal(log.pending().id, mid.id);
  const done = log.setAssistant('Imprimió tool-ok.', '2026-11-21T10:00:02.000Z', {
    stopReason: 'stop', usage: { input: 950, output: 8 }, toolCalls: 0,
    doneTs: '2026-11-21T10:00:03.500Z',
  });
  assert.equal(done.status, EXCHANGE_STATUS.answered);
  assert.equal(done.assistant.text, 'Imprimió tool-ok.', 'the final reply text, not the empty tool message');
  assert.equal(done.assistant.ts, '2026-11-21T10:00:02.000Z');
  assert.equal(done.assistant.doneTs, '2026-11-21T10:00:03.500Z');
  assert.deepEqual(done.assistant.tokens, { input: 1850, output: 21 }, 'summed over the turn');
  assert.equal(done.assistant.toolCalls, 1);
});

test('S10: a plain reply records doneTs, tokens and zero tool calls', () => {
  const log = createExchangeLog();
  log.beginUser('hola', '2026-11-21T10:00:00.000Z');
  const e = log.setAssistant('chau', '2026-11-21T10:00:00.020Z', {
    stopReason: 'stop', usage: { input: 10, output: 2 }, doneTs: '2026-11-21T10:00:01.000Z',
  });
  assert.equal(e.assistant.doneTs, '2026-11-21T10:00:01.000Z');
  assert.deepEqual(e.assistant.tokens, { input: 10, output: 2 });
  assert.equal(e.assistant.toolCalls, 0);
});

test('S10: missing usage degrades to null tokens and no doneTs is never invented', () => {
  const log = createExchangeLog();
  log.beginUser('hola', '2026-11-21T10:00:00.000Z');
  const e = log.setAssistant('chau', '2026-11-21T10:00:00.020Z');
  assert.equal(e.status, EXCHANGE_STATUS.answered, 'no stopReason keeps the previous behavior');
  assert.equal(e.assistant.tokens, null);
  assert.equal(e.assistant.doneTs, null);
  assert.equal(e.assistant.toolCalls, 0);
});

test('S10: an abort after tool calls keeps the abort markers', () => {
  const log = createExchangeLog();
  log.beginUser('hacé muchas cosas', '2026-11-21T10:00:00.000Z');
  log.setAssistant('', '2026-11-21T10:00:00.010Z', { stopReason: 'toolUse', usage: { input: 5, output: 5 }, toolCalls: 2 });
  const e = log.setAssistant('', '2026-11-21T10:00:05.000Z', { stopReason: 'aborted' });
  assert.equal(e.status, EXCHANGE_STATUS.aborted);
  assert.equal(e.assistant.marker, ABORTED_PI_MARKER);
  assert.equal(e.assistant.text, null);
});

test('S3: seedNextId continues ids above a resumed journal without collisions', () => {
  const log = createExchangeLog();
  // A resumed journal already holds ids 1..3; the next exchange must be 4.
  log.seedNextId(3);
  log.beginUser('primero', '2026-11-23T10:00:00.000Z');
  log.beginUser('segundo', '2026-11-23T10:00:05.000Z');
  const all = log.exchanges();
  assert.deepEqual(all.map((e) => e.id), [4, 5]);
});

test('S3: seedNextId below or equal to the natural counter never regresses', () => {
  const log = createExchangeLog();
  log.beginUser('primero', '2026-11-23T10:00:00.000Z');
  log.seedNextId(0); // a fresh journal reports 0; the counter must stay 2
  log.beginUser('segundo', '2026-11-23T10:00:05.000Z');
  assert.deepEqual(log.exchanges().map((e) => e.id), [1, 2]);
});
