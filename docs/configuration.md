# Model mode configuration

[Back to the README](../README.md)

Two editable files under `~/.pi/agent/` control the summary mode. Both are
re-read on every summarization — edits apply on the next exchange without
reinstalling (invalid values are warned, with defaults taking over).

## `pi-chat-recap.json`

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

`maxOutputTokens` is what is requested from the provider — actual usage depends
on the provider and is reported per summary in the journal's `tokens` field. On
endpoints where reasoning and the answer share that budget (reasoning models
behind OpenAI-compatible APIs), a summary whose budget is consumed by thinking
comes back empty (`stopReason: "length"`, no text block); in that case the
producer retries the same model once with a larger budget (4×
`maxOutputTokens`), and the journal records the provider-reported usage of the
call that produced the text. `maxContextChars` (model input) and
`maxDisplayChars` (journal text) are distinct limits.

## `pi-chat-recap.prompt.md`

The summary prompt template. Placeholders: `{{user}}`, `{{assistant}}`,
`{{language}}`. `{{user}}` is required (a template without it is rejected with a
warning and the built-in default is used); unknown placeholders stay as literal
text with a warning. The session language (`{{language}}`) is fixed by the
first exchange, so summaries stay in one language even if the conversation
alternates (R3). When the file is absent, this default applies:

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
