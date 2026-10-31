import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOfferedOutcome, resolveDroidPermission, toAskUserResult, toDialogQuestions, permissionDialogInput } from './droid-permissions.js';
import { permissionModeToDroid, droidToPermissionMode, planApprovalOutcomes } from './droid-modes.js';

const EDIT_OPTIONS = [
  { label: 'Yes, allow', value: 'proceed_once' },
  { label: 'Yes, and always allow low impact commands', value: 'proceed_always' },
  { label: 'No, cancel', value: 'cancel' },
];

const editRequest = {
  toolUses: [{
    toolUse: { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.txt', old_str: 'world', new_str: 'droid' } },
    confirmationType: 'edit',
    details: { type: 'edit', filePath: '/a.txt', fileName: 'a.txt', oldContent: 'hello\nworld\n', newContent: 'hello\ndroid\n' },
  }],
  options: EDIT_OPTIONS,
};

test('pickOfferedOutcome only returns offered values', () => {
  assert.equal(pickOfferedOutcome(EDIT_OPTIONS, ['proceed_auto_run_high', 'proceed_once']), 'proceed_once');
  assert.equal(pickOfferedOutcome(EDIT_OPTIONS, ['proceed_new_session']), 'cancel');
  assert.equal(pickOfferedOutcome([{ value: 'proceed_once' }], ['proceed_edit']), 'proceed_once');
});

test('allowed edit proceeds once; dialog sees Claude-shaped Edit input', async () => {
  const seen = [];
  const outcome = await resolveDroidPermission(editRequest, {
    requestPermission: async (toolName, input) => { seen.push({ toolName, input }); return true; },
    requestPlanApproval: async () => assert.fail('not a spec exit'),
  });
  assert.equal(outcome, 'proceed_once');
  assert.equal(seen[0].toolName, 'Edit');
  assert.equal(seen[0].input.file_path, '/a.txt');
  assert.equal(seen[0].input.old_string, 'world');
});

test('denied, failed or timed-out permission cancels', async () => {
  for (const requestPermission of [async () => false, async () => { throw new Error('ipc'); }]) {
    const outcome = await resolveDroidPermission(editRequest, { requestPermission, requestPlanApproval: async () => ({}) });
    assert.equal(outcome, 'cancel');
  }
});

test('a batch is approved only when every tool use is approved', async () => {
  const batch = {
    ...editRequest,
    toolUses: [
      editRequest.toolUses[0],
      { toolUse: { id: 't2', name: 'Execute', input: { command: 'rm -rf build' } }, confirmationType: 'exec', details: { type: 'exec' } },
    ],
  };
  const asked = [];
  const outcome = await resolveDroidPermission(batch, {
    requestPermission: async (toolName) => { asked.push(toolName); return toolName !== 'Bash'; },
    requestPlanApproval: async () => ({}),
  });
  assert.deepEqual(asked, ['Edit', 'Bash']);
  assert.equal(outcome, 'cancel');
});

test('spec exit goes through plan approval and maps the chosen autonomy', async () => {
  const options = [
    { value: 'proceed_once' }, { value: 'proceed_auto_run_low' }, { value: 'proceed_auto_run_medium' },
    { value: 'proceed_auto_run_high' }, { value: 'proceed_new_session' }, { value: 'cancel' },
  ];
  const request = {
    toolUses: [{ toolUse: { id: 's1', name: 'ExitSpecMode', input: {} }, confirmationType: 'exit_spec_mode', details: { type: 'exit_spec_mode', plan: '# Plan' } }],
    options,
  };
  let plan = null;
  const approve = (targetMode) => resolveDroidPermission(request, {
    requestPermission: async () => assert.fail('plan approval only'),
    requestPlanApproval: async (input) => { plan = input.plan; return { approved: true, targetMode }; },
  });
  assert.equal(await approve('default'), 'proceed_once');
  assert.equal(plan, '# Plan');
  assert.equal(await approve('acceptEdits'), 'proceed_auto_run_low');
  assert.equal(await approve('auto'), 'proceed_auto_run_medium');
  assert.equal(await approve('bypassPermissions'), 'proceed_auto_run_high');
  const rejected = await resolveDroidPermission(request, {
    requestPermission: async () => true,
    requestPlanApproval: async () => ({ approved: false }),
  });
  assert.equal(rejected, 'cancel');
  // Never offer the new-session handoff, even when the CLI does.
  assert.ok(!planApprovalOutcomes('auto').some((o) => o.startsWith('proceed_new_session')));
});

test('spec exit forwards the title and context savings to the dialog', async () => {
  let seen = null;
  await resolveDroidPermission({
    toolUses: [{ confirmationType: 'exit_spec_mode', details: { type: 'exit_spec_mode', plan: 'p', title: 'Add auth', contextSavingsPercent: 62 } }],
    options: [{ value: 'proceed_once' }, { value: 'cancel' }],
  }, { requestPermission: async () => true, requestPlanApproval: async (input) => { seen = input; return { approved: false }; } });
  assert.deepEqual(seen, { plan: 'p', title: 'Add auth', contextSavingsPercent: 62 });

  seen = null;
  await resolveDroidPermission({
    toolUses: [{ confirmationType: 'exit_spec_mode', details: { type: 'exit_spec_mode', plan: 'p' } }],
    options: [{ value: 'cancel' }],
  }, { requestPermission: async () => true, requestPlanApproval: async (input) => { seen = input; return { approved: false }; } });
  assert.deepEqual(seen, { plan: 'p' });
});

test('spec exit falls back to proceed_once when the auto-run outcome is not offered', async () => {
  const outcome = await resolveDroidPermission({
    toolUses: [{ confirmationType: 'exit_spec_mode', details: { type: 'exit_spec_mode', plan: 'p' } }],
    options: [{ value: 'proceed_once' }, { value: 'cancel' }],
  }, { requestPermission: async () => true, requestPlanApproval: async () => ({ approved: true, targetMode: 'bypassPermissions' }) });
  assert.equal(outcome, 'proceed_once');
});

test('permission dialog uses full edit content when available', () => {
  const { toolName, input } = permissionDialogInput({
    toolUse: { name: 'Create', input: { file_path: '/b.txt', content: 'hi' } },
    details: { type: 'create', filePath: '/b.txt', content: 'hi' },
  });
  assert.equal(toolName, 'Write');
  assert.deepEqual(input, { file_path: '/b.txt', content: 'hi' });
});

test('ask-user questions and answers round-trip', () => {
  const questions = [
    { index: 1, topic: 'Favorite-color', question: 'What is your favorite color?', options: ['red', 'blue'] },
    { index: 2, topic: 'Size', question: 'Which sizes?', options: ['S', 'M'] },
  ];
  assert.deepEqual(toDialogQuestions(questions)[0], {
    question: 'What is your favorite color?',
    header: 'Favorite color',
    options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }],
    multiSelect: false,
  });
  assert.deepEqual(toAskUserResult(questions, { 'What is your favorite color?': 'blue', 'Which sizes?': ['S', 'M'] }), {
    answers: [
      { index: 1, question: 'What is your favorite color?', answer: 'blue' },
      { index: 2, question: 'Which sizes?', answer: 'S, M' },
    ],
  });
  assert.deepEqual(toAskUserResult(questions, null), { cancelled: true, answers: [] });
  assert.deepEqual(toAskUserResult(questions, {}), { cancelled: true, answers: [] });
});

test('CC GUI autonomy modes map to the CLI levels and back; Spec is independent', () => {
  const cases = [
    ['default', { interactionMode: 'auto', autonomyLevel: 'off' }, { interactionMode: 'auto', autonomyLevel: 'off' }],
    ['acceptEdits', { interactionMode: 'auto', autonomyLevel: 'low' }, { interactionMode: 'auto', autonomyLevel: 'low' }],
    ['auto', { interactionMode: 'auto', autonomyLevel: 'medium' }, { interactionMode: 'auto', autonomyLevel: 'medium' }],
    ['bypassPermissions', { interactionMode: 'auto', autonomyLevel: 'high' }, { interactionMode: 'auto', autonomyLevel: 'high' }],
  ];
  for (const [mode, expected, settings] of cases) {
    assert.deepEqual(permissionModeToDroid(mode), expected, mode);
    assert.equal(droidToPermissionMode(settings), mode, mode);
  }
  // Legacy `plan` still means "enter Spec", but keeps the current autonomy level.
  assert.deepEqual(permissionModeToDroid('plan'), { interactionMode: 'spec', autonomyLevel: null });
  // Spec never changes the reported autonomy level.
  assert.equal(droidToPermissionMode({ interactionMode: 'spec', autonomyLevel: 'low' }), 'acceptEdits');
  assert.equal(droidToPermissionMode({ interactionMode: 'spec', autonomyLevel: 'high' }), 'bypassPermissions');
  assert.deepEqual(permissionModeToDroid('autoEdit'), { interactionMode: 'auto', autonomyLevel: 'low' });
  assert.deepEqual(permissionModeToDroid(undefined), { interactionMode: 'auto', autonomyLevel: 'off' });
});
