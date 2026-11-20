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
    journal.openSession(
      ctx.sessionManager?.getSessionFile?.(),
      ctx.sessionManager?.getSessionId?.(),
    );
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
    publish(
      log.setAssistant(assistantText(message), tsOf(message), {
        stopReason: (message as { stopReason?: unknown }).stopReason,
      }),
    );
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
