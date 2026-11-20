import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createExchangeLog,
  userText,
  assistantText,
} from './lib/exchange.mjs';
import { createJournal } from './lib/journal.mjs';

// pi-chat-recap: producer-only conversation data. It records what happened
// (user text, assistant text, cancellations, session language) and renders
// nothing. Renderers such as herdr-sidecar consume the data; they never
// re-derive exchange semantics.
export default function chatRecap(pi: ExtensionAPI) {
  const log = createExchangeLog();
  const journal = createJournal({ sessionId: '', producer: 'pi-chat-recap' });

  // Append the full exchange record after every transition so consumers can
  // rebuild state by tailing; each line is self-sufficient.
  const publish = (exchange) => {
    if (exchange) journal.append('exchange', exchange);
  };

  pi.on('session_start', async (_event, ctx) => {
    journal.openSession(ctx.sessionManager?.getSessionFile?.());
    // Replay existing exchanges so a renderer joining late has full state.
    for (const exchange of log.exchanges()) publish(exchange);
  });
  pi.on('session_shutdown', () => journal.close());

  const tsOf = (event: unknown) =>
    (event as { timestamp?: string } | undefined)?.timestamp ?? undefined;

  pi.on('message_start', async (event) => {
    const message = (event as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== 'user') return;
    publish(log.beginUser(userText(message as { content: unknown }), tsOf(event)));
  });

  pi.on('message_end', async (event) => {
    const message = (event as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== 'assistant') return;
    publish(log.setAssistant(assistantText(message), tsOf(event)));
  });

  // R1: Escape during a run cancels the exchange. agent_settled carries
  // `aborted`; the core records the fixed markers and no summary runs.
  pi.on('agent_settled', async (event) => {
    if ((event as { aborted?: boolean }).aborted) {
      publish(log.abort(tsOf(event)));
    }
  });

  pi.registerCommand('chat-recap', {
    description: 'Chat recap data: exchange and session-language status',
    handler: async (_args, ctx) => {
      const s = log.summary();
      const lang = s.language ? `language=${s.language}` : 'language=undetected';
      ctx.ui.notify(
        `chat-recap: ${s.count} exchanges (answered ${s.status.answered}, aborted ${s.status.aborted}, pending ${s.status.pending}), ${lang}`,
        'info',
      );
    },
  });
}
