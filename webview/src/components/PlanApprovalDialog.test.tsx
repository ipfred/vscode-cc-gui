import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanApprovalDialog, { type PlanApprovalRequest } from './PlanApprovalDialog';
import { resetLinkifyCapabilities, setLinkifyCapabilities } from '../utils/linkifyCapabilities';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn(() => true) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: unknown, options?: Record<string, unknown>) => {
      if (typeof fallbackOrOptions !== 'string') return key;
      return fallbackOrOptions.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

const buildRequest = (overrides: Partial<PlanApprovalRequest> = {}): PlanApprovalRequest => ({
  requestId: 'plan-test-1',
  toolName: 'ExitPlanMode',
  plan: '# Ship it\n\nSimple plan body',
  ...overrides,
});

beforeEach(() => {
  resetLinkifyCapabilities();
  setLinkifyCapabilities({ classNavigationEnabled: true });
  sessionStorage.clear();
  vi.mocked(sendBridgeEvent).mockClear();
});

describe('PlanApprovalDialog', () => {
  it('reuses MarkdownBlock linkify inside the dialog content', () => {
    const request = buildRequest({
      plan: [
        'Review src/components/App.tsx',
        '',
        'Check com.github.claudecodegui.handler.file.OpenFileHandler',
        '',
        'Reference https://example.com/docs',
      ].join('\n'),
    });

    render(<PlanApprovalDialog isOpen request={request} onApprove={() => {}} onReject={() => {}} />);

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'com.github.claudecodegui.handler.file.OpenFileHandler' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });

  it('shows the plan heading as the document title', () => {
    const { container } = render(
      <PlanApprovalDialog isOpen request={buildRequest()} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(container.querySelector('.plan-approval-doc-title')?.textContent).toBe('Ship it');
  });

  it('opens the plan in the VS Code editor', () => {
    render(<PlanApprovalDialog isOpen request={buildRequest()} onApprove={vi.fn()} onReject={vi.fn()} />);
    fireEvent.click(screen.getByTestId('plan-open-in-editor'));
    expect(sendBridgeEvent).toHaveBeenCalledWith(
      'open_plan_document',
      JSON.stringify({ title: 'Ship it', plan: '# Ship it\n\nSimple plan body' }),
    );
  });

  it('cycles through the four autonomy levels, one more dot per level', () => {
    const { container } = render(
      <PlanApprovalDialog isOpen request={buildRequest()} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    const lit = () => container.querySelectorAll('.plan-autonomy-dot.on').length;
    const button = screen.getByTestId('plan-autonomy');

    expect(lit()).toBe(0);
    fireEvent.click(button);
    expect(lit()).toBe(1);
    fireEvent.click(button);
    expect(lit()).toBe(2);
    fireEvent.click(button);
    expect(lit()).toBe(3);
    fireEvent.click(button);
    expect(lit()).toBe(0);
  });

  it('starts on the mode currently selected in the toolbar', () => {
    render(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        initialMode="auto"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-autonomy').getAttribute('aria-label')).toBe('Autonomy: Auto (Medium)');
  });

  it('approves in place with the chosen autonomy when New chat is not offered', () => {
    const onApprove = vi.fn();
    render(<PlanApprovalDialog isOpen request={buildRequest()} onApprove={onApprove} onReject={vi.fn()} />);

    fireEvent.click(screen.getByTestId('plan-autonomy'));
    fireEvent.click(screen.getByTestId('plan-approve'));

    expect(screen.queryByTestId('plan-approve-new-chat')).toBeNull();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0].slice(0, 2)).toEqual(['plan-test-1', 'acceptEdits']);
  });

  it('offers This chat / New chat with context numbers when New chat is allowed', () => {
    const onApprove = vi.fn();
    render(
      <PlanApprovalDialog
        isOpen
        allowNewChat
        request={buildRequest({ contextSavingsPercent: 62 })}
        contextUsage={{ percentage: 41.6, usedTokens: 83_200, maxTokens: 200_000 }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('plan-approve'));
    expect(screen.getByTestId('plan-context-used').textContent).toBe('83.2K / 200K used (42%)');
    expect(screen.getByTestId('plan-context-savings').textContent).toBe('(62% context savings)');

    fireEvent.click(screen.getByTestId('plan-approve-new-chat'));
    expect(onApprove).toHaveBeenCalledWith('plan-test-1', 'default', { newChat: true });
  });

  it('approves in this chat from the menu without the newChat flag', () => {
    const onApprove = vi.fn();
    render(
      <PlanApprovalDialog isOpen allowNewChat request={buildRequest()} onApprove={onApprove} onReject={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('plan-approve'));
    fireEvent.click(screen.getByTestId('plan-approve-this-chat'));
    expect(onApprove.mock.calls[0].slice(0, 3)).toEqual(['plan-test-1', 'default', undefined]);
  });

  it('closes the approve menu on Escape without answering', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanApprovalDialog isOpen allowNewChat request={buildRequest()} onApprove={onApprove} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId('plan-approve'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe('PlanApprovalDialog without a time limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('never auto-rejects and shows no countdown, however long the user takes', () => {
    const onReject = vi.fn();
    const { container } = render(
      <PlanApprovalDialog isOpen request={buildRequest()} onApprove={vi.fn()} onReject={onReject} />,
    );

    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });

    expect(onReject).not.toHaveBeenCalled();
    expect(container.querySelector('.countdown-timer')).toBeNull();
    expect(container.querySelector('.timeout-warning-banner')).toBeNull();
  });

  it('still approves after a long wait, and only once', () => {
    const onApprove = vi.fn();
    render(<PlanApprovalDialog isOpen request={buildRequest()} onApprove={onApprove} onReject={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    const approve = screen.getByTestId('plan-approve');
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0].slice(0, 2)).toEqual(['plan-test-1', 'default']);
  });

  it('keep iterating is submitted once', () => {
    const onReject = vi.fn();
    render(<PlanApprovalDialog isOpen request={buildRequest()} onApprove={vi.fn()} onReject={onReject} />);

    const reject = screen.getByRole('button', { name: 'Keep iterating' });
    fireEvent.click(reject);
    fireEvent.click(reject);

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith('plan-test-1');
  });
});
