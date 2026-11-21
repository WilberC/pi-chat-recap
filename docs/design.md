# Design boundaries

[Back to the README](../README.md)

- **Producer owns semantics**: what an exchange is, when it was cancelled
  (fixed markers, no summary of things that never happened), the session
  language fixed by the first exchange, what gets summarized.
- **Renderer owns presentation**: bubbles, alignment, grouping, timestamps
  display, truncation. It must never re-derive conversation semantics and must
  degrade explicitly when data is absent.
- **The summary model summarizes; it never replies to the conversation (R2).**
  The hard no-reply rule is producer text appended to every request, so a user
  prompt edit cannot disable it; the editable template controls tone, format
  and length only.

The journal format renderers rely on is in [journal.md](journal.md).
