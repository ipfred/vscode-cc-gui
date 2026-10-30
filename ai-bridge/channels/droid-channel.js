/**
 * Droid channel command handler.
 *
 * Chat turns run on a warm `DroidSession` from @factory/droid-sdk (one
 * `droid exec --input-format stream-jsonrpc` child per session), driven by
 * services/droid/persistent-droid-service.js. In one-shot channel-manager
 * mode the runtime is torn down after the command so the process can exit.
 */
import {
  sendMessagePersistent,
  getContextUsagePersistent,
  getUsagePersistent,
  listCommandsPersistent,
  runCommandPersistent,
  shutdownPersistentRuntimes,
} from '../services/droid/persistent-droid-service.js';
import { listModels } from '../services/droid/models-service.js';
import {
  listSessions,
  getSessionMessages,
  deleteSession,
} from '../services/droid/history-service.js';

const ONE_SHOT_RUNTIME_COMMANDS = new Set([
  'send', 'listCommands', 'compact', 'context', 'rewindInfo', 'rewind', 'command',
]);

/**
 * Execute a Droid command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 * @param {{persistent?: boolean}} [options] daemon mode keeps runtimes warm
 */
export async function handleDroidCommand(command, args, stdinData, options = {}) {
  const payload = stdinData || {};
  try {
    switch (command) {
      case 'send':
        await sendMessagePersistent(payload);
        break;

      case 'listModels':
        await listModels(payload);
        break;

      case 'listCommands':
        await listCommandsPersistent(payload);
        break;

      case 'getContextUsage':
        await getContextUsagePersistent(payload);
        break;

      case 'getUsage':
        await getUsagePersistent(payload);
        break;

      case 'compact':
        await runCommandPersistent({ ...payload, command: 'compact' });
        break;

      case 'context':
        await runCommandPersistent({ ...payload, command: 'context' });
        break;

      case 'rewindInfo':
        await runCommandPersistent({ ...payload, command: 'rewind', args: '' });
        break;

      case 'rewind':
        await runCommandPersistent({ ...payload, command: 'rewind', args: String(payload.index ?? payload.args ?? '') });
        break;

      case 'command':
        await runCommandPersistent(payload);
        break;

      case 'listSessions': {
        const cwd = payload.cwd || args[0] || process.cwd();
        console.log(JSON.stringify(listSessions(cwd)));
        break;
      }

      case 'getSessionMessages': {
        const sessionId = payload.sessionId || args[0] || '';
        const cwd = payload.cwd || args[1] || process.cwd();
        if (!sessionId) throw new Error('getSessionMessages requires sessionId');
        console.log(JSON.stringify({ success: true, messages: getSessionMessages(sessionId, cwd) }));
        break;
      }

      case 'deleteSession': {
        const sessionId = payload.sessionId || args[0] || '';
        const cwd = payload.cwd || args[1] || process.cwd();
        if (!sessionId) throw new Error('deleteSession requires sessionId');
        console.log(JSON.stringify(deleteSession(sessionId, cwd)));
        break;
      }

      default:
        throw new Error(`Unknown Droid command: ${command}`);
    }
  } finally {
    if (!options.persistent && ONE_SHOT_RUNTIME_COMMANDS.has(command)) {
      await shutdownPersistentRuntimes();
    }
  }
}

export function getDroidCommandList() {
  return [
    'send', 'listModels', 'listCommands', 'listSessions', 'getSessionMessages', 'deleteSession',
    'getContextUsage', 'getUsage', 'compact', 'context', 'rewindInfo', 'rewind', 'command',
  ];
}
