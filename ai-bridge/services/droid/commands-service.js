/**
 * Droid slash-command catalog: custom commands (`listCommands`) plus
 * user-invocable skills (`listSkills`). Plugin builtins (/compact, /model, …)
 * are defined by the extension, which also routes them.
 */

/**
 * @param {{commands?: object[], skills?: object[]}} sources
 * @returns {{name: string, description: string, source: string}[]}
 */
export function buildDroidCommandList({ commands = [], skills = [] } = {}) {
  const merged = new Map();
  const add = (name, description, source) => {
    const clean = String(name || '').trim().replace(/^\//, '');
    if (!clean) return;
    const key = `/${clean}`;
    if (merged.has(key)) return;
    merged.set(key, { name: key, description: String(description || '').split('\n')[0].slice(0, 200), source });
  };
  for (const command of Array.isArray(commands) ? commands : []) {
    if (!command) continue;
    add(command.name, command.description, 'droid-command');
  }
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || skill.enabled === false || skill.userInvocable === false) continue;
    add(skill.name, skill.description, 'droid-skill');
  }
  return [...merged.values()];
}
