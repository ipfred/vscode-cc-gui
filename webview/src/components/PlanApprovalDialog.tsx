import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownBlock from './MarkdownBlock';
import { sendBridgeEvent } from '../utils/bridge';
import { clearDialogDraft, readDialogDraft, writeDialogDraft } from '../utils/dialogStateStorage';
import './PlanApprovalDialog.css';

export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export interface PlanApprovalRequest {
  requestId: string;
  toolName: string;
  plan?: string;
  title?: string;
  /** Share of the context budget a fresh chat would free, as a whole percent (Droid). */
  contextSavingsPercent?: number;
  allowedPrompts?: AllowedPrompt[];
  timestamp?: string;
  deadlineMs?: number;
  dialogToken?: string;
}

export interface PlanApprovalContextUsage {
  percentage: number;
  usedTokens?: number;
  maxTokens?: number;
}

export interface PlanApprovalOptions {
  /** Run the approved spec in a fresh chat instead of the current conversation. */
  newChat?: boolean;
}

interface PlanApprovalDialogProps {
  isOpen: boolean;
  request: PlanApprovalRequest | null;
  onApprove: (requestId: string, targetMode: string, options?: PlanApprovalOptions) => void;
  onReject: (requestId: string) => void;
  /** Autonomy level the dialog starts on (the mode currently selected in the toolbar). */
  initialMode?: string;
  /** Current chat's context consumption, shown next to the approve choices. */
  contextUsage?: PlanApprovalContextUsage;
  /** Offer "New chat" next to "This chat" (Droid only; other providers approve in place). */
  allowNewChat?: boolean;
}

interface PlanApprovalDraft {
  deadlineMs?: number;
  dialogToken?: string;
  selectedMode?: string;
  isCollapsed?: boolean;
}

/**
 * Autonomy levels after approval, lowest to highest. `dots` is how many of the
 * three indicator dots are lit, so a higher level always shows one more dot.
 */
const AUTONOMY_LEVELS = [
  { id: 'default', dots: 0, labelKey: 'droidModes.autoOff.label', fallback: 'Auto (Off)' },
  { id: 'acceptEdits', dots: 1, labelKey: 'droidModes.autoLow.label', fallback: 'Auto (Low)' },
  { id: 'auto', dots: 2, labelKey: 'droidModes.autoMedium.label', fallback: 'Auto (Medium)' },
  { id: 'bypassPermissions', dots: 3, labelKey: 'droidModes.autoHigh.label', fallback: 'Auto (High)' },
] as const;

const isAutonomyLevel = (mode: string | undefined): boolean =>
  AUTONOMY_LEVELS.some((level) => level.id === mode);

function formatTokens(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
}

/** First markdown heading, else the request title, else a generic name. */
function derivePlanTitle(request: PlanApprovalRequest, fallback: string): string {
  const heading = request.plan?.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading || request.title?.trim() || fallback;
}

const PlanApprovalDialog = ({
  isOpen,
  request,
  onApprove,
  onReject,
  initialMode,
  contextUsage,
  allowNewChat = false,
}: PlanApprovalDialogProps) => {
  const { t } = useTranslation();
  const [selectedMode, setSelectedMode] = useState('default');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hydratedRequestKey, setHydratedRequestKey] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A plan waits for the user as long as it takes: no countdown or auto-reject.
  const submittedRef = useRef(false);
  const markSubmitted = useCallback(() => {
    if (submittedRef.current) return false;
    submittedRef.current = true;
    return true;
  }, []);

  const handleApprove = useCallback((newChat: boolean) => {
    if (!request || !markSubmitted()) return;
    clearDialogDraft('planApproval', request.requestId, request.dialogToken);
    setMenuOpen(false);
    onApprove(request.requestId, selectedMode, newChat ? { newChat: true } : undefined);
  }, [request, selectedMode, markSubmitted, onApprove]);

  const handleReject = useCallback(() => {
    if (!request || !markSubmitted()) return;
    clearDialogDraft('planApproval', request.requestId, request.dialogToken);
    setMenuOpen(false);
    onReject(request.requestId);
  }, [request, markSubmitted, onReject]);

  const handleCycleAutonomy = useCallback(() => {
    setSelectedMode((current) => {
      const index = AUTONOMY_LEVELS.findIndex((level) => level.id === current);
      return AUTONOMY_LEVELS[(index + 1) % AUTONOMY_LEVELS.length].id;
    });
  }, []);

  const handleOpenInEditor = useCallback(() => {
    if (!request?.plan) return;
    sendBridgeEvent('open_plan_document', JSON.stringify({
      title: derivePlanTitle(request, 'spec'),
      plan: request.plan,
    }));
  }, [request]);

  useEffect(() => {
    if (!isOpen || !request) {
      setHydratedRequestKey(null);
      return;
    }
    submittedRef.current = false;
    setMenuOpen(false);
    const draft = readDialogDraft<PlanApprovalDraft>('planApproval', request.requestId, request.deadlineMs, request.dialogToken);
    const restoredMode = draft?.selectedMode;
    if (isAutonomyLevel(restoredMode)) {
      setSelectedMode(restoredMode!);
    } else {
      setSelectedMode(isAutonomyLevel(initialMode) ? initialMode! : 'default');
    }
    setIsCollapsed(draft?.isCollapsed === true);
    setHydratedRequestKey(request.dialogToken ?? request.requestId);
    // initialMode only seeds the first render of a request; later toolbar changes must not reset the user's pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, request?.requestId, request?.dialogToken, request?.deadlineMs]);

  useEffect(() => {
    const requestId = request?.requestId;
    const deadlineMs = request?.deadlineMs;
    if (!isOpen || requestId === undefined || hydratedRequestKey !== (request?.dialogToken ?? requestId)) {
      return;
    }
    writeDialogDraft('planApproval', requestId, {
      deadlineMs,
      dialogToken: request?.dialogToken,
      selectedMode,
      isCollapsed,
    });
  }, [hydratedRequestKey, isCollapsed, isOpen, request?.requestId, request?.dialogToken, request?.deadlineMs, selectedMode]);

  // Closing the approve menu: outside click or Escape. Approving or rejecting
  // is never bound to a bare key, so a stray Enter cannot start the work.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  if (!isOpen || !request) {
    return null;
  }

  const title = derivePlanTitle(request, t('planApproval.planFallbackTitle', 'Spec'));

  if (isCollapsed) {
    return (
      <div className="permission-dialog-overlay collapsed-mode">
        <div className="plan-approval-dialog-collapsed">
          <div className="collapsed-header">
            <span className="collapsed-title">
              {t('planApproval.title', 'Plan Ready for Approval')}
            </span>
          </div>
          <button
            className="expand-button"
            onClick={() => setIsCollapsed(false)}
            title={t('common.expand', 'Expand')}
          >
            <span className="codicon codicon-chevron-up" />
          </button>
        </div>
      </div>
    );
  }

  const level = AUTONOMY_LEVELS.find((entry) => entry.id === selectedMode) ?? AUTONOMY_LEVELS[0];
  const levelLabel = t(level.labelKey, level.fallback);
  const usedPercent = contextUsage && contextUsage.percentage > 0
    ? Math.min(100, Math.round(contextUsage.percentage))
    : null;
  const usedTokens = formatTokens(contextUsage?.usedTokens);
  const maxTokens = formatTokens(contextUsage?.maxTokens);
  const savings = typeof request.contextSavingsPercent === 'number' && request.contextSavingsPercent > 0
    ? Math.round(request.contextSavingsPercent)
    : null;

  return (
    <div className="permission-dialog-overlay plan-approval-fullscreen">
      <div className="plan-approval-screen">
        <div className="plan-approval-topbar">
          <span className="plan-approval-tab">
            <span className="codicon codicon-checklist" />
            {t('planApproval.tab', 'Plan')}
          </span>
          <span className="plan-approval-doc-title" title={title}>{title}</span>
          <div className="plan-approval-topbar-actions">
            {request.plan && (
              <button
                className="collapse-button"
                data-testid="plan-open-in-editor"
                onClick={handleOpenInEditor}
                title={t('planApproval.openInEditor', 'Open in VS Code editor')}
                aria-label={t('planApproval.openInEditor', 'Open in VS Code editor')}
              >
                <span className="codicon codicon-go-to-file" />
              </button>
            )}
            <button
              className="collapse-button"
              onClick={() => setIsCollapsed(true)}
              title={t('common.collapse', 'Collapse')}
              aria-label={t('common.collapse', 'Collapse')}
            >
              <span className="codicon codicon-chevron-down" />
            </button>
          </div>
        </div>

        <div className="plan-approval-body">
          {request.plan ? (
            <div className="plan-approval-content">
              <MarkdownBlock content={request.plan} isStreaming={false} />
            </div>
          ) : (
            <div className="plan-approval-empty">
              {t('planApproval.emptyPlan', 'The plan has no content to preview.')}
            </div>
          )}
        </div>

        <div className="plan-approval-footer">
          <button
            className="plan-autonomy-button"
            data-testid="plan-autonomy"
            onClick={handleCycleAutonomy}
            title={t('planApproval.autonomyTooltip', '{{level}}. Click to change how much can run without asking', { level: levelLabel })}
            aria-label={`${t('planApproval.autonomy', 'Autonomy')}: ${levelLabel}`}
          >
            <span>{t('planApproval.autonomy', 'Autonomy')}</span>
            <span className="plan-autonomy-dots" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span key={index} className={`plan-autonomy-dot${index < level.dots ? ' on' : ''}`} />
              ))}
            </span>
          </button>

          <div className="plan-approval-footer-right">
            <button className="action-button secondary" onClick={handleReject}>
              {t('planApproval.keepIterating', 'Keep iterating')}
            </button>
            <div className="plan-approve-split" ref={menuRef}>
              <button
                className="action-button primary"
                data-testid="plan-approve"
                {...(allowNewChat ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menuOpen } : {})}
                onClick={() => (allowNewChat ? setMenuOpen((open) => !open) : handleApprove(false))}
              >
                {t('planApproval.approveSpec', 'Approve Spec')}
                {allowNewChat && <span className={`codicon codicon-chevron-${menuOpen ? 'down' : 'up'}`} />}
              </button>
              {allowNewChat && menuOpen && (
                <div className="plan-approve-menu" role="menu">
                  <button
                    className="plan-approve-option"
                    role="menuitem"
                    data-testid="plan-approve-this-chat"
                    onClick={() => handleApprove(false)}
                  >
                    <span className="codicon codicon-comment" />
                    <span className="plan-approve-option-text">
                      <span className="plan-approve-option-title">{t('planApproval.thisChat', 'This chat')}</span>
                      <span className="plan-approve-option-desc">
                        {t('planApproval.thisChatDesc', 'Keep the current conversation')}
                      </span>
                    </span>
                    {usedPercent !== null && (
                      <span className="plan-approve-option-note" data-testid="plan-context-used">
                        {usedTokens && maxTokens
                          ? t('planApproval.contextUsedTokens', '{{used}} / {{max}} used ({{percent}}%)', { used: usedTokens, max: maxTokens, percent: usedPercent })
                          : t('planApproval.contextUsed', '{{percent}}% context used', { percent: usedPercent })}
                      </span>
                    )}
                  </button>
                  <button
                    className="plan-approve-option"
                    role="menuitem"
                    data-testid="plan-approve-new-chat"
                    onClick={() => handleApprove(true)}
                  >
                    <span className="codicon codicon-add" />
                    <span className="plan-approve-option-text">
                      <span className="plan-approve-option-title">{t('planApproval.newChat', 'New chat')}</span>
                      <span className="plan-approve-option-desc">
                        {t('planApproval.newChatDesc', 'Start fresh with only the approved spec')}
                      </span>
                    </span>
                    {savings !== null && (
                      <span className="plan-approve-option-note" data-testid="plan-context-savings">
                        {t('planApproval.contextSavings', '({{percent}}% context savings)', { percent: savings })}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlanApprovalDialog;
