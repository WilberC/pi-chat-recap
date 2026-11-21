import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// F8 (latency): a resumed or reloaded session must not replay its journal back
// into itself. The journal already holds the session's exchanges, so replaying
// them was one synchronous append per exchange inside Pi's process (cost grows
// with the conversation) and it duplicated history the renderer had already
// folded. session_start now only seeds the in-memory log from the journal.
const startSession = (s, ctx, reason = 'startup') =>
  s.handlers.get('session_start')({ type: 'session_start', reason }, ctx);

const journalRecords = (file) => (existsSync(file)
  ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);

test('F8/S2: resuming a journal with N exchanges appends nothing and seeds state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-resume-'));
  const sessionFile = join(dir, 'session.jsonl');
  const journalFile = join(dir, 'session.pi-chat-recap.journal.jsonl');
  const ctxFor = (notes) => ({
    ui: { notify: (m, t) => notes.push([m, t]) },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'sess-resume' },
  });
  const { default: ext } = await import('./index.ts');

  // First activation records two exchanges: an answered Spanish one and an
  // aborted one.
  const first = piStub(); ext(first.api);
  const ctx1 = ctxFor([]);
  await startSession(first, ctx1);
  await first.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'que hace el sidecar', timestamp: 1763718300000 } }, ctx1);
  await first.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718300050, content: [{ type: 'text', text: 'Muestra estado' }] } }, ctx1);
  await first.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'cancelá eso', timestamp: 1763718310000 } }, ctx1);
  await first.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx1);
  const before = journalRecords(journalFile);
  assert.equal(before.filter((r) => r.type === 'exchange').length, 2, 'the first run journaled two exchanges');
  await first.handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx1);

  // Resume inside the same process (Pi rebinds session_start on /resume): the
  // in-memory log still holds the two exchanges and they used to be replayed
  // straight back into the journal they came from.
  await startSession(first, ctx1, 'resume');
  assert.deepEqual(journalRecords(journalFile), before,
    'a same-process resume re-appends nothing: the journal is the source, not a sink');

  // Reload: a fresh activation over the same session file.
  const second = piStub(); ext(second.api);
  const notes = [];
  const ctx2 = ctxFor(notes);
  await startSession(second, ctx2);
  assert.deepEqual(journalRecords(journalFile), before,
    'session_start writes nothing back into the journal it just read: zero exchange appends');

  // The in-memory log state comes from the journal: counts, statuses and the
  // session language fixed by the first exchange.
  await second.commands.get('chat-recap').handler('', ctx2);
  assert.match(notes.at(-1)[0], /chat-recap: 2 exchanges .*answered 1, aborted 1, pending 0/);
  assert.match(notes.at(-1)[0], /language=es/);
  assert.equal(notes.at(-1)[1], 'info');

  // Ids continue above the recorded maximum, and only the new activity is
  // journaled.
  await second.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'nueva pregunta', timestamp: 1763718320000 } }, ctx2);
  await second.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718320100, content: [{ type: 'text', text: 'nueva respuesta' }] } }, ctx2);
  const after = journalRecords(journalFile);
  assert.deepEqual(after.slice(0, before.length), before, 'the restored records are untouched, not rewritten');
  assert.equal(after.length, before.length + 1, 'exactly one new line for one new exchange');
  const added = after.at(-1).data;
  assert.equal(added.id, 3, 'the resumed session continues above the journal max id');
  assert.equal(added.status, 'answered');
  assert.equal(added.user.text, 'nueva pregunta');
  rmSync(dir, { recursive: true, force: true });
});

// S4 (preserve): a resumed session answering a new exchange journals exactly
// the record a never-resumed session would, for the new activity only. The
// control run and the resumed run use the same message events, so the two
// records differ only in id and in the wall-clock `doneTs`.
test('S4/F8: a resumed session journals the same new-activity record as a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-resume-parity-'));
  const sessionFile = join(dir, 's.jsonl');
  const journalFile = join(dir, 's.pi-chat-recap.journal.jsonl');
  const ctx = { ui: { notify() {} },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'sess-parity' } };
  const { default: ext } = await import('./index.ts');
  const ask = async (s) => {
    await s.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'hola recap', timestamp: 1763718400000 } }, ctx);
    await s.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718400050, content: [{ type: 'text', text: 'chau' }], usage: { input: 10, output: 3 } } }, ctx);
  };
  const strip = (rec) => ({
    ...rec,
    ts: '<ts>',
    data: { ...rec.data, id: '<id>', assistant: { ...rec.data.assistant, doneTs: '<doneTs>' } },
  });

  // Control: a fresh session answers once.
  const control = piStub(); ext(control.api);
  await startSession(control, ctx);
  await ask(control);
  await control.handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx);
  const controlRec = journalRecords(journalFile).at(-1);
  assert.match(controlRec.data.assistant.doneTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Resumed session, same session file, same events.
  const resumed = piStub(); ext(resumed.api);
  await startSession(resumed, ctx);
  await ask(resumed);
  const records = journalRecords(journalFile);
  const resumedRec = records.at(-1);
  assert.equal(records.length, 2, 'the resume added exactly the new exchange line and nothing else');
  assert.equal(resumedRec.data.id, 2);
  assert.deepEqual(strip(resumedRec), strip(controlRec),
    'the new-activity record is identical to the never-resumed one');
  rmSync(dir, { recursive: true, force: true });
});

// S4 (preserve): on a resumed session the abort path and the settled-turn path
// keep their behavior, and a restored record is never written again.
test('S4/F8: a resumed session keeps the abort and settled-turn paths unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-resume-abort-'));
  const sessionFile = join(dir, 's.jsonl');
  const journalFile = join(dir, 's.pi-chat-recap.journal.jsonl');
  const notes = [];
  const ctx = { ui: { notify: (m, t) => notes.push([m, t]) },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'sess-abort' } };
  const { default: ext } = await import('./index.ts');

  // Prior run: exchange 1 answered, exchange 2 left pending by a turn that
  // settled without a final reply.
  const first = piStub(); ext(first.api);
  await startSession(first, ctx);
  await first.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'primera', timestamp: 1763718500000 } }, ctx);
  await first.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718500050, content: 'listo' } }, ctx);
  await first.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'segunda', timestamp: 1763718510000 } }, ctx);
  await first.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
  const before = journalRecords(journalFile);
  await first.handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx);

  const second = piStub(); ext(second.api);
  await startSession(second, ctx);
  // An abort with no new turn in this run must not rewrite the restored
  // pending record (it is already journaled).
  await second.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx);
  assert.deepEqual(journalRecords(journalFile), before, 'a restored record is never re-appended');
  // The aborted exchange of this run keeps the R1 markers, with the next id.
  await second.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'cancelá eso', timestamp: 1763718520000 } }, ctx);
  await second.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx);
  const aborted = journalRecords(journalFile).at(-1).data;
  assert.equal(aborted.id, 3);
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.assistant.marker, 'No response (operation aborted)');
  assert.equal(aborted.user.cancelled, true);
  // A turn that settles without a final reply still journals its exchange once.
  await second.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'tercera', timestamp: 1763718530000 } }, ctx);
  await second.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
  const settled = journalRecords(journalFile).at(-1).data;
  assert.equal(settled.id, 4);
  assert.equal(settled.status, 'pending');
  await second.commands.get('chat-recap').handler('', ctx);
  assert.match(notes.at(-1)[0], /chat-recap: 4 exchanges .*answered 1, aborted 1, pending 2/);
  rmSync(dir, { recursive: true, force: true });
});

// T3 (hardening): a live Pi session can reload index.ts while Node's ESM
// module cache still serves the OLD lib/exchange.mjs, so the log the adapter
// holds has no lastExchange method and agent_settled threw
// "log.lastExchange is not a function" inside ExtensionRunner.emit.
// This reproduces that reload: the working index.ts next to a lib/exchange.mjs
// whose createExchangeLog hides lastExchange (the pre-F7 shape), imported from
// a temp dir so the sibling really is stale.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const installStaleSibling = (dir) => {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(join(repoRoot, 'index.ts'), join(dir, 'index.ts'));
  const url = (name) => pathToFileURL(join(repoRoot, 'lib', name)).href;
  for (const name of ['journal.mjs', 'summary.mjs', 'config.mjs']) {
    writeFileSync(join(dir, 'lib', name), `export * from ${JSON.stringify(url(name))};\n`);
  }
  writeFileSync(join(dir, 'lib', 'exchange.mjs'), [
    `export * from ${JSON.stringify(url('exchange.mjs'))};`,
    `import { createExchangeLog as freshLog } from ${JSON.stringify(url('exchange.mjs'))};`,
    '// The cached module predates the targeted lookup.',
    'export function createExchangeLog(options) {',
    '  const log = freshLog(options);',
    '  delete log.lastExchange;',
    '  return log;',
    '}',
    '',
  ].join('\n'));
};

test('T3: agent_settled survives a stale sibling module without lastExchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-stale-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  // Model mode makes the answered lookup observable: only a handler that
  // found the answered exchange reaches summarization and records its failure.
  writeFileSync(join(home, '.pi', 'agent', 'pi-chat-recap.json'),
    JSON.stringify({ mode: 'model', model: 'stub/model-x' }));
  installStaleSibling(join(dir, 'ext'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: ext } = await import(pathToFileURL(join(dir, 'ext', 'index.ts')).href);

    // (a) The settled-turn lookup with no predicate: a turn that settles with
    // its exchange still pending must journal it, not throw.
    const settledRun = piStub();
    ext(settledRun.api);
    const settledSession = join(dir, 'settled.jsonl');
    const settledCtx = { ui: { notify() {} },
      sessionManager: { getSessionFile: () => settledSession, getSessionId: () => 'sess-stale-pending' } };
    await startSession(settledRun, settledCtx);
    await settledRun.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'sin respuesta todavia', timestamp: 1763718600000 } }, settledCtx);
    await settledRun.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, settledCtx);
    const settledRecords = journalRecords(join(dir, 'settled.pi-chat-recap.journal.jsonl'));
    assert.deepEqual(settledRecords.filter((r) => r.type === 'exchange').map((r) => [r.data.id, r.data.status]),
      [[1, 'pending']], 'the fallback lookup publishes the pending exchange exactly once');

    // (b) The answered lookup still selects the answered exchange.
    const answeredRun = piStub();
    ext(answeredRun.api);
    const answeredSession = join(dir, 'answered.jsonl');
    const notes = [];
    const answeredCtx = { ui: { notify: (m) => notes.push(m) },
      sessionManager: { getSessionFile: () => answeredSession, getSessionId: () => 'sess-stale-answered' } };
    await startSession(answeredRun, answeredCtx);
    await answeredRun.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'que hace el sidecar', timestamp: 1763718610000 } }, answeredCtx);
    await answeredRun.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718610050, content: 'Muestra estado' } }, answeredCtx);
    await answeredRun.handlers.get('agent_settled')({ type: 'agent_settled', aborted: false }, answeredCtx);
    const answeredRecords = journalRecords(join(dir, 'answered.pi-chat-recap.journal.jsonl'));
    assert.equal(answeredRecords.filter((r) => r.type === 'exchange').length, 1,
      'settling adds nothing for the already journaled exchange');
    assert.equal(answeredRecords.filter((r) => r.type === 'summary').length, 0, 'the stubbed model produced no summary');
    const warnings = answeredRecords.filter((r) => r.type === 'recap_warning').map((r) => r.data.message);
    assert.equal(warnings.length, 1, 'the answered lookup found the exchange and reached summarization');
    assert.match(warnings[0], /summary models all failed .*not found in the registry/);
    assert.equal(notes.length, 1, 'the warning is also surfaced to the user once');

    // (c) The abort branch selects its recovery target through the same
    // lookup: an aborted run with no pending exchange must record the R1
    // markers, and no model call may happen (S5).
    const abortRun = piStub();
    ext(abortRun.api);
    const abortSession = join(dir, 'abort.jsonl');
    const abortCtx = { ui: { notify() {} },
      sessionManager: { getSessionFile: () => abortSession, getSessionId: () => 'sess-stale-abort' } };
    await startSession(abortRun, abortCtx);
    await abortRun.handlers.get('message_start')({ type: 'message_start', message: { role: 'user', content: 'cancelalo', timestamp: 1763718620000 } }, abortCtx);
    // An answered record with empty text is the shape abort() recovers.
    await abortRun.handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', timestamp: 1763718620050, content: [] } }, abortCtx);
    await abortRun.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, abortCtx);
    const abortRecords = journalRecords(join(dir, 'abort.pi-chat-recap.journal.jsonl'));
    const aborted = abortRecords.filter((r) => r.data?.id === 1).at(-1).data;
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.user.text, 'cancelalo');
    assert.equal(aborted.assistant.marker, 'No response (operation aborted)');
    assert.equal(abortRecords.filter((r) => ['summary', 'recap_warning'].includes(r.type)).length, 0,
      'an aborted exchange gets no summary and no warning (S5)');
  } finally {
    process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// S4 (preserve): the compat lookup is a stand-in for the targeted lookup, not
// a second behavior. On a log that has lastExchange the fast path answers, and
// both paths return the same record for the same predicate.
test('T3/S4: the compat lookup matches the fast path on a current log', async () => {
  const { lastExchangeCompat } = await import('./index.ts');
  const { createExchangeLog, EXCHANGE_STATUS } = await import('./lib/exchange.mjs');
  const build = () => {
    const log = createExchangeLog();
    log.beginUser('primera', 'ts-1');
    log.setAssistant('uno', 'ts-2', {});
    log.beginUser('segunda', 'ts-3');
    log.setAssistant('dos', 'ts-4', {});
    log.beginUser('tercera', 'ts-5');
    return log;
  };
  const current = build();
  const stale = build();
  delete stale.lastExchange; // the cached pre-F7 module's shape
  assert.equal(typeof stale.lastExchange, 'undefined', 'the stale log really has no targeted lookup');

  const predicates = [
    undefined,
    (e) => e.status === EXCHANGE_STATUS.answered,
    (e) => e.status === EXCHANGE_STATUS.aborted,
  ];
  for (const predicate of predicates) {
    assert.deepEqual(lastExchangeCompat(stale, predicate), lastExchangeCompat(current, predicate),
      `the fallback returns what lastExchange returns (${predicate ?? 'no predicate'})`);
  }
  assert.equal(lastExchangeCompat(stale, (e) => e.status === EXCHANGE_STATUS.answered).id, 2);
  assert.equal(lastExchangeCompat(stale).id, 3, 'the no-predicate lookup still means the last exchange');
  assert.equal(lastExchangeCompat(stale, (e) => e.status === EXCHANGE_STATUS.aborted), null);

  // Same clone contract as lastExchange: the returned record is a copy.
  const found = lastExchangeCompat(stale);
  found.user.text = 'mutado';
  assert.equal(lastExchangeCompat(stale).user.text, 'tercera', 'the log is never handed out live');
});
