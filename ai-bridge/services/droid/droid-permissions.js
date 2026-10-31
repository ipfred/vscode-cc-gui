/**
 * Droid permission / ask-user requests → CC GUI permission dialogs.
 *
 * Droid sends one `request_permission` per batch of tool uses with the set of
 * outcomes it accepts in `options`. Only an offered outcome may be returned,
 * otherwise the CLI rejects the response and the tool call hangs.
 */

import { mapDroidToolUse } from './droid-tool-mapping.js';
import { planApprovalOutcomes } from './droid-modes.js';

/**
 * Pick the first preferred outcome that the request offers. Falls back to
 * cancel (always offered in practice) and finally the first option.
 */
export function pickOfferedOutcome(options, preferred) {
  const offered = new Set((Array.isArray(options) ? options : [])
    .map((option) => option?.value)
    .filter((value) => typeof value === 'string'));
  for (const value of preferred) {
    if (offered.has(value)) return value;
  }
  if (offered.has('cancel')) return 'cancel';
  return options?.[0]?.value ?? 'cancel';
}

/** Tool input shown in the approval dialog for one Droid tool use. */
export function permissionDialogInput(toolUse) {
  const raw = toolUse?.toolUse || {};
  const mapped = mapDroidToolUse(raw.name, raw.input);
  const details = toolUse?.details && typeof toolUse.details === 'object' ? toolUse.details : {};
  const input = { ...mapped.input };
  // Edit confirmations carry full before/after text; the dialog's diff view
  // renders those better than the bare old_string/new_string fragment.
  if (details.type === 'edit' && typeof details.oldContent === 'string' && typeof details.newContent === 'string') {
    input.old_string = input.old_string ?? details.oldContent;
    input.new_string = input.new_string ?? details.newContent;
  }
  if (details.type === 'mcp_tool' && !raw.name && details.toolName) {
    return { toolName: String(details.toolName), input };
  }
  return { toolName: mapped.name, input };
}

/**
 * Resolve one Droid permission request.
 * @param {object} params RequestPermissionRequestParams ({toolUses, options})
 * @param {object} deps {requestPermission(toolName,input)→bool, requestPlanApproval(input)→{approved,targetMode}}
 * @returns {Promise<string>} the selected ToolConfirmationOutcome value
 */
export async function resolveDroidPermission(params, deps) {
  const toolUses = Array.isArray(params?.toolUses) ? params.toolUses : [];
  const options = params?.options;

  const specExit = toolUses.find((item) => item?.confirmationType === 'exit_spec_mode'
    || item?.details?.type === 'exit_spec_mode');
  if (specExit) {
    const plan = specExit.details?.plan ?? specExit.toolUse?.input?.plan ?? '';
    const result = await deps.requestPlanApproval({
      plan: String(plan || ''),
      ...(typeof specExit.details?.title === 'string' ? { title: specExit.details.title } : {}),
      ...(Number.isFinite(specExit.details?.contextSavingsPercent)
        ? { contextSavingsPercent: specExit.details.contextSavingsPercent }
        : {}),
    });
    if (!result?.approved) return pickOfferedOutcome(options, ['cancel']);
    return pickOfferedOutcome(options, planApprovalOutcomes(result.targetMode));
  }

  if (toolUses.length === 0) return pickOfferedOutcome(options, ['cancel']);

  for (const item of toolUses) {
    const { toolName, input } = permissionDialogInput(item);
    let allowed = false;
    try {
      allowed = await deps.requestPermission(toolName, input);
    } catch {
      allowed = false;
    }
    if (!allowed) return pickOfferedOutcome(options, ['cancel']);
  }
  return pickOfferedOutcome(options, ['proceed_once']);
}

/** Droid ask_user questions → AskUserQuestion dialog questions. */
export function toDialogQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((q) => ({
    question: String(q?.question ?? ''),
    header: String(q?.topic ?? '').replace(/-/g, ' '),
    options: (Array.isArray(q?.options) ? q.options : []).map((label) => ({ label: String(label), description: '' })),
    multiSelect: false,
  }));
}

/**
 * Dialog answers (keyed by question text; string or string[]) → Droid
 * AskUserResult. A null answer set means the dialog timed out or was closed.
 */
export function toAskUserResult(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  if (!answers || typeof answers !== 'object') {
    return { cancelled: true, answers: [] };
  }
  const mapped = [];
  for (const q of list) {
    const value = answers[q?.question];
    let answer = '';
    if (Array.isArray(value)) answer = value.map(String).join(', ');
    else if (value && typeof value === 'object' && Array.isArray(value.answers)) answer = value.answers.map(String).join(', ');
    else if (value != null) answer = String(value);
    if (!answer) continue;
    mapped.push({ index: Number(q.index) || mapped.length + 1, question: String(q.question ?? ''), answer });
  }
  if (mapped.length === 0) return { cancelled: true, answers: [] };
  return { answers: mapped };
}
