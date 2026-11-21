# The journal (for renderers)

[Back to the README](../README.md)

The extension appends an append-only JSONL journal PER SESSION, next to the
session file: `<session-file>.pi-chat-recap.journal.jsonl` (the session file's
stem + the producer name). Each session owns its journal, so two sessions in the
same directory never share history and a resumed session continues its exchange
ids above the ones already recorded. Each line is self-sufficient so consumers
can rebuild state by tailing:

```json
{"v":1,"producer":"pi-chat-recap","sessionId":"…","ts":"…","type":"exchange","data":{"id":1,"status":"aborted","user":{"text":"…","ts":"…","cancelled":true},"assistant":{"text":null,"ts":"…","marker":"No response (operation aborted)"}}}
```

`status` is `pending`, `answered` or `aborted`. Consumers must tolerate unknown
fields and unknown `type` values, and must degrade explicitly when data is
absent — never reconstruct conversation semantics.

## Record types

- `exchange` — the exchange's resolved state, written once when the exchange
  resolves (answered / aborted) or when the turn settles without a final reply
  (then it lands as `pending`). Aborted exchanges carry fixed markers and never
  get summarized. A turn that calls tools journals only its final form — no
  separate record per tool step. An answered `assistant` carries:
  - `text` — the turn's final reply, verbatim.
  - `ts` — when the final reply message started.
  - `doneTs` — when the final reply finished. Response time is
    `doneTs − user.ts`.
  - `tokens` — `{input, output}` summed over the turn's assistant messages as
    the provider reported them, or `null` when it reported none.
  - `toolCalls` — how many tool calls the turn made.

  Older lines may lack these fields; consumers show nothing for them rather
  than inventing a value.
- `summary` — `{exchangeId, language, text, truncated, model, tokens}` for each
  successfully summarized answered exchange. `tokens` is the provider-reported
  usage, never an estimate presented as spend.
- `recap_warning` — configuration, prompt-validation or model-failure warnings.
  Every problem is surfaced here (and via UI notify), never silent.
