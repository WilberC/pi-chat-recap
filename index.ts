import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createExchangeLog,
  userText,
  assistantText,
  EXCHANGE_STATUS,
} from './lib/exchange.mjs';
import { createJournal, parseJournal } from './lib/journal.mjs';
import { createSummarizer, loadPromptFile } from './lib/summary.mjs';
import { loadRecapConfig, recapPaths } from './lib/config.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// T3 (hardening): a live Pi session can reload this file while Node's ESM
// module cache still serves the OLD lib/exchange.mjs, so the log has no
// lastExchange method and agent_settled threw "log.lastExchange is not a
// function" from inside ExtensionRunner.emit. A stale sibling only lacks the
// targeted lookup; exchanges() and its clone contract are unchanged, so the
// whole-list scan is a faithful stand-in (same record, same null, same copy).
// Remove once reloads always pick up fresh sibling modules.
export const lastExchangeCompat = (log: any, predicate?: (exchange: any) => boolean) => {
  if (typeof log.lastExchange === 'function') return log.lastExchange(predicate);
  const test = typeof predicate === 'function' ? predicate : () => true;
  return log.exchanges().filter((exchange) => test(exchange)).at(-1) ?? null;
};

// pi-chat-recap: producer-only conversation data. It records what happened
// (user text, assistant text, cancellations, session language) and renders
// nothing. Renderers such as herdr-sidecar consume the data; they never
// re-derive exchange semantics.
export default function chatRecap(pi: ExtensionAPI) {
  // F8: one log per session. session_start rebuilds it from the bound
  // journal, so a /resume or a session switch never inherits the previous
  // session's exchanges, ids or language.
  let log = createExchangeLog();
  // Ids that came from the journal (F8): they are already durable, so the
  // writer below must never append them a second time.
  let restoredIds = new Set();
  const journal = createJournal({ sessionId: '', producer: 'pi-chat-recap' });

  // Config and prompt live in editable files (R4/S4); they are re-read per
  // summarization so edits apply on the next exchange without a reinstall.
  const paths = recapPaths(join(homedir(), '.pi', 'agent'));
  let configWarned = false;
  let noModelWarned = false;

  const runSummarizer = (exchange) => {
    // R4: fresh config + prompt per call; every problem is a surfaced
    // warning, never a silent fallback.
    const { config, warnings: cfgWarnings } = loadRecapConfig(join(homedir(), '.pi', 'agent'));
    const prompt = loadPromptFile(paths.prompt);
    const summarizer = createSummarizer({
      callModel: async (req) => {
        const slash = req.model.indexOf('/');
        const model = ctxRef?.modelRegistry?.find?.(
          req.model.slice(0, slash),
          req.model.slice(slash + 1),
        );
        if (!model) throw new Error(`model "${req.model}" not found in the registry`);
        const result = await ctxRef.modelRegistry.complete(model, req.context, {
          maxTokens: req.maxOutputTokens,
        });
        const content = result?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => (b as { type?: string })?.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('\n')
            : '';
        return { text, tokens: result?.usage ?? null, stopReason: result?.stopReason ?? null };
      },
      config,
      loadPrompt: () => prompt,
      warn: (msg) => {
        journal.append('recap_warning', { message: msg });
        uiRef?.ui?.notify?.(`pi-chat-recap: ${msg}`, 'warning');
      },
      language: log.language(),
    });
    return summarizer.summarizeExchange(exchange);
  };

  let ctxRef = null;
  let uiRef = null;

  const warnOnce = (msg) => {
    journal.append('recap_warning', { message: msg });
    uiRef?.ui?.notify?.(`pi-chat-recap: ${msg}`, 'warning');
  };

  // F6 (latency): journal an exchange once, when it resolves (answered or
  // aborted) or when its turn settles without a final reply. Each assistant
  // message_end used to sync-append the full exchange text, so a tool-loop
  // turn re-appended the whole record once per tool step; the pending state
  // now lives in memory only and the journal gets the final form once.
  // Crash-safety tradeoff: if Pi dies mid-turn, the pending exchange text is
  // lost from the journal. That is acceptable for this feature — it is a
  // recap journal, not a source of truth.
  const publish = (exchange) => {
    // F8: a record restored from the journal is its source of truth; writing
    // it again would duplicate history the renderer already folded (it keeps
    // the last record per id, so it tolerated the old replay, but that replay
    // cost one synchronous append per exchange on every resume).
    if (!exchange || restoredIds.has(exchange.id)) return;
    journal.append('exchange', exchange);
  };
  const resolved = (exchange) =>
    exchange != null && exchange.status !== EXCHANGE_STATUS.pending;

  // The journal's records, parsed once. parseJournal keeps lib/journal.mjs's
  // line contract and torn-line tolerance; a missing or unreadable file is a
  // fresh session, never an error (same policy as maxExchangeIdIn, which
  // would parse the same file a second time — the startup cost F8 targets).
  const readJournalRecords = (file: string | null) => {
    if (!file) return [];
    try {
      return parseJournal(readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };

  // F8/S3: rebuild the in-memory log from the journal's records without
  // touching the journal. The log accepts entries only through its own
  // transitions, so each record is replayed through beginUser/setAssistant/
  // abort, which are pure in-memory; publish, the only writer, is not
  // involved. That restores the next id, the status counts and the language
  // the conversation was fixed to, so a resumed session behaves like one
  // that never reloaded. Returns the ids the log now holds.
  const seedFromJournal = (target, records: any[]) => {
    const folded = new Map();
    for (const record of records as any[]) {
      if (record?.type !== 'exchange') continue;
      const id = Number(record?.data?.id);
      // Consumers fold last-record-per-id; the same fold keeps an exchange
      // re-recorded later (e.g. an abort after an empty answered record)
      // single here.
      if (Number.isFinite(id)) folded.set(id, record.data);
    }
    const restored = new Set();
    let maxId = 0;
    for (const id of [...folded.keys()].sort((a, b) => a - b)) {
      const data: any = folded.get(id);
      if (id > maxId) maxId = id;
      const exchange = target.beginUser(data?.user?.text ?? '', data?.user?.ts ?? undefined);
      if (data?.status === EXCHANGE_STATUS.answered) {
        target.setAssistant(data?.assistant?.text ?? '', data?.assistant?.ts ?? undefined, {
          doneTs: data?.assistant?.doneTs ?? undefined,
          usage: data?.assistant?.tokens ?? undefined,
          toolCalls: data?.assistant?.toolCalls,
        });
      } else if (data?.status === EXCHANGE_STATUS.aborted) {
        target.abort(data?.assistant?.ts ?? undefined);
      }
      if (exchange) restored.add(exchange.id);
    }
    // S3 (per-session resume): ids continue above the recorded maximum,
    // including a journal with gaps left by a failed write.
    target.seedNextId(maxId);
    return restored;
  };

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    uiRef = ctx;
    const bound = journal.openSession(
      ctx.sessionManager?.getSessionFile?.(),
      ctx.sessionManager?.getSessionId?.(),
    );
    // F8 (latency): the journal already holds this session's exchanges, so
    // session_start loads them instead of replaying them back into it. The
    // old replay wrote every exchange again — one synchronous append per
    // exchange, O(conversation) inside Pi's process on every resume/reload.
    log = createExchangeLog();
    restoredIds = seedFromJournal(log, readJournalRecords(bound));
    // Surface config/prompt problems once at startup, not per exchange.
    const { warnings } = loadRecapConfig(join(homedir(), '.pi', 'agent'));
    for (const w of warnings) warnOnce(w);
    configWarned = warnings.length > 0;
    const { warnings: promptWarnings } = loadPromptFile(paths.prompt);
    for (const w of promptWarnings) warnOnce(w);
  });
  pi.on('session_shutdown', () => journal.close());

  const tsOf = (message: unknown) => {
    // Message events carry no event.timestamp; the timestamp lives on the
    // message itself (pi-ai UserMessage/AssistantMessage.timestamp: number).
    const ts = (message as { timestamp?: unknown } | undefined)?.timestamp;
    return typeof ts === 'number' ? new Date(ts).toISOString() : undefined;
  };

  pi.on('message_start', async (event) => {
    const message = (event as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== 'user') return;
    // Extension-authored messages (pi.sendMessage custom_message) surface as
    // user-role model messages; they are not things the human typed, so they
    // never begin an exchange.
    if ((message as { customType?: string }).customType) return;
    // F6: the pending transition stays in memory; journaling it would mean
    // re-appending the full exchange text on every tool step of the turn.
    log.beginUser(userText(message as { content: unknown }), tsOf(message));
  });

  pi.on('message_end', async (event) => {
    const message = (event as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== 'assistant') return;
    // stopReason 'aborted' (Escape mid-stream) closes the exchange with the
    // R1 markers; 'toolUse' keeps it pending (S10). lib/exchange.mjs owns
    // the semantics; this adapter only reads the message's own fields.
    const m = message as {
      stopReason?: unknown;
      usage?: { input?: unknown; output?: unknown };
      content?: unknown;
    };
    const toolCalls = Array.isArray(m.content)
      ? m.content.filter((b) => (b as { type?: string })?.type === 'toolCall').length
      : 0;
    const exchange = log.setAssistant(assistantText(message), tsOf(message), {
      stopReason: m.stopReason,
      usage: m.usage,
      toolCalls,
      // message_end fires when the reply has finished streaming: this is
      // the moment the answer was complete (S10 doneTs).
      doneTs: new Date().toISOString(),
    });
    // F6: only a resolved transition is journaled; 'toolUse' steps return the
    // still-pending exchange and must not re-append the record.
    if (resolved(exchange)) publish(exchange);

    // R2/R4: summarization happens in agent_settled (end of turn), not here:
    // message_end can fire mid tool-loop and must never stall the loop.
    if (!exchange || exchange.status !== EXCHANGE_STATUS.answered) return;
  });

  // R1: Escape during a run cancels the exchange. agent_settled carries
  // `aborted`; the core records the fixed markers and no summary runs.
  // R2/R4: for settled non-aborted runs, summarize the just-answered
  // exchange and await it so a summary is never cut by a session exit.
  let summarizedIds = new Set();
  pi.on('agent_settled', async (event) => {
    if ((event as { aborted?: boolean }).aborted) {
      // F8: an abort with no exchange of this run must not reopen and mutate a
      // record restored from the journal; it was already recorded there.
      // These two lookups mirror abort()'s own selection in lib/exchange.mjs.
      const target = log.pending()
        ?? lastExchangeCompat(log, (e) => e.status === EXCHANGE_STATUS.answered && e.assistant?.text === '');
      if (target && restoredIds.has(target.id)) return;
      publish(log.abort(tsOf(event)));
      return;
    }
    // F6: a turn that settles without a final reply still leaves its exchange
    // in the journal — one append, never one per tool step.
    const open = lastExchangeCompat(log);
    if (open?.status === EXCHANGE_STATUS.pending) publish(open);
    // F7: targeted lookup — agent_settled needs one record, not a deep clone
    // of the whole conversation on every settled turn.
    const exchange = lastExchangeCompat(log, (e) => e.status === EXCHANGE_STATUS.answered);
    // F8: a restored exchange's turn already settled in a previous run, so
    // summarizing it here would be a model call the user never triggered.
    if (!exchange || restoredIds.has(exchange.id) || summarizedIds.has(exchange.id)) return;
    const { config } = loadRecapConfig(join(homedir(), '.pi', 'agent'));
    if (config.mode === 'off') return;
    if (!config.model && !config.fallbackModels.length) {
      if (!noModelWarned) {
        noModelWarned = true;
        warnOnce('no summary model configured (pi-chat-recap.json "model"); skipping summarization');
      }
      return;
    }
    summarizedIds.add(exchange.id);
    try {
      const summary = await runSummarizer(exchange);
      if (summary) {
        journal.append('summary', {
          exchangeId: exchange.id,
          language: log.language(),
          ...summary,
        });
      }
    } catch (err) {
      warnOnce(`summary flow failed: ${err?.message ?? err}`);
    }
  });

  pi.registerCommand('chat-recap', {
    description: 'Chat recap data: exchange and session-language status',
    handler: async (_args, ctx) => {
      const s = log.summary();
      const lang = s.language ? `language=${s.language}` : 'language=undetected';
      const { config, paths: p } = loadRecapConfig(join(homedir(), '.pi', 'agent'));
      ctx.ui.notify(
        `chat-recap: ${s.count} exchanges (answered ${s.status.answered}, aborted ${s.status.aborted}, pending ${s.status.pending}), ${lang}; mode=${config.mode}, model=${config.model ?? 'none'}, prompt=${p.prompt}`,
        'info',
      );
    },
  });
}
