import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, whenFileIsRemoved } from '../support/project.mjs';
import { thenContains, thenLengthIs, thenValuesEqual } from '../support/assertions.mjs';
import { whenAgentRuns } from '../support/agents.mjs';

// A project set up as the Claude adapter proposes: its hook registration, the
// workflow's instructions, and Claude Code's plans in the rulebook's folder.
// The check finds nothing wrong with it.
function givenAClaudeSetup(folder) {
  const defaults = whenAgentRuns(folder, 'claude', 'defaults', { version: 1 });
  thenItExits(defaults, 0);
  const settings = { ...JSON.parse(JSON.parse(defaults.stdout).registration.text), plansDirectory: 'plans' };
  givenFileContents(folder, '.claude/settings.json', JSON.stringify(settings, null, 2));
  givenFileContents(folder, '.claude/rules/workflow.md', '# The workflow\n');
  return settings;
}
const givenSettings = (folder, file, settings) => givenFileContents(folder, file, JSON.stringify(settings, null, 2));
const whenClaudeIsChecked = (folder, acknowledged = []) =>
  whenAgentRuns(folder, 'claude', 'check', { version: 1, root: folder.cwd, extraHooks: { acknowledged } });
function thenWarnings(run) {
  thenItExits(run, 0);
  return JSON.parse(run.stdout).warnings;
}
const hook = (command, matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] });

it('A workflow hook that is missing, points at another script, covers fewer tools, or has a Stop timeout too short for the suite is reported with what stops working. [AC0071.1]', () => {
  const folder = givenAWorkingBranch();
  const settings = givenAClaudeSetup(folder);
  thenValuesEqual(thenWarnings(whenClaudeIsChecked(folder)), []);
  delete settings.hooks.UserPromptSubmit;
  settings.hooks.PostToolUse = [hook('node elsewhere/approve.mjs', 'ExitPlanMode')];
  settings.hooks.PreToolUse[0].matcher = 'Edit|Write';
  settings.hooks.Stop[0].hooks[0].timeout = 60;
  givenSettings(folder, '.claude/settings.json', settings);

  const run = whenClaudeIsChecked(folder);

  const warnings = thenWarnings(run);
  thenLengthIs(warnings, 5);
  thenContains(warnings.join('\n'), 'but not for NotebookEdit, Bash, ExitPlanMode — edits are no longer held until a plan has been approved');
  thenContains(warnings.join('\n'), "the operator's `record` and `reset` are no longer heard, and no phase is injected.");
  thenContains(warnings.join('\n'), 'PostToolUse does not run');
  thenContains(warnings.join('\n'), '— approving a plan records nothing, so no change can leave the open phase.');
  thenContains(warnings.join('\n'), '.claude/settings.json registers an extra PostToolUse hook on ExitPlanMode: `node elsewhere/approve.mjs`.');
  thenContains(warnings.join('\n'), 'with a 60-second timeout; it runs the whole suite and mutation testing, and needs at least 900.');
});

it('An extra hook in any settings file is reported with the file that registers it, and called out when it can answer the plan dialog, unless the operator acknowledged it. [AC0071.2]', () => {
  const folder = givenAWorkingBranch();
  givenAClaudeSetup(folder);
  givenSettings(folder, '.claude/settings.local.json', { hooks: { PermissionRequest: [hook('approve-all', 'ExitPlanMode')] } });
  givenSettings(folder, join('..', 'home', '.claude', 'settings.json'), { hooks: { Notification: [hook('notify', '')] } });

  const reported = whenClaudeIsChecked(folder);
  thenValuesEqual(thenWarnings(reported), [
    "~/.claude/settings.json registers an extra Notification hook: `notify`. It runs outside the workflow's gate. If it is the operator's, they list it under "
      + "extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.",
    '.claude/settings.local.json registers an extra PermissionRequest hook on ExitPlanMode: `approve-all`. It runs for ExitPlanMode and can answer the plan dialog, '
      + "so it could approve a plan on the operator's behalf. If it is the operator's, they list it under extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.",
  ]);

  const acknowledged = whenClaudeIsChecked(folder, [
    { event: 'PermissionRequest', matcher: 'ExitPlanMode', command: 'approve-all' },
    { event: 'Notification', matcher: '', command: 'notify' },
  ]);
  thenValuesEqual(thenWarnings(acknowledged), []);
});

it("A hook declared in a skill's or an agent's frontmatter is reported. [AC0071.3]", () => {
  const folder = givenAWorkingBranch();
  givenAClaudeSetup(folder);
  givenFileContents(folder, '.claude/skills/tidy/SKILL.md',
    '---\nname: tidy\ndescription: Tidies.\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: skill-stop\n---\nTidy up.\n');
  givenFileContents(folder, '.claude/agents/helper.md',
    '---\nname: helper\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: agent-hook\n---\nHelp.\n');

  const run = whenClaudeIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    ".claude/skills/tidy/SKILL.md registers an extra Stop hook: `skill-stop`. It runs outside the workflow's gate. If it is the operator's, they list it under "
      + "extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.",
    ".claude/agents/helper.md registers an extra PreToolUse hook on Bash: `agent-hook`. It runs outside the workflow's gate. If it is the operator's, they list it under "
      + "extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.",
  ]);
});

it('disableAllHooks and allowManagedHooksOnly are reported. [AC0071.4]', () => {
  const folder = givenAWorkingBranch();
  givenAClaudeSetup(folder);
  givenSettings(folder, '.claude/settings.local.json', { disableAllHooks: true, allowManagedHooksOnly: true });

  const run = whenClaudeIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    '.claude/settings.local.json sets disableAllHooks, which turns off every hook in this repository: the phase gate, the path protection, the approval recorder and the turn-end verify.',
    ".claude/settings.local.json sets allowManagedHooksOnly, so Claude Code runs no hook from this repository's settings.",
  ]);
});

it("A Claude plansDirectory that differs from the rulebook's plans folder is reported. [AC0071.5]", () => {
  const folder = givenAWorkingBranch();
  const settings = givenAClaudeSetup(folder);
  givenSettings(folder, '.claude/settings.json', { ...settings, plansDirectory: './elsewhere' });

  const run = whenClaudeIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    "Claude Code writes plans to elsewhere, and the rulebook's plans.dir is plans. Only files directly in plans.dir are written without a plan, "
      + 'so plan mode cannot write its plan before approval and shows a dialog with no plan in it. Set plansDirectory to match, or the operator changes plans.dir in .katatay/rulebook.json.',
  ]);
});

it('An env entry such as CI, PATH or NODE_OPTIONS is reported with what it changes. [AC0071.6]', () => {
  const folder = givenAWorkingBranch();
  givenAClaudeSetup(folder);
  givenSettings(folder, '.claude/settings.local.json', { env: { CI: 'true', PATH: '/bin', NODE_OPTIONS: '--require hook.js', EDITOR: 'vi' } });

  const run = whenClaudeIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    '.claude/settings.local.json sets CI in env: set to `true`, the tools take the session for a CI job, where `req:guard` no longer fails on a reworded or retired requirement '
      + 'and prints it for a reviewer instead, and verify skips every check whose rulebook entry says `skipInCi`, mutation included.',
    '.claude/settings.local.json sets PATH in env: the hooks find `git` and `node` through it, so each can be replaced by another program.',
    '.claude/settings.local.json sets NODE_OPTIONS in env: node loads whatever it names into every hook and every check before they run.',
  ]);
});

it('A missing instructions file is reported. [AC0071.7]', () => {
  const folder = givenAWorkingBranch();
  givenAClaudeSetup(folder);
  whenFileIsRemoved(folder, '.claude/rules/workflow.md');

  const run = whenClaudeIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    ".claude/rules/workflow.md is missing, so Claude Code starts each session without the workflow's instructions. Install them with the Claude adapter's install command, as init does.",
  ]);
});
