import { expect, it, vi } from 'vitest';
import { registrationProblems, stopTimeout as claudeTimeout } from './claude/registration.mjs';
import { settingsDifferences } from './claude/settings.mjs';
import { mergedHooks, stopTimeout as codexTimeout } from './codex/registration.mjs';
import { setupWarnings } from './codex/setup.mjs';
import { payload } from '../../tests/fixtures/codex/payloads.mjs';
import { proposal as claudeProposal } from './claude/proposal.mjs';
import { proposal as codexProposal } from './codex/proposal.mjs';
import { proposal as cursorProposal } from './cursor/proposal.mjs';
import { stopTimeout as cursorTimeout } from './cursor/registration.mjs';
import { setupWarnings as cursorWarnings } from './cursor/setup.mjs';
import { agentCommand } from './programs.mjs';

vi.mock('../distribution.mjs', () => ({ packaged: true }));

it('recognizes the installed Claude commands, including a customized Stop timeout', () => {
  const { commands, registration } = claudeProposal('/consumer');
  expect(commands).toEqual({ check: 'ktty agent claude check', install: 'ktty agent claude install' });
  const settings = JSON.parse(registration.text);
  const hook = settings.hooks.Stop[0].hooks[0];
  hook.timeout = 1245;
  const differences = () => settingsDifferences([{ scope: 'project', file: registration.file, settings }]);
  expect(registrationProblems(settings)).toEqual([]);
  expect(differences()).toEqual([]);
  expect(claudeTimeout(JSON.stringify(settings))).toBe(1245);
  hook.command = 'echo ktty agent claude turn-end';
  expect(registrationProblems(settings).join('\n')).toContain('Stop does not run');
  expect(differences().join('\n')).toContain(hook.command);
  expect(claudeTimeout(JSON.stringify(settings))).toBe(60);
});

it('matches the exact Codex command when merging hooks and reading the registered timeout', () => {
  const { commands, registration } = codexProposal('/consumer');
  expect(commands).toEqual({ check: 'ktty agent codex check', install: 'ktty agent codex install' });
  const settings = JSON.parse(registration.text);
  expect(settings.description).toContain('Katatay');
  settings.description = 'Operator description';
  const hook = settings.hooks.Stop[0].hooks[0];
  hook.timeout = 1200;
  expect(codexTimeout(JSON.stringify(settings))).toBe(1200);
  expect(JSON.parse(mergedHooks(JSON.stringify(settings), '/consumer'))).toEqual(settings);
  hook.command = 'echo ktty agent codex turn-end';
  expect(codexTimeout(JSON.stringify(settings))).toBe(600);
  const stop = JSON.parse(mergedHooks(JSON.stringify(settings), '/consumer')).hooks.Stop;
  expect(stop.map(group => group.hooks[0].command)).toEqual([hook.command, 'ktty agent codex turn-end']);
});

it('accepts the three project hooks in a Codex listing and reports a substituted command', () => {
  const root = '/consumer';
  const paths = { home: '/operator', repo: root };
  const hooksList = payload('app-server-hooks-list', {}, paths);
  const config = payload('app-server-config-read', {}, paths);
  const entry = hooksList.data[0];
  entry.hooks = [
    ['preToolUse', 'apply_patch|Bash', 'pre-tool'],
    ['userPromptSubmit', null, 'user-prompt'],
    ['stop', null, 'turn-end'],
  ].map(([eventName, matcher, action]) => ({
    ...entry.hooks[0], eventName, matcher, command: `ktty agent codex ${action}`, timeoutSec: 900, additionalContextLimit: 0,
  }));
  const warnings = () => setupWarnings({ root, hooksList, config, extraHooks: { acknowledged: [] }, instructions: true });
  expect(warnings()).toEqual([]);
  entry.hooks[0].command = 'ktty agent claude pre-tool';
  expect(warnings().join('\n')).toContain('does not register the workflow\'s PreToolUse hook');
  expect(warnings().join('\n')).toContain('ktty agent claude pre-tool');
});

it('refuses to emit an adapter command for an unknown program', () => {
  expect(() => agentCommand('src/agents/claude/other.mjs')).toThrow('Unknown agent script');
});

it('names the installed Cursor commands, and accepts exactly those in the check and the stop timeout', () => {
  const { commands, registration } = cursorProposal('/consumer');
  expect(commands).toEqual({ check: 'ktty agent cursor check', install: 'ktty agent cursor install' });
  const file = JSON.parse(registration.text);
  expect(file.hooks.preToolUse[0].command).toBe('ktty agent cursor pre-tool');
  expect(file.hooks.beforeSubmitPrompt[0].command).toBe('ktty agent cursor user-prompt');
  expect(file.hooks.stop[0].command).toBe('ktty agent cursor turn-end');
  expect(cursorTimeout(registration.text)).toBe(900);
  expect(cursorWarnings({ files: { '.cursor/hooks.json': registration.text }, extraHooks: { acknowledged: [] }, instructions: true })).toEqual([]);
  file.hooks.stop[0].command = 'echo ktty agent cursor turn-end';
  expect(cursorWarnings({ files: { '.cursor/hooks.json': JSON.stringify(file) }, extraHooks: { acknowledged: [] }, instructions: true }).join('\n'))
    .toContain('does not register the workflow\'s stop hook');
});
