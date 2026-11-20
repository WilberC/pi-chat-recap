# pi-chat-recap

Producer-only chat recap data for [Pi](https://pi.dev) and
[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell).

The extension records what happened in the conversation — user text, assistant
text, cancelled exchanges, session language — with real timestamps, and renders
nothing. Renderers (for example the herdr-sidecar recap view) consume the data
and own all presentation.

## Install

```bash
pi install npm:pi-chat-recap
```

## Design boundaries

- **Producer owns semantics**: what an exchange is, when it was cancelled
  (fixed markers, no summary of things that never happened), the session
  language fixed by the first exchange.
- **Renderer owns presentation**: bubbles, alignment, grouping, timestamps
  display, truncation. It must never re-derive conversation semantics and must
  degrade explicitly when data is absent.
- No model calls in the basic version: the recorded text is verbatim, never
  summarized.

## Development

```bash
npm test
```

Core logic lives in `lib/exchange.mjs` and is tested without a Pi host
(`lib/exchange.test.mjs`).
