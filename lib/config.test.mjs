// Config loading rules (S4/R4): editable JSON, surfaced warnings, sane
// defaults when the file is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRecapConfig, recapPaths, validateConfig, defaultConfig } from './config.mjs';

function tempAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-chat-recap-cfg-'));
}

test('missing config file yields defaults with no warnings', () => {
  const dir = tempAgentDir();
  const { config, warnings, paths } = loadRecapConfig(dir);
  assert.deepEqual(config, defaultConfig());
  assert.deepEqual(warnings, []);
  assert.equal(paths.config, join(dir, 'pi-chat-recap.json'));
  assert.equal(paths.prompt, join(dir, 'pi-chat-recap.prompt.md'));
  rmSync(dir, { recursive: true, force: true });
});

test('valid config keys are honored; mode accepts only known values', () => {
  const { config, warnings } = validateConfig({
    mode: 'model',
    model: 'a/b',
    fallbackModels: ['c/d'],
    maxOutputTokens: 128,
    maxContextChars: 800,
    maxDisplayChars: 40,
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.model, 'a/b');
  assert.equal(config.maxOutputTokens, 128);
  assert.equal(config.maxDisplayChars, 40);

  const bad = validateConfig({ mode: 'turbo' });
  assert.equal(bad.config.mode, 'off');
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /not one of/);
});

test('unknown keys and invalid values warn instead of failing silently', () => {
  const { config, warnings } = validateConfig({ maxTokens: 10, maxOutputTokens: 0, model: 42 });
  assert.ok(warnings.some((w) => w.includes('unknown key "maxTokens"')));
  assert.ok(warnings.some((w) => w.includes('maxOutputTokens')));
  assert.ok(warnings.some((w) => w.includes('model must be a string')));
  assert.equal(config.maxOutputTokens, defaultConfig().maxOutputTokens);
  assert.equal(config.model, null);
});

test('unparseable JSON warns and falls back to defaults', () => {
  const dir = tempAgentDir();
  writeFileSync(join(dir, 'pi-chat-recap.json'), '{ not json');
  const { config, warnings } = loadRecapConfig(dir);
  assert.deepEqual(config, defaultConfig());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be parsed/);
  rmSync(dir, { recursive: true, force: true });
});
