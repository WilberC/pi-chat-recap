import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const piStub = () => {
  const handlers = new Map(); const commands = new Map();
  return { handlers, commands, api: {
    on: (e, fn) => { handlers.set(e, fn); return () => {}; },
    registerCommand: (n, o) => commands.set(n, o),
  } };
};

test('adapter registers the documented handlers and one command (1d,1e)', async () => {
  const s = piStub(); const { default: ext } = await import('./index.ts');
  ext(s.api);
  assert.deepEqual([...s.handlers.keys()].sort(),
    ['agent_settled', 'message_end', 'message_start', 'session_shutdown', 'session_start']);
  assert.ok(s.commands.get('chat-recap').description);
});

test('records exchange, abort and language from real event shapes (1a,1b)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-adapter-'));
  const sessionFile = join(dir, 'session.jsonl');
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const notes = [];
  const ctx = { ui: { notify: (m, t) => notes.push([m, t]) },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'sess-42' } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'que hace el sidecar' }] } }, ctx);
  await s.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Muestra estado' }] } }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'cancel' } }, ctx);
  await s.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx);
  await s.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
  await s.commands.get('chat-recap').handler('', ctx);
  const recs = readFileSync(join(dir, 'session.pi-chat-recap.journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const last = (id) => recs.filter((r) => r.data.id === id).at(-1).data;
  assert.equal(last(1).status, 'answered');
  assert.equal(last(1).assistant.text, 'Muestra estado');
  assert.equal(last(2).status, 'aborted');
  assert.equal(last(2).assistant.marker, 'No response (operation aborted)');
  assert.ok(recs.every((r) => r.sessionId === 'sess-42'), 'journal lines carry the host session id');
  assert.match(notes.at(-1)[0], /2 exchanges .*answered 1, aborted 1/);
  assert.equal(notes.at(-1)[1], 'info');
  rmSync(dir, { recursive: true, force: true });
});

test('message timestamps come from message.timestamp, not event.timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-ts-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl') } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1763000000000 }, event: { timestamp: 1763999999999 } }, ctx);
  // F6: the exchange is journaled when it resolves, not on the pending
  // transition; the assertion below still pins the timestamp source.
  await s.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', content: 'hola', stopReason: 'stop' }, event: { timestamp: 1763999999999 } }, ctx);
  const rec = JSON.parse(readFileSync(join(dir, 's.pi-chat-recap.journal.jsonl'), 'utf8').trim());
  assert.equal(rec.data.user.ts, new Date(1763000000000).toISOString());
  rmSync(dir, { recursive: true, force: true });
});

test('extension-authored messages never begin an exchange (advisory 3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-custom-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl') } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', customType: 'review-reminder', content: 'extension instruction' } }, ctx);
  assert.equal(existsSync(join(dir, 's.pi-chat-recap.journal.jsonl')), false, 'no exchange record for extension-authored messages');
  rmSync(dir, { recursive: true, force: true });
});

// S10 adapter wiring, with the event shapes of the live probe: the first
// assistant message is a toolUse with no text, the final one carries the text.
// F6 (latency): each assistant message_end used to sync-append the whole
// exchange text, so a tool-loop turn wrote the full record once per tool
// step. The exchange is now journaled exactly once, in its final form.
test('S10/F6: a tool-using turn journals exactly one exchange record, its final form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-s10-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl'), getSessionId: () => 'sess-s10' } };
  const journalFile = join(dir, 's.pi-chat-recap.journal.jsonl');
  const exchangeRecords = () => (existsSync(journalFile)
    ? readFileSync(journalFile, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.type === 'exchange')
    : []);
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'run echo', timestamp: 1763718000000 } }, ctx);
  // Nothing is journaled while the exchange is still pending (F6 tradeoff:
  // a Pi crash mid-turn loses the pending text; this is a recap, not a
  // source of truth).
  assert.equal(exchangeRecords().length, 0, 'the pending exchange is not journaled before it resolves');
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'toolUse', timestamp: 1763718000017,
    content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo tool-ok' } }],
    usage: { input: 900, output: 13 } } }, ctx);
  assert.equal(exchangeRecords().length, 0, 'a tool step never re-appends the pending record');
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'toolUse', timestamp: 1763718000500,
    content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo tool-ok-2' } }],
    usage: { input: 40, output: 4 } } }, ctx);
  assert.equal(exchangeRecords().length, 0, 'a second tool step still appends nothing');
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'stop', timestamp: 1763718001000,
    content: [{ type: 'text', text: 'It printed tool-ok.' }],
    usage: { input: 950, output: 8 } } }, ctx);
  const ex = exchangeRecords();
  assert.equal(ex.length, 1, 'one journal append for the whole turn, not one per tool step');
  assert.equal(ex[0].data.id, 1, 'one exchange for the whole turn');
  const last = ex.at(-1).data;
  assert.equal(last.status, 'answered');
  assert.equal(last.assistant.text, 'It printed tool-ok.');
  assert.equal(last.assistant.ts, new Date(1763718001000).toISOString());
  assert.ok(Date.parse(last.assistant.doneTs) >= Date.parse(last.user.ts), 'doneTs is a real time after the send');
  assert.equal(last.assistant.tokens.input, 1890, 'summed over the turn');
  assert.equal(last.assistant.tokens.output, 25, 'summed over the turn');
  assert.equal(last.assistant.toolCalls, 2);
  await s.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
  assert.equal(exchangeRecords().length, 1, 'the settling turn appends nothing more for a resolved exchange');
  rmSync(dir, { recursive: true, force: true });
});

// S4: the journaled record keeps the exact contract from README (line
// envelope + exchange data), so renderers fold the same bytes as before.
test('S4/F6: a simple exchange journals one line with the unchanged shape and payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-format-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl'), getSessionId: () => 'sess-format' } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'hola recap', timestamp: 1763718100000 } }, ctx);
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'stop', timestamp: 1763718100050,
    content: [{ type: 'text', text: 'chau' }], usage: { input: 10, output: 3 } } }, ctx);
  const recs = readFileSync(join(dir, 's.pi-chat-recap.journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(recs.length, 1, 'a simple exchange is one line, exactly like a tool-using turn');
  const rec = recs[0];
  assert.deepEqual(Object.keys(rec), ['v', 'producer', 'sessionId', 'ts', 'type', 'data']);
  assert.equal(rec.v, 1);
  assert.equal(rec.producer, 'pi-chat-recap');
  assert.equal(rec.sessionId, 'sess-format');
  assert.equal(rec.type, 'exchange');
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(rec.data), ['id', 'status', 'user', 'assistant']);
  assert.equal(rec.data.id, 1);
  assert.equal(rec.data.status, 'answered');
  assert.deepEqual(rec.data.user, {
    text: 'hola recap', ts: new Date(1763718100000).toISOString(), cancelled: false });
  assert.deepEqual(Object.keys(rec.data.assistant), ['text', 'ts', 'marker', 'doneTs', 'tokens', 'toolCalls']);
  assert.equal(rec.data.assistant.text, 'chau');
  assert.equal(rec.data.assistant.ts, new Date(1763718100050).toISOString());
  assert.equal(rec.data.assistant.marker, null);
  assert.match(rec.data.assistant.doneTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(rec.data.assistant.tokens, { input: 10, output: 3 });
  assert.equal(rec.data.assistant.toolCalls, 0);
  rmSync(dir, { recursive: true, force: true });
});

// PRESERVE: a turn that settles without a final reply still leaves its
// exchange in the journal once (previously the message_start pending
// append); the deferred write moved, the record did not disappear.
test('F6: a turn that settles with no final reply still journals its exchange once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-settle-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl'), getSessionId: () => 'sess-settle' } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'contá hasta tres', timestamp: 1763718200000 } }, ctx);
  await s.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
  const recs = readFileSync(join(dir, 's.pi-chat-recap.journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((r) => r.type === 'exchange');
  assert.equal(recs.length, 1, 'the settled turn appends its exchange exactly once');
  assert.equal(recs[0].data.status, 'pending');
  assert.equal(recs[0].data.user.text, 'contá hasta tres');
  assert.equal(recs[0].data.user.ts, new Date(1763718200000).toISOString());
  rmSync(dir, { recursive: true, force: true });
});
