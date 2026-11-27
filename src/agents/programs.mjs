import { packaged } from '../distribution.mjs';

// Both the installed command dispatcher and the adapters use these names.
// The user supplies an action name, never a path to execute.
const scripts = new Map();
for (const adapter of ['claude', 'codex', 'cursor']) {
  const base = `src/agents/${adapter}`;
  for (const action of ['defaults', 'install', 'check']) {
    scripts.set(`${adapter} ${action}`, `${base}/${action}.mjs`);
  }
  const hooks = ['pre-tool', 'user-prompt', 'turn-end'];
  if (adapter === 'claude') hooks.push('post-tool');
  for (const hook of hooks) scripts.set(`${adapter} ${hook}`, `${base}/hooks/${hook}.mjs`);
}

export const agentScript = (adapter, action) => scripts.get(`${adapter} ${action}`);
export const agentActions = () => scripts.keys();
const commands = new Map([...scripts].map(([name, script]) => [script, `ktty agent ${name}`]));

export function agentCommand(script) {
  const command = commands.get(script);
  if (!command) throw new Error(`Unknown agent script: ${script}`);
  return command;
}

export function runsScript(command, script) {
  if (typeof command !== 'string') return false;
  return packaged ? command === agentCommand(script) : command.includes(script);
}
