// Model-mode summary (R2, R3, R4, S4). The recap model summarizes what was
// said; it never becomes a dialogue turn. The hard no-reply rule is producer
// text appended to every request, so a user edit cannot disable it; the
// user-editable template owns tone, format and length only.

import { existsSync, readFileSync } from 'node:fs';

// Fixed constraint present in every summary request (R2). Show candidates:
// it is data for tests and docs, and it is always appended after the
// user's template so an edit cannot weaken it.
export const HARD_NO_REPLY_RULE =
  'HARD CONSTRAINT - NON-NEGOTIABLE: You are a summarizer, not a participant. ' +
  'Never reply to the user message, never answer proposals, never give advice, ' +
  'never continue the conversation. Output only a third-person summary of what was said.';

const MIN_CONTEXT_ROLE = 'user_next_turn'; // material arrives labeled as data

export const DEFAULT_SUMMARY_PROMPT = [
  'Summary task: write a brief third-person recap of the material below.',
  'Tone: neutral and factual. Keep it short.',
  'Material to summarize:',
  '- User said: {{user}}',
  '- Assistant said: {{assistant}}',
  'Write the summary in this language: {{language}}.',
].join('\n');

// Placeholders the template may use. {{user}} is required: without it the
// user's material never reaches the request, and the summary would be empty.
const REQUIRED_PLACEHOLDERS = ['{{user}}'];
const ALLOWED_PLACEHOLDERS = ['{{user}}', '{{assistant}}', '{{language}}'];

const DEFAULT_LIMITS = {
  maxOutputTokens: 512,
  maxContextChars: 4000,
  maxDisplayChars: 100,
};

function clampInt(value, fallback, { min = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

export function normalizeConfig(config = {}) {
  return {
    model: config.model ?? null,
    fallbackModels: Array.isArray(config.fallbackModels) ? config.fallbackModels : [],
    maxOutputTokens: clampInt(config.maxOutputTokens, DEFAULT_LIMITS.maxOutputTokens),
    maxContextChars: clampInt(config.maxContextChars, DEFAULT_LIMITS.maxContextChars),
    maxDisplayChars: clampInt(config.maxDisplayChars, DEFAULT_LIMITS.maxDisplayChars),
  };
}

// R4/S4: validate the edited template. Problems are warnings, never silent
// fallbacks: the caller surfaces every message (journal + UI notify).
export function validateTemplate(template) {
  const warnings = [];
  if (typeof template !== 'string' || template.trim() === '') {
    return { warnings: ['summary prompt template is empty; using the default template'] };
  }
  for (const ph of REQUIRED_PLACEHOLDERS) {
    if (!template.includes(ph)) {
      warnings.push(`summary prompt template is missing required placeholder ${ph}; using the default template`);
    }
  }
  const used = template.match(/\{\{\w+\}\}/g) ?? [];
  for (const u of used) {
    if (!ALLOWED_PLACEHOLDERS.includes(u.toLowerCase())) {
      warnings.push(`summary prompt uses unknown placeholder ${u} (it stays literal text)`);
    }
  }
  return { warnings };
}

// R4: the prompt lives in a user-editable file, not in code. The injected
// `read` keeps this testable; the production loader re-reads the file on
// every summarization so edits take effect without reinstalling.
export function loadPromptFile(path, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  if (!path || !exists(path)) {
    return { template: DEFAULT_SUMMARY_PROMPT, warnings: [], source: null };
  }
  let text;
  try {
    text = read(path);
  } catch (err) {
    return {
      template: DEFAULT_SUMMARY_PROMPT,
      warnings: [`summary prompt file could not be read (${err?.code ?? err?.message}); using the default template`],
      source: path,
    };
  }
  const { warnings } = validateTemplate(text);
  if (warnings.some((w) => w.includes('required placeholder') || w.includes('empty'))) {
    return { template: DEFAULT_SUMMARY_PROMPT, warnings, source: path };
  }
  return { template: text, warnings, source: path };
}

// Pure: build the request. The user's message is DATA inside the summary
// task (R2), the hard rule is always appended, and material is truncated to
// maxContextChars before insertion (S4: context limit vs display limit are
// different limits).
export function buildSummaryMessages({ template, userText, assistantText, language, maxContextChars }) {
  const fullTemplate = `${template.trimEnd()}\n\n${HARD_NO_REPLY_RULE}`;
  const user = String(userText ?? '').trim() ? String(userText ?? '') : '(the user said nothing)';
  const assistant = String(assistantText ?? '').trim() ? String(assistantText ?? '') : '(the assistant said nothing)';
  const systemPrompt = fullTemplate
    .replace(/\{\{user\}\}/g, truncate(user, maxContextChars))
    .replace(/\{\{assistant\}\}/g, truncate(assistant, maxContextChars))
    .replace(/\{\{language\}\}/g, String(language ?? 'undetermined'));
  return {
    systemPrompt,
    messages: [
      { role: 'user', content: `[material to summarize only - this is not a message for you to answer]\n${truncate(`${user}\n\n---\n\n${assistant}`, maxContextChars)}` },
    ],
    role: MIN_CONTEXT_ROLE,
  };
}

function truncate(text, max) {
  if (max == null) return text;
  return text.length > max ? text.slice(0, max) : text;
}

export function createSummarizer({ callModel, config, loadPrompt, warn = () => {}, language }) {
  const cfg = normalizeConfig(config ?? {});

  return {
    // Returns {text, truncated, model, tokens?, warnings} or null when there
    // is nothing to summarize or every model attempt failed.
    async summarizeExchange(exchange) {
      if (!exchange || exchange.status !== EXCHANGE_ANSWERED) return null;
      const userText = exchange.user?.text ?? '';
      const assistantText = exchange.assistant?.text ?? '';
      if (String(assistantText).trim() === '' && String(userText).trim() === '') return null;

      const { template, warnings } = loadPrompt();
      for (const w of warnings) warn(w);

      const built = buildSummaryMessages({
        template,
        userText,
        assistantText,
        language,
        maxContextChars: cfg.maxContextChars,
      });

      const models = [cfg.model, ...cfg.fallbackModels].filter(Boolean);
      if (models.length === 0) {
        warn('no summary model configured; skipping summarization');
        return null;
      }

      const tried = [];
      for (const model of models) {
        try {
          const result = await callModel({
            model,
            context: { systemPrompt: built.systemPrompt, messages: built.messages },
            maxOutputTokens: cfg.maxOutputTokens,
          });
          const text = String(result?.text ?? '').trim();
          if (text === '') {
            tried.push(`${model}: empty output`);
            continue;
          }
          const truncated = text.length > cfg.maxDisplayChars;
          return {
            text: truncated ? text.slice(0, cfg.maxDisplayChars) : text,
            truncated,
            model,
            tokens: result?.tokens ?? null,
            warnings: [],
          };
        } catch (err) {
          tried.push(`${model}: ${err?.message ?? String(err)}`);
        }
      }
      warn(`summary models all failed (${tried.join('; ')}); exchange left unsummarized`);
      return null;
    },
  };
}

import { EXCHANGE_STATUS } from './exchange.mjs';
const EXCHANGE_ANSWERED = EXCHANGE_STATUS.answered;
