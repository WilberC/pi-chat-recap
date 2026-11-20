# Recap model mode (R2/R4)

Producer extension `pi-chat-recap` gains the model-driven summary mode: the
recap model summarizes what was said (never replies), with editable prompts and
configurable limits. Scope of this round: producer + model mode. The sidecar
renderer (R5/R6) is explicitly out of scope until later.

## Specs

Content modes from the captured note (`My Brain/100_Projects/AI/Recap configurable para Gentle Shell.md`).

- **S1** (R2, user verbatim 2026-11-20): "cuando se mande el mensaje el modelo del recap no intente responder lo que mande, sino que resuma lo que se le dicho"
  - The recap prompt defines a summarization task with restricted output: it must explicitly forbid continuing the conversation, opining, or answering the proposal (e.g. a "¿y si hacemos X?" message must never produce "Sí, perfectamente…").
  - The user's message enters as material to summarize, not as a dialogue turn.
  - Acceptance: a test with a proposal produces a third-person summary of what was said, never a conversational reply.
- **S2** (R4, user verbatim 2026-11-20): "puedes modificar el o los prompts de recap para que lo personalizes como quieras que te responda"
  - The summary prompt(s) live in user-editable files, not embedded in code; reloading without restarting the session is desirable but not mandatory.
  - Customization covers tone, format and length.
  - A user edit that breaks R2 (responds instead of summarizes) must be detected and warned, not fail silently.
  - Acceptance: editing the prompt changes next-turn summary output without reinstalling the package.
- **S3** (R3, user verbatim 2026-11-20): "El chat debe seguir el idioma inicial del chat en toda la session"
  - Summary language is fixed by the language of the first exchange of the session and never changes even if the conversation alternates Spanish/English.
  - Fixed labels (`you`, `pi`, system markers) come from configuration, not the turn language.
- **S4** (note, "Resumen mediante modelo", plan-level): configurable model and fallback policy; max output tokens per summary request; max context characters and max displayed characters (distinct limits); when to summarize the user message, the assistant reply, and the session objective. Requested limits must not be presented as actual spend. Grouped summaries may be evaluated but cost/quality gains must be measured, not assumed.
- **S5** (R1, user verbatim 2026-11-20, already implemented in producer — live verification pending in this round): "si doy escape cancelando el mensaje se deberia de poner en el you lo que mande y entre parentesis se cancelo la operacion y en pi algo como No response Operation aborted y listo en vez de hacer resumen y poner de cosas que no van" — zero model calls for the aborted exchange, including summary and session objective.

## Tasks

- **T1** (S5, smoke): DONE — local load via `pi install ./pi-chat-recap` or one-shot `pi -e ./index.ts`; recorded in Log L4.
- **T2** (S5, smoke): DONE — answered + aborted verified in live journal; R1 mid-stream abort defect found, fixed (Log L3).
- **T3** (S1/S3, design+test): DONE — RED first (`lib/summary.test.mjs`) before `lib/summary.mjs` existed; R2 no-reply rule asserted as fixed producer text, R3 language pinning asserted on the request.
- **T4** (S1/S2/S3, implement): DONE — `lib/summary.mjs` (hard no-reply rule appended to every request, template validation with warnings, per-call prompt re-read) + `index.ts` wiring at agent_settled (never mid tool-loop, awaited so exit cannot cut it).
- **T5** (S4, implement): DONE — `lib/config.mjs`: mode, model, fallbackModels, maxOutputTokens (default 512 after live finding: a reasoning model spent 107 tokens and a 128 cap left empty output), maxContextChars vs maxDisplayChars, mode off.
- **T6** (S2, tests): DONE — 14 offline tests (summary + config): freshness, invalid-template warning + default takeover, fallback chain, all-fail warning, limits; 33/33 green.
- **T7** (S1–S5, docs): DONE — README documents model mode, files, config reference, journal record types. Live verification: R2 (proposal → 'El usuario propuso…', never 'Sí, perfectamente'), R3 (es), R4 (pirate prompt edit picked up: '¡Arrr! Un tripulante…'), R1 (aborted essay got no summary and no model call), S4 (truncated at maxDisplayChars=120, provider tokens in journal).

## Log

- **L1** (2026-11-20): "Recap en el shell para Pi: recapiticar la conversacion como lo hace Github Copilot... por ejemplo para temas que converso, /mnt/c/Users/wilbe/iCloudDrive/iCloud~md~obsidian/My Brain/100_Projects/AI/Recap configurable para Gentle Shell.md este es el requerimiento de lo que estaba viendo, algo que necesite ser acalarado antes de comenzar?"
- **L2** (2026-11-20): Scope answer: "primero el productor, todo lo que tenga que ver con sidecard lo veremos luego". Model mode answer: "Sí, en paralelo".
- **L3** (2026-11-20): Live smoke verified: answered path (pending→answered, verbatim text, real timestamps) and aborted path via tmux Escape. **Defect found and fixed**: Escape mid-stream delivers message_end with empty assistant text and `stopReason: "aborted"`; producer recorded `answered` with empty text. Fix: `setAssistant(text, ts, {stopReason})` records aborted markers directly; `abort()` also recovers an answered-empty exchange (host variants without stopReason). Evidence: journal line `{"status":"aborted",...,"marker":"No response (operation aborted)"}` after fix; 18/18 tests green.
- **L4** (2026-11-20): T1 resolved: local load = `pi install ./pi-chat-recap` (loads from resolved path without copying; deps are author's responsibility, host pkgs in peerDependencies) or one-shot `pi -e ./index.ts` (used for live smoke). Manifest `"pi":{"extensions":["./index.ts"]}` matches documented form. Global settings untouched; install command documented in README at close.

- **L5** (2026-11-20): Live findings from smoke: (a) summation belongs in agent_settled, not message_end (message_end can fire mid tool-loop; -p sessions exit before floating promises resolve); (b) `modelRegistry.complete` returns block-array content, needs text-block extraction; (c) default maxOutputTokens must leave headroom for reasoning models (parked at 512); (d) user config file wins over defaults (expected). Left clean for the user: `~/.pi/agent/pi-chat-recap.json` with `nan/glm5.3-flash` kept; pirate test prompt removed (default template applies).
- **L6** (2026-11-21): Status for a new session — the model mode (R2/R4) is done, and the S10 journal fields from the herdr-sidecar recap-deck round followed (tool turns stay pending until the final reply; `assistant.doneTs`, `tokens {input, output}`, `toolCalls`). Merged into local `main` at 767c904 (38/38 tests); this repo has no remote. Installed globally from this path. The renderer side and its open follow-ups are tracked in `~/Projects/Personal/herdr-sidecar/odd/tasks/recap-deck.md` → `## Status`.
