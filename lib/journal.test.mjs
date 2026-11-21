import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal, journalPathFor, parseJournal, maxExchangeIdIn, JOURNAL_VERSION } from './journal.mjs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

test('journal appends contract lines next to the session file', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'recap-journal-'));
  const sessionFile = join(dir, 'session-a.jsonl');
  const j = createJournal({ file: '', sessionId: 's1', producer: 'pi-chat-recap' });
  const target = j.openSession(sessionFile);
  // Per-session layout: one journal named after the session file, so two
  // sessions in the same directory never share history.
  assert.equal(target, join(dir, 'session-a.pi-chat-recap.journal.jsonl'));
  const line = j.append('exchange', { id: 1, status: 'aborted' });
  const parsed = JSON.parse(line);
  assert.equal(parsed.v, JOURNAL_VERSION);
  assert.equal(parsed.producer, 'pi-chat-recap');
  assert.equal(parsed.sessionId, 's1');
  assert.equal(parsed.type, 'exchange');
  assert.deepEqual(parsed.data, { id: 1, status: 'aborted' });
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(parseJournal(readFileSync(target, 'utf8')).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('append before openSession is a no-op; close stops writes', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'recap-journal-'));
  const j = createJournal({ file: join(dir, 'x.jsonl'), sessionId: 's1', producer: 'p' });
  assert.equal(j.append('t', {}), null);
  j.openSession(join(dir, 'session.jsonl'));
  assert.equal(j.isOpen(), true);
  j.close();
  assert.equal(j.append('t', {}), null);
  assert.equal(j.target(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rebinding to a new session switches the file', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'recap-journal-'));
  const j = createJournal({ file: '', sessionId: 's1', producer: 'p' });
  j.openSession(join(dir, 'a.jsonl'));
  j.openSession(join(dir, 'b.jsonl'));
  j.append('t', { n: 1 });
  assert.equal(readFileSync(join(dir, 'b.p.journal.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  // Each session file owns its own journal: rebinding left no shared file.
  assert.equal(fs.existsSync(join(dir, 'p.journal.jsonl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journalPathFor keeps the full stem for edge-case session names', () => {
  const dir = '/s/x';
  // Multi-dot Pi-style session names keep everything before the final
  // extension (S5): renderer and producer must agree byte for byte.
  assert.equal(journalPathFor(`${dir}/2026-11-22T03-12-00Z_abc.jsonl`, 'pi-chat-recap'), `${dir}/2026-11-22T03-12-00Z_abc.pi-chat-recap.journal.jsonl`);
  // A name without an extension is its own stem.
  assert.equal(journalPathFor(`${dir}/session`, 'p'), `${dir}/session.p.journal.jsonl`);
  // A relative bare name has no directory component.
  assert.equal(journalPathFor('session.jsonl', 'p'), 'session.p.journal.jsonl');
});

test('parseJournal tolerates blank and torn lines', () => {
  const records = parseJournal('{"a":1}\n\n{broken\n{"a":2}\n');
  assert.deepEqual(records.map((r) => r.a), [1, 2]);
  assert.equal(parseJournal('').length, 0);
  assert.equal(journalPathFor('/s/x/session.jsonl', 'pi-chat-recap'), '/s/x/session.pi-chat-recap.journal.jsonl');
});

test('maxExchangeIdIn reads the highest exchange id across the whole file', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'recap-journal-'));
  const file = join(dir, 'session.pi-chat-recap.journal.jsonl');
  assert.equal(maxExchangeIdIn(file), 0); // missing file is 0, never an error
  fs.writeFileSync(file, [
    JSON.stringify({ v: 1, producer: 'p', sessionId: 's', ts: 't', type: 'exchange', data: { id: 2, status: 'answered' } }),
    JSON.stringify({ v: 1, producer: 'p', sessionId: 's', ts: 't', type: 'summary', data: { exchangeId: 2 } }),
    JSON.stringify({ v: 1, producer: 'p', sessionId: 's', ts: 't', type: 'exchange', data: { id: 5, status: 'pending' } }),
    JSON.stringify({ v: 1, producer: 'p', sessionId: 's', ts: 't', type: 'exchange', data: { id: 4, status: 'answered' } }),
    '{broken\n',
  ].join('\n') + '\n', 'utf8');
  assert.equal(maxExchangeIdIn(file), 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
