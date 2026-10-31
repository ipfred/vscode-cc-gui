import { describe, expect, it } from 'vitest';
import { buildDroidModelSections } from './droidModelUtils';
import type { ModelInfo } from './types';

const m = (id: string, label: string, group: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label,
  group,
  multiplier: 1,
  ...extra,
});

const CATALOG: ModelInfo[] = [
  m('auto', 'Auto Model', 'Auto'),
  m('claude-fable-5.1', 'Fable 5.1', 'Anthropic'),
  m('claude-fable-5', 'Fable 5', 'Anthropic'),
  m('claude-opus-5-5', 'Opus 5.5', 'Anthropic'),
  m('claude-opus-5-5-fast', 'Opus 5.5 Fast Mode', 'Anthropic'),
  m('claude-opus-5', 'Opus 5', 'Anthropic'),
  m('claude-opus-4-8', 'Opus 4.8', 'Anthropic'),
  m('claude-sonnet-5-5', 'Sonnet 5.5', 'Anthropic'),
  m('claude-sonnet-4-6', 'Sonnet 4.6', 'Anthropic'),
  m('claude-haiku-5-5', 'Haiku 5.5', 'Anthropic'),
  m('claude-haiku-4-5', 'Haiku 4.5', 'Anthropic'),
  m('gpt-6-astra', 'GPT-6 Astra', 'OpenAI'),
  m('gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI'),
  m('gpt-6.1-sol-ultrafast', 'GPT-6.1 Sol Ultra Fast', 'OpenAI', { disabled: true }),
  m('gpt-6-sol', 'GPT-6 Sol', 'OpenAI'),
  m('gpt-6-luna', 'GPT-6 Luna', 'OpenAI'),
  m('gpt-5.6-luna', 'GPT-5.6 Luna', 'OpenAI'),
  m('kimi-k3', 'Kimi K3', 'Droid Core'),
  m('glm-5.3', 'GLM-5.3', 'Droid Core'),
  m('glm-5.3-flash', 'GLM-5.3-Flash', 'Droid Core'),
  m('glm-5.2', 'GLM-5.2', 'Droid Core'),
  m('minimax-m2.7', 'MiniMax M2.7 [Deprecated]', 'Droid Core'),
  m('my-byok', 'Mine', 'BYOK', { isCustom: true }),
  m('my-byok-old', 'Mine 1', 'BYOK', { isCustom: true }),
];

const ids = (section: { models: ModelInfo[] } | undefined) => section?.models.map((x) => x.id);

describe('buildDroidModelSections', () => {
  it('pins Auto and featured models in a header-less block and removes them from vendor groups', () => {
    const { sections } = buildDroidModelSections(CATALOG, 100);
    expect(sections[0].id).toBe('featured');
    expect(sections[0].label).toBe('');
    expect(ids(sections[0])).toEqual(['auto', 'claude-opus-5-5', 'gpt-6.1-sol', 'kimi-k3', 'glm-5.3']);
    const grouped = sections.slice(1).flatMap((s) => s.models.map((x) => x.id));
    expect(grouped).not.toContain('claude-opus-5-5');
    expect(grouped).not.toContain('gpt-6.1-sol');
  });

  it('keeps only the newest generation per family, including its fast variants', () => {
    const { sections, hiddenCount } = buildDroidModelSections(CATALOG, 100);
    const byId = Object.fromEntries(sections.map((s) => [s.id, ids(s)]));
    expect(byId.Anthropic).toEqual(['claude-fable-5.1', 'claude-opus-5-5-fast', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(byId.OpenAI).toEqual(['gpt-6-astra', 'gpt-6.1-sol-ultrafast', 'gpt-6-luna']);
    expect(byId['Droid Core']).toEqual(['glm-5.3-flash']);
    expect(byId.BYOK).toEqual(['my-byok', 'my-byok-old']);
    expect(hiddenCount).toBe(0);
  });

  it('moves everything not shown into the legacy bucket', () => {
    const { sections, legacy } = buildDroidModelSections(CATALOG, 100);
    const shown = sections.flatMap((s) => s.models.map((x) => x.id));
    expect(shown.length + legacy.length).toBe(CATALOG.length);
    expect(legacy.map((x) => x.id)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-6-sol',
      'gpt-5.6-luna',
      'glm-5.2',
      'minimax-m2.7',
    ]);
  });

  it('keeps the selected model visible even when it is an older generation', () => {
    const { sections } = buildDroidModelSections(CATALOG, 100, { selectedId: 'claude-opus-4-8' });
    expect(ids(sections.find((s) => s.id === 'Anthropic'))).toContain('claude-opus-4-8');
  });

  it('lists every match grouped by vendor while searching', () => {
    const { sections, hiddenCount, legacy } = buildDroidModelSections(CATALOG, 100, { searching: true });
    expect(sections.map((s) => s.id)).toEqual(['Auto', 'Anthropic', 'OpenAI', 'Droid Core', 'BYOK']);
    expect(ids(sections.find((s) => s.id === 'Anthropic'))).toContain('claude-opus-4-8');
    expect(hiddenCount).toBe(0);
    expect(legacy).toEqual([]);
  });

  it('skips featured ids that are not in the catalog', () => {
    const { sections } = buildDroidModelSections([m('auto', 'Auto Model', 'Auto')], 100);
    expect(ids(sections[0])).toEqual(['auto']);
  });
});
