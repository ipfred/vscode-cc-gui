import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelSelect } from './ModelSelect';
import { CLAUDE_MODELS, CODEX_MODELS, formatDroidMultiplier } from '../types';
import type { ModelInfo } from '../types';
import { STORAGE_KEYS } from '../../../types/provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? options?.defaultValue ?? key,
  }),
}));

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: ({
    providerId,
    modelId,
  }: {
    providerId?: string;
    modelId?: string;
  }) => (
    <span
      data-testid="model-icon"
      data-provider-id={providerId ?? ''}
      data-model-id={modelId ?? ''}
    />
  ),
}));

describe('ModelSelect', () => {
  const sonnetModel: ModelInfo = {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 · Use the default model',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('rerender 后应读取最新的 Claude 模型映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-4');

    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-5' }),
    );

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5');
  });

  it('closed trigger uses mapped model id for icon (e.g. DeepSeek, not Claude)', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'deepseek-v4-pro[1m]' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    const triggerIcon = screen.getByRole('button').querySelector('[data-testid="model-icon"]');
    expect(triggerIcon).not.toBeNull();
    expect(triggerIcon?.getAttribute('data-provider-id')).toBe('claude');
    expect(triggerIcon?.getAttribute('data-model-id')).toBe('deepseek-v4-pro[1m]');
  });

  it('没有具体映射时应回退到全局 main 映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ main: 'glm-4.7', fable: 'glm-5.2' }),
    );

    render(
      <ModelSelect
        value="claude-fable-5"
        onChange={vi.fn()}
        models={[
          sonnetModel,
          { id: 'claude-fable-5', label: 'Fable 5', description: 'Fable 5 · Most powerful · Mythos-class' },
        ]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5.2');
  });

  it('Claude 内置模型列表应按目标顺序展示最新模型，并移除旧可见项', () => {
    expect(CLAUDE_MODELS.map((model) => model.id)).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    const ids = CLAUDE_MODELS.map((model) => model.id);
    expect(ids).not.toContain('claude-opus-4-8');
    expect(ids).not.toContain('claude-opus-4-7');
    expect(ids).not.toContain('claude-opus-4-6');
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-sonnet-4-7');
    expect(ids.some((id) => id.endsWith('[1m]'))).toBe(false);
  });

  it('Codex 内置模型列表应与目标设计一致', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  // Third-party catalogs expose models whose ids collide with the claude-*
  // mapping slots. Non-claude providers must render catalog labels verbatim.
  it('非 Claude 提供商应原样显示目录标签，不受 Claude 模型映射影响', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });

  it('同一模型 ID 切换到非 Claude 提供商后不应沿用 Claude 映射标签', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('glm-4');

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });

  it('多提供商目录应按前缀分组并渲染分组标题', () => {
    const catalog: ModelInfo[] = [
      { id: 'auto', label: 'OMP Auto' },
      { id: 'fufei/kimi-k3', label: 'fufei/kimi-k3' },
      { id: 'kimi-code/k3', label: 'kimi-code/k3' },
      { id: 'kimi-code/k3-256k', label: 'kimi-code/k3-256k' },
    ];

    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={catalog}
        currentProvider="omp"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('model-group-other')).toBeTruthy();
    expect(screen.getByTestId('model-group-fufei')).toBeTruthy();
    expect(screen.getByTestId('model-group-kimi-code')).toBeTruthy();
    expect(screen.getByTestId('model-option-auto')).toBeTruthy();
    expect(screen.getByTestId('model-option-kimi-code/k3-256k')).toBeTruthy();
  });

  it('单一前缀目录不渲染分组标题', () => {
    const catalog: ModelInfo[] = [
      { id: 'auto', label: 'OMP Auto' },
      { id: 'deepseek/deepseek-flash', label: 'deepseek/deepseek-flash' },
      { id: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash' },
    ];

    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={catalog}
        currentProvider="omp"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByTestId('model-group-other')).toBeNull();
    expect(screen.queryByTestId('model-group-deepseek')).toBeNull();
    expect(screen.getByTestId('model-option-deepseek/deepseek-flash')).toBeTruthy();
  });

  describe('Droid catalog', () => {
    const droidCatalog: ModelInfo[] = [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', group: 'OpenAI', multiplier: 0.04, supportedReasoningEfforts: ['low', 'high'] },
      { id: 'my-byok', label: 'My BYOK', group: 'BYOK', multiplier: null, isCustom: true },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Anthropic', multiplier: 1.6, description: '1.6× Factory token rate · reasoning low–max' },
      { id: 'auto-router', label: 'Auto', group: 'Auto', multiplier: 1 },
      { id: 'grok-5', label: 'Grok 5', group: 'xAI', multiplier: 12, disabled: true, disabledReason: 'Requires Max plan' },
    ];

    it('formats multiplier badges with trimmed zeros and at most three decimals', () => {
      expect(formatDroidMultiplier(1.6)).toBe('1.6×');
      expect(formatDroidMultiplier(0.04)).toBe('0.04×');
      expect(formatDroidMultiplier(12)).toBe('12×');
      expect(formatDroidMultiplier(1.0)).toBe('1×');
      expect(formatDroidMultiplier(0.33333)).toBe('0.333×');
      expect(formatDroidMultiplier(null)).toBe('');
    });

    it('pins Auto and featured models in a header-less top block, then groups by vendor', () => {
      render(
        <ModelSelect value="claude-opus-5-5" onChange={vi.fn()} models={droidCatalog} currentProvider="droid" />,
      );
      fireEvent.click(screen.getByRole('button'));

      const groups = Array.from(document.querySelectorAll('[data-testid^="model-group-"]'))
        .map((el) => el.getAttribute('data-testid')!.replace('model-group-', ''));
      expect(groups).toEqual(['OpenAI', 'xAI', 'BYOK']);

      const featured = within(screen.getByTestId('model-section-featured'))
        .getAllByTestId(/^model-option-/)
        .map((el) => el.getAttribute('data-testid'));
      expect(featured).toEqual(['model-option-auto-router', 'model-option-claude-opus-5-5']);
      expect(screen.getByTestId('model-rate-auto-router').textContent).toBe('Dynamic');

      expect(screen.getByTestId('model-rate-claude-opus-5-5').textContent).toBe('1.6×');
      expect(screen.getByTestId('model-rate-gpt-6-luna').textContent).toBe('0.04×');
      expect(screen.getByTestId('model-rate-grok-5').textContent).toBe('12×');
      // BYOK rows show the BYOK badge instead of a multiplier.
      expect(screen.getByTestId('model-rate-my-byok').textContent).toBe('BYOK');
      // Built description when the payload has none.
      expect(screen.getByTestId('model-option-gpt-6-luna').textContent).toContain('reasoning low–high');
    });

    it('tucks older generations behind an expandable Legacy row', () => {
      const catalog: ModelInfo[] = [
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'Anthropic', multiplier: 0.8 },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'Anthropic', multiplier: 1.2 },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'Anthropic', multiplier: 0.4 },
      ];
      render(
        <ModelSelect value="claude-sonnet-5-5" onChange={vi.fn()} models={catalog} currentProvider="droid" />,
      );
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('model-option-claude-sonnet-5-5')).toBeTruthy();
      expect(screen.queryByTestId('model-option-claude-sonnet-4-6')).toBeNull();
      expect(screen.getByTestId('model-legacy-toggle').textContent).toBe('Show legacy models (1)');

      fireEvent.click(screen.getByTestId('model-legacy-toggle'));
      expect(screen.getByTestId('model-option-claude-sonnet-4-6')).toBeTruthy();
      // The only Haiku is already the newest of its family, so it was never legacy.
      expect(screen.getByTestId('model-option-claude-haiku-4-5')).toBeTruthy();
    });

    it('shows the active rate on the trigger', () => {
      render(
        <ModelSelect value="claude-opus-5-5" onChange={vi.fn()} models={droidCatalog} currentProvider="droid" />,
      );
      expect(screen.getByRole('button').textContent).toContain('Opus 5.5 · 1.6×');
    });

    it('greys out disabled models, shows the reason and ignores clicks', () => {
      const onChange = vi.fn();
      render(
        <ModelSelect value="claude-opus-5-5" onChange={onChange} models={droidCatalog} currentProvider="droid" />,
      );
      fireEvent.click(screen.getByRole('button'));

      const disabledRow = screen.getByTestId('model-option-grok-5');
      expect(disabledRow.getAttribute('aria-disabled')).toBe('true');
      expect(disabledRow.className).toContain('disabled');
      expect(disabledRow.textContent).toContain('Requires Max plan');
      fireEvent.click(disabledRow);
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('model-option-gpt-6-luna'));
      expect(onChange).toHaveBeenCalledWith('gpt-6-luna');
    });

    it('offers a manual refresh row only for Droid', () => {
      const onRefresh = vi.fn();
      const { unmount } = render(
        <ModelSelect value="claude-opus-5-5" onChange={vi.fn()} models={droidCatalog} currentProvider="droid" onRefresh={onRefresh} />,
      );
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByTestId('model-refresh'));
      expect(onRefresh).toHaveBeenCalledTimes(1);
      unmount();

      render(
        <ModelSelect value="auto" onChange={vi.fn()} models={[{ id: 'auto', label: 'OMP Auto' }]} currentProvider="omp" onRefresh={onRefresh} />,
      );
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByTestId('model-refresh')).toBeNull();
    });
  });

  it('选中值不在列表中（如 OMP 角色）时触发器应显示原值而非回退到第一项', () => {
    render(
      <ModelSelect
        value="smol"
        onChange={vi.fn()}
        models={[{ id: 'auto', label: 'OMP Auto' }]}
        currentProvider="omp"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('smol');
    expect(screen.getByRole('button').textContent).not.toContain('OMP Auto');
  });
});
