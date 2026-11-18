import { it } from 'vitest';
import { thenHookReplies, thenItExits, whenKttyRuns } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, givenRulebookChanges, whenStateIsShown, whenTurnEnds } from '../support/project.mjs';
import { thenContains, thenTextMatches, thenValuesEqual } from '../support/assertions.mjs';
import { givenAConvergingChange } from '../support/checks.mjs';
import { whenPromptRuns } from '../support/history.mjs';
import { codexWorkflowHooks, givenACodexAppServer, whenAgentRuns } from '../support/agents.mjs';

const checkRequest = folder => ({ version: 1, root: folder.cwd, extraHooks: { acknowledged: [] } });
const whenCodexIsChecked = (folder, env = {}) => whenAgentRuns(folder, 'codex', 'check', checkRequest(folder), { env });
function thenWarnings(run) {
  thenItExits(run, 0);
  return JSON.parse(run.stdout).warnings;
}
// A Codex project the check finds nothing wrong with: its instructions, and
// the workflow's three hooks registered, enabled and trusted.
function givenACodexSetup(folder) {
  givenFileContents(folder, 'AGENTS.md', '# The workflow\n');
  const hooks = codexWorkflowHooks(folder);
  givenACodexAppServer(folder, hooks);
  return hooks;
}
// Agent checks the rulebook names, in this order. Each prints its warnings.
function givenAgentChecks(folder, checks) {
  const answering = warnings => `printf '%s\\n' '${JSON.stringify({ version: 1, warnings })}'`;
  givenRulebookChanges(folder, book => {
    book.agent.adapters = Object.fromEntries(Object.entries(checks).map(([name, check]) =>
      [name, { checkCommand: typeof check === 'string' ? check : answering(check) }]));
  });
}

it('AGENTS.md files over what Codex reads are reported with their size, the limit and the overflow. [AC0072.1]', () => {
  const folder = givenAWorkingBranch();
  givenACodexSetup(folder);
  givenFileContents(folder, 'AGENTS.md', 'x'.repeat(30000));
  givenFileContents(folder, 'docs/AGENTS.md', 'y'.repeat(5000));

  const run = whenCodexIsChecked(folder);

  thenValuesEqual(thenWarnings(run), [
    'The AGENTS.md files Codex loads together in `docs/` (`AGENTS.md`, `docs/AGENTS.md`) come to 35000 bytes, over Codex\'s `project_doc_max_bytes` of 32768. '
      + 'Codex reads only the first 32768 bytes, so it misses the last 2232 bytes of its instructions, the workflow\'s included. '
      + 'Raise `project_doc_max_bytes` in `~/.codex/config.toml` to at least 35000, then restart Codex.',
  ]);
});

it('A Codex workflow hook that is missing, disabled or untrusted is reported. [AC0072.2]', () => {
  const folder = givenAWorkingBranch();
  const [preTool, userPrompt, stop] = givenACodexSetup(folder);
  thenValuesEqual(thenWarnings(whenCodexIsChecked(folder)), []);
  givenACodexAppServer(folder, [{ ...preTool, trustStatus: 'untrusted' }, { ...stop, enabled: false }]);

  const run = whenCodexIsChecked(folder);

  const warnings = thenWarnings(run);
  thenValuesEqual(warnings.length, 3);
  thenTextMatches(warnings[0], /^the workflow's PreToolUse hook \(.+\) has not been trusted, so Codex skips it\. The operator trusts it in `\/hooks`\./);
  thenTextMatches(warnings[1], /^\.codex\/hooks\.json does not register the workflow's UserPromptSubmit hook \(.+\), so approving a plan records nothing/);
  thenTextMatches(warnings[2], /^the workflow's Stop hook \(.+\) is disabled in Codex's `\/hooks`, so the test freeze is off/);
  thenValuesEqual(userPrompt.eventName, 'userPromptSubmit');
});

it('An extra Stop or prompt hook in Codex is reported as able to send the approval. [AC0072.3]', () => {
  const folder = givenAWorkingBranch();
  const hooks = givenACodexSetup(folder);
  const [, userPrompt, stop] = hooks;
  givenACodexAppServer(folder, [
    ...hooks,
    { ...stop, key: 'extra-stop', command: 'extra-stop' },
    { ...userPrompt, key: 'extra-prompt', command: 'extra-prompt' },
    { ...userPrompt, key: 'extra-start', eventName: 'sessionStart', command: 'extra-start' },
  ]);

  const run = whenCodexIsChecked(folder);

  const warnings = thenWarnings(run);
  const approval = 'Codex sends what it answers as a prompt, or alongside one, so it could send the plan approval text on the operator\'s behalf.';
  thenValuesEqual(warnings.length, 3);
  thenContains(warnings[0], 'registers an extra Stop hook: `extra-stop`. ' + approval);
  thenContains(warnings[1], 'registers an extra UserPromptSubmit hook: `extra-prompt`. ' + approval);
  thenContains(warnings[2], 'registers an extra SessionStart hook: `extra-start`. It runs outside the workflow\'s gate.');
});

it('A Codex that cannot be started gives two warnings, about its settings and its hooks, each saying nothing is known. [AC0072.4]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'AGENTS.md', '# The workflow\n');
  // A PATH with the ktty command and the system tools, and no codex on it.
  const noCodex = { PATH: [folder.env.PATH.split(':')[0], '/usr/bin', '/bin'].join(':') };

  const run = whenCodexIsChecked(folder, noCodex);

  thenValuesEqual(thenWarnings(run), [
    "Codex's settings could not be read (`codex` could not be started: spawn codex ENOENT), so whether it has hooks switched off is not known.",
    "Codex could not be asked about its hooks (`codex` could not be started: spawn codex ENOENT), so nothing is known about whether the workflow's hooks run.",
  ]);
});

it('With CI set to exactly true, the Codex check skips its live query but still checks the request. [AC0072.5]', () => {
  const folder = givenAWorkingBranch();
  givenACodexSetup(folder);
  givenACodexAppServer(folder, []);

  const skipped = whenCodexIsChecked(folder, { CI: 'true' });
  thenValuesEqual(thenWarnings(skipped), ['Codex live setup check skipped in CI.']);

  const refused = whenAgentRuns(folder, 'codex', 'check', { ...checkRequest(folder), version: 2 }, { env: { CI: 'true' } });
  thenItExits(refused, 2);

  const live = whenCodexIsChecked(folder, { CI: '1' });
  thenValuesEqual(thenWarnings(live).length, 3);
});

it("Checks run in the rulebook's order, a crashing check becomes one warning, and the next check still runs. [AC0072.6]", () => {
  const folder = givenAWorkingBranch();
  givenAgentChecks(folder, { zulu: ['zulu warns'], crash: 'echo boom >&2; exit 3', alpha: ['alpha warns'] });

  const run = whenStateIsShown(folder);

  thenItExits(run, 0);
  thenContains(run.stdout, [
    'WARNING    zulu: zulu warns',
    'WARNING    crash: the agent check (`echo boom >&2; exit 3`) gave no answer: it exited with 3. Nothing was concluded from it, so the agent\'s setup is unchecked.',
    'WARNING    alpha: alpha warns',
  ].join('\n'));
});

it("Each agent's named warnings appear in ktty state show, ktty state verify, every prompt and every verified turn end. [AC0072.7]", () => {
  const folder = givenAWorkingBranch();
  givenAgentChecks(folder, { claude: ['hooks are off'], codex: ['AGENTS.md is too long'] });

  const shown = whenStateIsShown(folder);
  thenContains(shown.stdout, 'WARNING    claude: hooks are off\nWARNING    codex: AGENTS.md is too long\n');

  const verified = whenKttyRuns(['state', 'verify'], { in: folder });
  thenItExits(verified, 0);
  thenContains(verified.stderr, 'state: WARNING — claude: hooks are off\nstate: WARNING — codex: AGENTS.md is too long\n');

  const prompt = whenPromptRuns(folder, 'hello');
  const said = thenHookReplies(prompt, 0).messages.map(message => message.text);
  thenContains(said, 'settings: claude: hooks are off Tell the operator.');
  thenContains(said, 'settings: codex: AGENTS.md is too long Tell the operator.');

  givenAConvergingChange(folder);
  for (const turn of ['first', 'next']) {
    const end = whenTurnEnds(folder);
    const text = thenHookReplies(end, 0).messages.map(message => message.code + ': ' + message.text).join('\n');
    thenContains(text, 'claude: hooks are off', turn);
    thenContains(text, 'codex: AGENTS.md is too long', turn);
  }
});
