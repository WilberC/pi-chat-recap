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

## Journal (for renderers)

The extension appends an append-only JSONL journal next to the Pi session
file: `pi-chat-recap.journal.jsonl`. Each line is self-sufficient so
consumers can rebuild state by tailing:

```json
{"v":1,"producer":"pi-chat-recap","sessionId":"…","ts":"…","type":"exchange","data":{"id":1,"status":"aborted","user":{"text":"…","ts":"…","cancelled":true},"assistant":{"text":null,"ts":"…","marker":"No response (operation aborted)"}}}
```

`status` is `pending`, `answered` or `aborted`. Consumers must tolerate
unknown fields and unknown `type` values, and must degrade explicitly when
data is absent — never reconstruct conversation semantics.

## Development

```bash
npm test
```

Core logic lives in `lib/exchange.mjs` and is tested without a Pi host
(`lib/exchange.test.mjs`).
