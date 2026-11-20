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
