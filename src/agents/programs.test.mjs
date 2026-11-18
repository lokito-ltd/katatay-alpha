import { expect, it, vi } from 'vitest';

// The public action and the bundled program that must handle it. If both
// maps change in the same wrong way, a round trip alone still looks correct.
const common = [
  ['defaults', 'defaults.mjs'], ['install', 'install.mjs'], ['check', 'check.mjs'],
  ['pre-tool', 'hooks/pre-tool.mjs'], ['user-prompt', 'hooks/user-prompt.mjs'], ['turn-end', 'hooks/turn-end.mjs'],
];

it.each([
  ['claude', [...common, ['post-tool', 'hooks/post-tool.mjs']]],
  ['codex', common],
])('resolves every %s action and emits the matching portable command for its program', async (adapter, cases) => {
  vi.resetModules();
  const { agentScript, agentCommand } = await import('./programs.mjs');
  for (const [action, filename] of cases) {
    const file = `src/agents/${adapter}/${filename}`;
    expect(agentScript(adapter, action)).toBe(file);
    expect(agentCommand(file)).toBe(`ktty agent ${adapter} ${action}`);
  }
  expect(agentScript(adapter, '')).toBeUndefined();
  expect(agentScript('', 'check')).toBeUndefined();
  expect(agentScript('codex', 'post-tool')).toBeUndefined();
});
