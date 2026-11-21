# Development

[Back to the README](../README.md)

## Install from a clone

From the parent directory of a local clone:

```bash
pi install ./pi-chat-recap
```

Or for a one-shot test without persisting:

```bash
pi -e ./pi-chat-recap/index.ts
```

## Tests

```bash
npm test
```

Core logic lives in `lib/` and is tested without a Pi host (`lib/*.test.mjs`);
the host adapter (`index.ts`) is smoke-tested in a live session.
