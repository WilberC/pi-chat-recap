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
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1763000000000 } }, ctx);
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
test('S10: a tool-using turn journals the final reply with doneTs, tokens and tool calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-s10-'));
  const s = piStub(); const { default: ext } = await import('./index.ts'); ext(s.api);
  const ctx = { ui: { notify() {} }, sessionManager: { getSessionFile: () => join(dir, 's.jsonl'), getSessionId: () => 'sess-s10' } };
  await s.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'run echo', timestamp: 1763718000000 } }, ctx);
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'toolUse', timestamp: 1763718000017,
    content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo tool-ok' } }],
    usage: { input: 900, output: 13 } } }, ctx);
  await s.handlers.get('message_end')({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'stop', timestamp: 1763718001000,
    content: [{ type: 'text', text: 'It printed tool-ok.' }],
    usage: { input: 950, output: 8 } } }, ctx);
  const recs = readFileSync(join(dir, 's.pi-chat-recap.journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ex = recs.filter((r) => r.type === 'exchange');
  assert.ok(ex.every((r) => r.data.id === 1), 'one exchange for the whole turn');
  assert.ok(ex.slice(0, -1).every((r) => r.data.status === 'pending'), 'tool steps stay pending');
  const last = ex.at(-1).data;
  assert.equal(last.status, 'answered');
  assert.equal(last.assistant.text, 'It printed tool-ok.');
  assert.equal(last.assistant.ts, new Date(1763718001000).toISOString());
  assert.ok(Date.parse(last.assistant.doneTs) >= Date.parse(last.user.ts), 'doneTs is a real time after the send');
  assert.deepEqual(last.assistant.tokens, { input: 1850, output: 21 });
  assert.equal(last.assistant.toolCalls, 1);
  rmSync(dir, { recursive: true, force: true });
});
