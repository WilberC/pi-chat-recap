# pi-chat-recap

Producer-only chat recap data for [Pi](https://pi.dev) and
[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell).

The extension records what happened in the conversation — user text, assistant
text, cancelled exchanges, session language, and per-exchange model summaries
(optional; off by default) — and
renders nothing. Renderers (for example the herdr-sidecar recap view) consume
the data and own all presentation.

## Install

From the npm registry:

```bash
pi install npm:pi-chat-recap
```

Or from the parent directory of a local clone:

```bash
pi install ./pi-chat-recap
```

Or for a one-shot test without persisting:

```bash
pi -e ./pi-chat-recap/index.ts
```

## Design boundaries

- **Producer owns semantics**: what an exchange is, when it was cancelled
  (fixed markers, no summary of things that never happened), the session
  language fixed by the first exchange, what gets summarized.
- **Renderer owns presentation**: bubbles, alignment, grouping, timestamps
  display, truncation. It must never re-derive conversation semantics and must
  degrade explicitly when data is absent.
- The summary model summarizes; it never replies to the conversation (R2).
  The hard no-reply rule is producer text appended to every request, so a
  user prompt edit cannot disable it; the editable template controls tone,
  format and length only.

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

Record types:

- `exchange` — full exchange state after every transition (pending /
  answered / aborted). Aborted exchanges carry fixed markers and never get
  summarized. A turn that calls tools stays `pending` through its tool steps
  and answers with the final reply. An answered `assistant` carries:
  - `text` — the turn's final reply, verbatim.
  - `ts` — when the final reply message started.
  - `doneTs` — when the final reply finished. Response time is
    `doneTs − user.ts`.
  - `tokens` — `{input, output}` summed over the turn's assistant messages
    as the provider reported them, or `null` when it reported none.
  - `toolCalls` — how many tool calls the turn made.

  Older lines may lack these fields; consumers show nothing for them rather
  than inventing a value.
- `summary` — `{exchangeId, language, text, truncated, model, tokens}` for
  each successfully summarized answered exchange. `tokens` is the
  provider-reported usage, never an estimate presented as spend.
- `recap_warning` — configuration, prompt-validation or model-failure
  warnings. Every problem is surfaced here (and via UI notify), never silent.

## Model mode configuration

Two editable files under `~/.pi/agent/` control the summary mode. Both are
re-read on every summarization — edits apply on the next exchange without
reinstalling (invalid values are warned, with defaults taking over).

`pi-chat-recap.json`:

```json
{
  "mode": "off",              // "off" (default) or "model" — model mode is an opt-in
  "model": "provider/model",  // summary model; null disables summarization (warns in model mode)
  "fallbackModels": [],       // tried in order when the primary fails
  "maxOutputTokens": 512,     // requested output cap per summary call
  "maxContextChars": 4000,    // material bytes sent to the model
  "maxDisplayChars": 100     // summary length kept in the journal (renderer may still truncate)
}
```

With the default `"mode": "off"` the producer journals exchanges exactly as
before (verbatim text, markers, timestamps) but makes **no model call** and
writes **no `summary` and no `recap_warning` records** — model mode is fully
silent unless you opt in. To enable it, set `"mode": "model"` (invalid or
missing `mode` values fall back to `"off"`, with a warning only when the value
is invalid).

`maxOutputTokens` is what is requested from the provider — actual usage
depends on the provider and is reported per summary in the journal's
`tokens` field. On endpoints where reasoning and the answer share that budget
(reasoning models behind OpenAI-compatible APIs), a summary whose budget is
consumed by thinking comes back empty (`stopReason: "length"`, no text block);
in that case the producer retries the same model once with a larger budget
(4× `maxOutputTokens`), and the journal records the provider-reported usage of
the call that produced the text. `maxContextChars` (model input) and `maxDisplayChars`
(journal text) are distinct limits.

`pi-chat-recap.prompt.md` — the summary prompt template. Placeholders:
`{{user}}`, `{{assistant}}`, `{{language}}`. `{{user}}` is required (a
template without it is rejected with a warning and the built-in default is
used); unknown placeholders stay as literal text with a warning. The session
language (`{{language}}`) is fixed by the first exchange, so summaries stay
in one language even if the conversation alternates (R3). When the file is
absent, this default applies:

```
Summary task: write a brief third-person recap of the material below.
Tone: neutral and factual. Keep it short.
Material to summarize:
- User said: {{user}}
- Assistant said: {{assistant}}
Write the summary in this language: {{language}}.
```

## Status command

`/chat-recap` prints exchange counts, detection language, and the effective
model mode/prompt path.

## Development

```bash
npm test
```

Core logic lives in `lib/` and is tested without a Pi host
(`lib/*.test.mjs`); the host adapter (`index.ts`) is smoke-tested in a live
session.
