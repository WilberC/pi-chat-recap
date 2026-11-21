// Append-only JSONL journal (producer-only). One file per session, written
// next to the Pi session file; consumers (herdr-sidecar or any renderer)
// tail it and own all presentation. Line contract:
//   {v:1, producer, sessionId, ts, type, data}
// Consumers must tolerate unknown fields and unknown `type` values.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export const JOURNAL_VERSION = 1;

// Per-session layout (S1/S5): one journal per session file, named after the
// session file's stem, so two sessions in the same directory never share
// history. The stem keeps everything before the final extension (a multi-dot
// Pi session name like `2026-11-22T03-12-00Z_abc.jsonl` is preserved whole).
export function journalPathFor(sessionFile, name) {
  const base = basename(sessionFile);
  const stem = base.slice(0, base.length - extname(base).length);
  return join(dirname(sessionFile), `${stem}.${name}.journal.jsonl`);
}

// S3 (per-session resume): the max `data.id` of the exchange records a
// journal file already holds, so a resumed session continues above it and
// the renderer's last-record-per-id fold never collides. A missing or
// unreadable file (fresh session, torn write) yields 0 — never an error.
export function maxExchangeIdIn(file) {
  if (!file) return 0;
  try {
    const text = readFileSync(file, 'utf8');
    let max = 0;
    for (const record of parseJournal(text)) {
      if (record?.type === 'exchange') {
        const id = Number(record?.data?.id);
        if (Number.isFinite(id) && id > max) max = id;
      }
    }
    return max;
  } catch {
    return 0;
  }
}

export function createJournal({ file, sessionId, producer, now = () => new Date().toISOString() } = {}) {
  let open = false;
  let sid = sessionId;

  const write = (type, data) => {
    if (!file || !open) return null;
    const line = JSON.stringify({
      v: JOURNAL_VERSION,
      producer,
      sessionId: sid,
      ts: now(),
      type,
      data,
    });
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${line}\n`, 'utf8');
      return line;
    } catch {
      // A journaling failure never breaks the host session; consumers
      // degrade explicitly when data is absent.
      return null;
    }
  };

  return {
    // Bind (or rebind) to a session file; call again on session switch.
    // An explicit sessionId updates the recorded id (advisory: the id comes
    // from the host at session_start, not at extension load).
    openSession(sessionFile, sessionId) {
      if (!sessionFile) {
        open = false;
        return null;
      }
      if (typeof sessionId === 'string' && sessionId !== '') sid = sessionId;
      file = journalPathFor(sessionFile, producer);
      open = true;
      return file;
    },

    close() {
      open = false;
    },

    isOpen() {
      return open;
    },

    target() {
      return open ? file : null;
    },

    append: write,
  };
}

// Parse a journal file's lines; skips blank and malformed lines so a torn
// tail write never breaks consumers.
export function parseJournal(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line; keep the rest.
    }
  }
  return records;
}
