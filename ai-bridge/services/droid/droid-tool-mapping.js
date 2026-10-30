/**
 * Droid tool name/input → Claude-shaped tool_use mapping.
 *
 * The webview's tool cards, diff views and file-change tracking key on
 * Claude tool names (Bash, Write, Edit, Read, Grep, Glob, TodoWrite, Task,
 * AskUserQuestion, ExitPlanMode) and their snake_case input fields. Droid uses
 * its own names (Execute, Create, Edit with old_str/new_str, ...), so both the
 * live stream and the history reader run every tool_use through this mapper.
 */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function definedOnly(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

const TODO_LINE = /^\s*\d+[.)]\s*\[(pending|in_progress|completed|cancelled)\]\s*(.+?)\s*$/i;

/**
 * Parse Droid's `TodoWrite` text ("1. [in_progress] Read a.txt") into the
 * Claude `{todos:[{content,status,activeForm}]}` array shape.
 */
export function parseDroidTodos(todos) {
  if (Array.isArray(todos)) return todos;
  if (typeof todos !== 'string') return [];
  const items = [];
  for (const line of todos.split(/\r?\n/)) {
    const match = TODO_LINE.exec(line);
    if (!match) continue;
    const status = match[1].toLowerCase() === 'cancelled' ? 'completed' : match[1].toLowerCase();
    items.push({ content: match[2], status, activeForm: match[2] });
  }
  return items;
}

/**
 * Parse Droid's AskUser questionnaire text into AskUserQuestion questions.
 * Format: "1. [question] Text\n[topic] Topic\n[option] A\n[option] B".
 */
export function parseDroidQuestionnaire(questionnaire) {
  if (typeof questionnaire !== 'string') return [];
  const questions = [];
  let current = null;
  for (const raw of questionnaire.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const q = /^\d+[.)]\s*\[question\]\s*(.*)$/i.exec(line);
    if (q) {
      current = { question: q[1].replace(/\s*\(multi\)\s*$/i, ''), header: '', options: [], multiSelect: /\(multi\)\s*$/i.test(q[1]) };
      questions.push(current);
      continue;
    }
    if (!current) continue;
    const topic = /^\[topic\]\s*(.*)$/i.exec(line);
    if (topic) {
      current.header = topic[1];
      continue;
    }
    const option = /^\[option\]\s*(.*)$/i.exec(line);
    if (option) current.options.push({ label: option[1], description: '' });
  }
  return questions;
}

/**
 * Map one Droid tool call to the Claude tool name/input the UI understands.
 * Unknown tools (MCP, Skill, custom droids, ...) pass through unchanged.
 * @param {string} name
 * @param {object} input
 * @returns {{name: string, input: object}}
 */
export function mapDroidToolUse(name, input) {
  const args = asObject(input);
  switch (name) {
    case 'Execute':
      return {
        name: 'Bash',
        input: definedOnly({
          command: args.command,
          description: args.summary,
          timeout: typeof args.timeout === 'number' ? args.timeout * 1000 : undefined,
          run_in_background: args.fireAndForget === true ? true : undefined,
          riskLevel: args.riskLevel,
        }),
      };
    case 'Create':
      return { name: 'Write', input: definedOnly({ file_path: args.file_path, content: args.content ?? '' }) };
    case 'Edit':
      return {
        name: 'Edit',
        input: definedOnly({
          file_path: args.file_path,
          old_string: args.old_str ?? args.old_string ?? '',
          new_string: args.new_str ?? args.new_string ?? '',
          replace_all: args.change_all === true ? true : undefined,
        }),
      };
    case 'ApplyPatch':
      return {
        name: 'apply_patch',
        input: { input: args.input ?? args.patch ?? args.content ?? '' },
      };
    case 'Read':
      return { name: 'Read', input: definedOnly({ file_path: args.file_path, offset: args.offset, limit: args.limit }) };
    case 'Grep':
      return {
        name: 'Grep',
        input: definedOnly({
          pattern: args.pattern,
          path: args.path,
          glob: args.glob_pattern,
          output_mode: args.output_mode,
          type: args.type,
          '-i': args.case_insensitive === true ? true : undefined,
          '-n': args.line_numbers === true ? true : undefined,
          '-A': args.context_after,
          '-B': args.context_before,
          '-C': args.context,
          head_limit: args.head_limit,
          multiline: args.multiline === true ? true : undefined,
        }),
      };
    case 'Glob': {
      const patterns = Array.isArray(args.patterns) ? args.patterns.join(', ') : args.patterns;
      return { name: 'Glob', input: definedOnly({ pattern: patterns ?? args.pattern, path: args.folder ?? args.path }) };
    }
    case 'LS':
      return { name: 'LS', input: definedOnly({ path: args.directory_path ?? args.path, ignore: args.ignorePatterns }) };
    case 'TodoWrite':
      return { name: 'TodoWrite', input: { todos: parseDroidTodos(args.todos) } };
    case 'Task':
      return {
        name: 'Task',
        input: definedOnly({
          description: args.description,
          prompt: args.prompt,
          subagent_type: args.subagent_type,
        }),
      };
    case 'AskUser':
      return { name: 'AskUserQuestion', input: { questions: parseDroidQuestionnaire(args.questionnaire) } };
    case 'ExitSpecMode':
      return { name: 'ExitPlanMode', input: definedOnly({ plan: args.plan ?? args.spec ?? '' }) };
    case 'FetchUrl':
      return { name: 'WebFetch', input: definedOnly({ url: args.url, prompt: args.prompt }) };
    case 'WebSearch':
      return { name: 'WebSearch', input: definedOnly({ query: args.query }) };
    default:
      return { name: name || 'tool', input: args };
  }
}

/**
 * Flatten a Droid tool result into the string the UI renders. Edit/Create
 * results are UI JSON ({success, diffLines,...}); prefer the model-facing text
 * when the CLI provides one.
 */
export function stringifyDroidToolResult(content, modelContent) {
  if (typeof modelContent === 'string' && modelContent) return modelContent;
  if (content == null) return '';
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"success"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.file_path === 'string') {
          if (parsed.success === false) return parsed.error ? String(parsed.error) : `Failed to modify ${parsed.file_path}`;
          const changed = typeof parsed.linesAdded === 'number' || typeof parsed.linesRemoved === 'number'
            ? ` (+${parsed.linesAdded ?? 0} -${parsed.linesRemoved ?? 0})`
            : '';
          return `Updated ${parsed.file_path}${changed}`;
        }
      } catch {
        // not JSON — keep the raw text
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
