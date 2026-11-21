// Recap config (S4): a user-editable JSON file, mirrored by the prompt file
// path (R4). Unknown keys and bad values are warnings, never silent.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RECAP_MODES = ['model', 'off'];

export function recapPaths(piAgentDir = join(homedir(), '.pi', 'agent')) {
  return {
    config: join(piAgentDir, 'pi-chat-recap.json'),
    prompt: join(piAgentDir, 'pi-chat-recap.prompt.md'),
  };
}

export function defaultConfig() {
  return {
    // S6: model mode is an opt-in (L7). The default journals exchanges only:
    // no model call, no summary, no recap_warning. Invalid modes also fall
    // back to "off" (with a warning, below).
    mode: 'off',
    model: null,
    fallbackModels: [],
    maxOutputTokens: 512,
    maxContextChars: 4000,
    maxDisplayChars: 100,
  };
}

const NUMERIC_KEYS = ['maxOutputTokens', 'maxContextChars', 'maxDisplayChars'];

// Validate one edited config object; every problem is a surfaced warning.
export function validateConfig(raw) {
  const warnings = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: defaultConfig(), warnings: ['recap config must be a JSON object; using defaults'] };
  }
  const config = defaultConfig();
  for (const key of Object.keys(raw)) {
    if (key === 'mode') {
      if (!RECAP_MODES.includes(raw.mode)) {
        warnings.push(`recap config mode "${raw.mode}" is not one of ${RECAP_MODES.join(', ')}; using "off"`);
        config.mode = 'off';
      } else {
        config.mode = raw.mode;
      }
    } else if (key === 'model') {
      if (raw.model !== null && typeof raw.model !== 'string') {
        warnings.push('recap config model must be a string like "provider/model-id" or null; ignoring it');
      } else {
        config.model = raw.model;
      }
    } else if (key === 'fallbackModels') {
      if (!Array.isArray(raw.fallbackModels) || raw.fallbackModels.some((m) => typeof m !== 'string')) {
        warnings.push('recap config fallbackModels must be an array of strings; ignoring it');
      } else {
        config.fallbackModels = raw.fallbackModels;
      }
    } else if (NUMERIC_KEYS.includes(key)) {
      const n = Number(raw[key]);
      if (!Number.isFinite(n) || n < 1) {
        warnings.push(`recap config ${key} must be a number >= 1; keeping the default`);
      } else {
        config[key] = Math.floor(n);
      }
    } else {
      warnings.push(`recap config has unknown key "${key}" (ignored)`);
    }
  }
  return { config, warnings };
}

export function loadRecapConfig(piAgentDir, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const paths = recapPaths(piAgentDir);
  if (!exists(paths.config)) {
    return { config: defaultConfig(), warnings: [], paths };
  }
  let raw;
  try {
    raw = JSON.parse(read(paths.config));
  } catch (err) {
    return {
      config: defaultConfig(),
      warnings: [`recap config file could not be parsed (${err?.message ?? err}); using defaults`],
      paths,
    };
  }
  const { config, warnings } = validateConfig(raw);
  return { config, warnings, paths };
}
