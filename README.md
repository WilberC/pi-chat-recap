# pi-chat-recap

**A recap of your Pi conversation, recorded as data that other tools can
draw.** A producer-only [Pi](https://pi.dev) and
[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) extension.

## What it does

It records what happened in each exchange — the user text, the final assistant
reply, real timestamps, response time, token usage, tool-call counts and
cancelled exchanges — into an append-only JSONL journal beside the session file.
Optionally, a model writes a one-line summary of each answered exchange, always
in the language the session started in. It renders nothing: renderers such as
the [herdr-sidecar](https://github.com/WilberC/herdr-sidecar) recap view read
the journal and own all presentation.

## What it solves

- **"What did we do in this session?"** A side panel can show a readable recap
  without scraping the chat.
- **Renderers guessing at conversation semantics.** The producer decides what
  an exchange is, when it was cancelled and what language it is in; the
  renderer only draws.
- **Silent failures.** Every configuration, prompt or model problem lands in
  the journal as a warning and in the UI, never swallowed.

Summaries are off by default: out of the box it makes no model call.

## Install

```bash
# Gentle Shell
gentle-shell install npm:pi-chat-recap

# Pi
pi install npm:pi-chat-recap
```

Then `/reload` inside the session, and `/chat-recap` prints exchange counts,
the detected language and the effective summary mode. Local clones and one-shot
tests: [docs/development.md](https://github.com/WilberC/pi-chat-recap/blob/main/docs/development.md).

## Documentation

| I want to… | Read |
| --- | --- |
| Turn on model summaries, or change their prompt | [docs/configuration.md](https://github.com/WilberC/pi-chat-recap/blob/main/docs/configuration.md) |
| Read the journal from a renderer | [docs/journal.md](https://github.com/WilberC/pi-chat-recap/blob/main/docs/journal.md) |
| Know who owns what between producer and renderer | [docs/design.md](https://github.com/WilberC/pi-chat-recap/blob/main/docs/design.md) |
| Run the tests or install from a clone | [docs/development.md](https://github.com/WilberC/pi-chat-recap/blob/main/docs/development.md) |

## License

MIT — see [LICENSE](https://github.com/WilberC/pi-chat-recap/blob/main/LICENSE).
