import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMultiplier, mapModelCatalog, modelGroup, resolveReasoningEffort, describeModel } from './models-service.js';

const RAW = [
  { id: 'auto', displayName: 'Auto Model', shortDisplayName: 'Auto Model', modelProvider: 'factory', kind: 'router', supportedReasoningEfforts: ['none'], defaultReasoningEffort: 'none', isCustom: false, noImageSupport: false, tokenMultiplier: 1, disabled: false },
  { id: 'claude-opus-5-5', displayName: 'Opus 5.5', shortDisplayName: 'Opus 5.5', modelProvider: 'anthropic', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium', isCustom: false, noImageSupport: false, tokenMultiplier: 1.6, disabled: false },
  { id: 'claude-haiku-5-5', displayName: 'Haiku 5.5', modelProvider: 'anthropic', supportedReasoningEfforts: ['off', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium', tokenMultiplier: 0.04, disabled: false },
  { id: 'gpt-6.1-sol-ultrafast', displayName: 'GPT-6.1 Sol Ultra Fast', modelProvider: 'openai', supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium', tokenMultiplier: 4.8, disabled: true, disabledReason: 'Requires explicit organization opt-in' },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', modelProvider: 'google', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', tokenMultiplier: 0.8 },
  { id: 'grok-4.7', displayName: 'Grok 4.7', modelProvider: 'xai', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', tokenMultiplier: 0.8 },
  { id: 'glm-5.3', displayName: 'GLM-5.3', modelProvider: 'factory', supportedReasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', tokenMultiplier: 0.56 },
  { id: 'custom:my-llama', displayName: 'My Llama', modelProvider: 'generic-chat-completion-api', isCustom: true, supportedReasoningEfforts: ['none'], defaultReasoningEffort: 'none', noImageSupport: true, tokenMultiplier: 1 },
  { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro', modelProvider: 'openai', supportedReasoningEfforts: ['medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium', tokenMultiplier: 12 },
];

test('multipliers format like the CLI', () => {
  assert.equal(formatMultiplier(1.6), '1.6×');
  assert.equal(formatMultiplier(0.04), '0.04×');
  assert.equal(formatMultiplier(12), '12×');
  assert.equal(formatMultiplier(0.544), '0.544×');
  assert.equal(formatMultiplier(undefined), '');
});

test('models group by provider, with Auto and BYOK groups', () => {
  assert.deepEqual(RAW.map(modelGroup), ['Auto', 'Anthropic', 'Anthropic', 'OpenAI', 'Google', 'xAI', 'Droid Core', 'BYOK', 'OpenAI']);
});

test('catalog keeps multiplier, reasoning and availability fields', () => {
  const { models, defaultModel } = mapModelCatalog(RAW, 'claude-opus-5-5');
  assert.equal(defaultModel, 'claude-opus-5-5');
  const opus = models.find((m) => m.id === 'claude-opus-5-5');
  assert.deepEqual(opus, {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    shortLabel: 'Opus 5.5',
    description: '1.6× Factory token rate · reasoning low–max',
    multiplier: 1.6,
    group: 'Anthropic',
    modelProvider: 'anthropic',
    disabled: false,
    disabledReason: null,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    noImageSupport: false,
    isCustom: false,
  });
  const disabled = models.find((m) => m.id === 'gpt-6.1-sol-ultrafast');
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.disabledReason, 'Requires explicit organization opt-in');
  const byok = models.find((m) => m.isCustom);
  assert.equal(byok.multiplier, null);
  assert.equal(byok.group, 'BYOK');
  assert.equal(byok.noImageSupport, true);
  assert.equal(describeModel(RAW[7]), 'BYOK custom model');
  assert.equal(models.length, RAW.length, 'disabled models stay in the list');
});

test('default model falls back to the first enabled non-router model', () => {
  assert.equal(mapModelCatalog(RAW, 'gpt-6.1-sol-ultrafast').defaultModel, 'claude-opus-5-5');
  assert.equal(mapModelCatalog(RAW, '').defaultModel, 'claude-opus-5-5');
  assert.equal(mapModelCatalog([], '').defaultModel, '');
});

test('reasoning effort resets to the model default when unsupported', () => {
  const { models } = mapModelCatalog(RAW);
  const haiku = models.find((m) => m.id === 'claude-haiku-5-5');
  const glm = models.find((m) => m.id === 'glm-5.3');
  assert.equal(resolveReasoningEffort(haiku, 'high'), 'high');
  assert.equal(resolveReasoningEffort(haiku, 'max'), 'medium');
  assert.equal(resolveReasoningEffort(glm, 'medium'), 'max');
  assert.equal(resolveReasoningEffort(glm, ''), 'max');
  assert.equal(resolveReasoningEffort(null, 'high'), undefined);
});
