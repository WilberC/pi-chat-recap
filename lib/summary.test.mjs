// Model-mode summary (R2, R3, R4, S4). Pure logic tested offline: the model
// call is injected, so no provider is touched here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HARD_NO_REPLY_RULE,
  createSummarizer,
  buildSummaryMessages,
  loadPromptFile,
  DEFAULT_SUMMARY_PROMPT,
} from './summary.mjs';
import { createExchangeLog, EXCHANGE_STATUS, ABORTED_PI_MARKER } from './exchange.mjs';

const BASE_CONFIG = {
  model: 'primary/model',
  fallbackModels: ['fallback/model'],
  maxOutputTokens: 256,
  maxContextChars: 4000,
  maxDisplayChars: 200,
};

function fakeCall(responses) {
  const calls = [];
  let i = 0;
  const fn = async (req) => {
    calls.push(req);
    const r = responses[i++];
    if (!r) throw new Error('no scripted response left');
    if (r.error) throw r.error;
    return r.result ?? r;
  };
  return [fn, calls];
}

test('S1/R2: a proposal is summarized as data with the hard no-reply rule, never as a dialogue turn', async () => {
  const [call, calls] = fakeCall([{ result: { text: 'El usuario propuso hacer X.' } }]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'es',
  });
  const out = await s.summarizeExchange({
    id: 1,
    status: EXCHANGE_STATUS.answered,
    user: { text: '¿Y si hacemos X? Sería ideal.' },
    assistant: { text: 'Exploración: X tendría costo Y.' },
  });
  assert.equal(calls.length, 1);
  const context = calls[0].context;
  // The user's proposal is material inside the request, not an open question
  // waiting for an answer.
  assert.match(JSON.stringify(context.messages), /¿Y si hacemos X\?/);
  // The exact reported failure mode is structurally forbidden, not hoped away.
  assert.match(context.systemPrompt, HARD_NO_REPLY_RULE_REGEXP());
  assert.match(out.text, /propuso/);
  assert.equal(out.truncated, false);
});

function HARD_NO_REPLY_RULE_REGEXP() {
  const esc = HARD_NO_REPLY_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc);
}

test('R1: aborted and pending exchanges are never summarized (zero calls)', async () => {
  const [call, calls] = fakeCall([]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'es',
  });
  assert.equal(await s.summarizeExchange({ id: 1, status: EXCHANGE_STATUS.aborted, user: { text: 'para' }, assistant: { text: null, marker: ABORTED_PI_MARKER } }), null);
  assert.equal(await s.summarizeExchange({ id: 2, status: EXCHANGE_STATUS.pending, user: { text: 'hola' }, assistant: null }), null);
  assert.equal(calls.length, 0);
});

test('S4: display truncation is a presentation-limit flag, input text is not cut before the model', async () => {
  const [call, calls] = fakeCall([{ result: { text: 'r'.repeat(300) } }]);
  const s = createSummarizer({
    callModel: call,
    config: { ...BASE_CONFIG, maxDisplayChars: 100 },
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'en',
  });
  const out = await s.summarizeExchange({
    id: 1,
    status: EXCHANGE_STATUS.answered,
    user: { text: 'u' },
    assistant: { text: 'a'.repeat(9000) },
  });
  // maxDisplayChars cuts what goes to the journal, not the model's input.
  assert.equal(out.text.length, 100);
  assert.equal(out.truncated, true);
  // The full assistant material reached the model up to the context limit:
  // display truncation must not determine what the model sees.
  assert.ok(calls[0].context.messages[0].content.includes('a'.repeat(3950)));
});

test('S4: maxContextChars truncates the material sent to the model', async () => {
  const [call, calls] = fakeCall([{ result: { text: 'ok' } }]);
  const s = createSummarizer({
    callModel: call,
    config: { ...BASE_CONFIG, maxContextChars: 50 },
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'en',
  });
  await s.summarizeExchange({
    id: 1,
    status: EXCHANGE_STATUS.answered,
    user: { text: 'w'.repeat(80) },
    assistant: { text: 'a'.repeat(80) },
  });
  const content = calls[0].context.messages[0].content;
  const material = content.slice(content.indexOf(']\n') + 2);
  assert.ok(material.length <= 50, 'material must be cut to the context limit');
  assert.ok(!material.includes('w'.repeat(80)));
});

test('S4/R3: maxOutputTokens and fixed session language reach the model request', async () => {
  const [call, calls] = fakeCall([{ result: { text: 'Resumen.' } }]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'es',
  });
  await s.summarizeExchange({
    id: 1,
    status: EXCHANGE_STATUS.answered,
    user: { text: 'hola' },
    assistant: { text: 'chau' },
  });
  assert.equal(calls[0].maxOutputTokens, 256);
  assert.match(calls[0].context.systemPrompt, /\bes\b/);
});

// helpers for prompt-file tests
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'pi-chat-recap-test-'));
}

test('R4: a custom prompt file with valid placeholders is used verbatim', async () => {
  const dir = makeTempDir();
  const file = join(dir, 'prompt.md');
  writeFileSync(file, 'Tone: playful. Summarize: {{user}} / {{assistant}}. Answer in {{language}}.');
  const loaded = loadPromptFile(file, { read: (p) => readFileSync(p, 'utf8') });
  assert.deepEqual(loaded.warnings, []);
  const [call, calls] = fakeCall([{ result: { text: 'ok' } }]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => loaded,
    warn: () => {},
    language: 'en',
  });
  await s.summarizeExchange({
    id: 1, status: EXCHANGE_STATUS.answered,
    user: { text: 'USER_MATERIAL' }, assistant: { text: 'ASSIST_MATERIAL' },
  });
  const sys = calls[0].context.systemPrompt;
  assert.match(sys, /Tone: playful/);
  assert.ok(sys.includes('USER_MATERIAL') && sys.includes('ASSIST_MATERIAL') && sys.includes('en'));
  rmSync(dir, { recursive: true, force: true });
});

test('R4: a template missing {{user}} is rejected with a visible warning, default takes over', async () => {
  const dir = makeTempDir();
  const file = join(dir, 'prompt.md');
  writeFileSync(file, 'You are a friendly poet. No placeholders here.');
  const loaded = loadPromptFile(file, { read: (p) => readFileSync(p, 'utf8') });
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /\{\{user\}\}/);
  const warnings = [];
  const [call, calls] = fakeCall([{ result: { text: 'ok' } }]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => loaded,
    warn: (msg) => warnings.push(msg),
    language: 'en',
  });
  await s.summarizeExchange({
    id: 1, status: EXCHANGE_STATUS.answered,
    user: { text: 'u' }, assistant: { text: 'a' },
  });
  assert.equal(warnings.length, 1, 'the bad edit must be warned, not silent');
  assert.match(calls[0].context.systemPrompt, /Summary task/);
  assert.ok(!calls[0].context.systemPrompt.includes('friendly poet'), 'invalid template must not be used');
  rmSync(dir, { recursive: true, force: true });
});

test('S4: primary model fails once, the fallback model answers with the same request', async () => {
  const [call, calls] = fakeCall([
    { error: new Error('provider down') },
    { result: { text: 'fallback worked' } },
  ]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: () => {},
    language: 'en',
  });
  const out = await s.summarizeExchange({
    id: 1, status: EXCHANGE_STATUS.answered,
    user: { text: 'u' }, assistant: { text: 'a' },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'primary/model');
  assert.equal(calls[1].model, 'fallback/model');
  assert.equal(out.model, 'fallback/model');
  assert.equal(out.text, 'fallback worked');
});

test('S4: every model fails, a warning is recorded and nothing crashes', async () => {
  const [call, calls] = fakeCall([
    { error: new Error('down') },
    { error: new Error('down too') },
  ]);
  const failures = [];
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => ({ template: DEFAULT_SUMMARY_PROMPT, warnings: [] }),
    warn: (msg) => failures.push(msg),
    language: 'en',
  });
  const out = await s.summarizeExchange({
    id: 1, status: EXCHANGE_STATUS.answered,
    user: { text: 'u' }, assistant: { text: 'a' },
  });
  assert.equal(calls.length, 2);
  assert.equal(out, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /failed/i);
});

test('R4 (prompt freshness): loadPrompt runs per summarization, so edits are picked up', async () => {
  let template = 'v1 {{user}} {{assistant}}';
  const loads = [];
  const [call] = fakeCall([
    { result: { text: 's1' } },
    { result: { text: 's2' } },
  ]);
  const s = createSummarizer({
    callModel: call,
    config: BASE_CONFIG,
    loadPrompt: () => {
      loads.push(template);
      return { template, warnings: [] };
    },
    warn: () => {},
    language: 'en',
  });
  const ex = { id: 1, status: EXCHANGE_STATUS.answered, user: { text: 'u' }, assistant: { text: 'a' } };
  await s.summarizeExchange(ex);
  template = 'v2 {{user}} {{assistant}}';
  await s.summarizeExchange(ex);
  assert.deepEqual(loads, ['v1 {{user}} {{assistant}}', 'v2 {{user}} {{assistant}}']);
});

test('R2 (buildSummaryMessages is pure): user material is data, the no-reply rule is fixed text', () => {
  const { systemPrompt, messages } = buildSummaryMessages({
    template: 'Summarize in {{language}}: {{user}} / {{assistant}}',
    userText: '¿y si hacemos X?',
    assistantText: 'propuesta explorada',
    language: 'es',
    maxContextChars: 1000,
  });
  assert.ok(systemPrompt.includes('¿y si hacemos X?'));
  assert.match(systemPrompt, HARD_NO_REPLY_RULE_REGEXP());
  assert.ok(systemPrompt.includes('es'));
  assert.equal(messages.length, 1);
});
