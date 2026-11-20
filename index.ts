import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createExchangeLog,
  userText,
  assistantText,
  EXCHANGE_STATUS,
} from './lib/exchange.mjs';
import { createJournal } from './lib/journal.mjs';
import { createSummarizer, loadPromptFile } from './lib/summary.mjs';
import { loadRecapConfig, recapPaths } from './lib/config.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// pi-chat-recap: producer-only conversation data. It records what happened
// (user text, assistant text, cancellations, session language) and renders
// nothing. Renderers such as herdr-sidecar consume the data; they never
// re-derive exchange semantics.
export default function chatRecap(pi: ExtensionAPI) {
  const log = createExchangeLog();
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
        return { text, tokens: result?.usage ?? null };
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

  // Append the full exchange record after every transition so consumers can
  // rebuild state by tailing; each line is self-sufficient.
  const publish = (exchange) => {
    if (exchange) journal.append('exchange', exchange);
  };

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    uiRef = ctx;
    journal.openSession(
      ctx.sessionManager?.getSessionFile?.(),
      ctx.sessionManager?.getSessionId?.(),
    );
    // Surface config/prompt problems once at startup, not per exchange.
    const { warnings } = loadRecapConfig(join(homedir(), '.pi', 'agent'));
    for (const w of warnings) warnOnce(w);
    configWarned = warnings.length > 0;
    const { warnings: promptWarnings } = loadPromptFile(paths.prompt);
    for (const w of promptWarnings) warnOnce(w);
    // Replay existing exchanges so a renderer joining late has full state.
    for (const exchange of log.exchanges()) publish(exchange);
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
    publish(log.beginUser(userText(message as { content: unknown }), tsOf(message)));
  });

  pi.on('message_end', async (event) => {
    const message = (event as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== 'assistant') return;
    // stopReason 'aborted' (Escape mid-stream) closes the exchange with the
    // R1 markers; lib/exchange.mjs owns the semantics.
    const exchange = log.setAssistant(assistantText(message), tsOf(message), {
      stopReason: (message as { stopReason?: unknown }).stopReason,
    });
    publish(exchange);

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
      publish(log.abort(tsOf(event)));
      return;
    }
    const exchange = log
      .exchanges()
      .filter((e) => e.status === EXCHANGE_STATUS.answered)
      .at(-1);
    if (!exchange || summarizedIds.has(exchange.id)) return;
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
