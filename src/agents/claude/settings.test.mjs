/**
 * The settings check, against settings written here and folders built here.
 *
 * Never against the operator's real files. What `~/.claude/settings.json`
 * holds differs from one machine to the next, and a case that read it would
 * pass or fail by where it ran. The machine cases under `machine/` spawn the
 * commands with a home folder of the fixture's own, for the same reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  frontmatterHooks, instructionsWarning, plansDirectory, plansFolderWarning, registrationWarnings, settingsDifferences, settingsSources, settingsWarnings,
} from './settings.mjs';
import { writeConfig } from '../../../tests/fixtures/workflow/adapter.mjs';

/** What the repository registers, as `.claude/settings.json` holds it. */
const project = () => ({
  hooks: {
    PreToolUse: [
      { matcher: 'Edit|Write|NotebookEdit|Bash|ExitPlanMode', hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/pre-tool.mjs' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/user-prompt.mjs' }] }],
    PostToolUse: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/post-tool.mjs' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/turn-end.mjs', timeout: 900 }] }],
  },
});

const hook = (command) => ({ type: 'command', command });
const user = (settings) => ({ file: '~/.claude/settings.json', scope: 'user', settings });
const differences = (sources, options = {}) => settingsDifferences(sources, options);

describe('settings that match what the repository expects', () => {
  it('says nothing about the project settings as they are registered', () => {
    expect(differences([{ file: '.claude/settings.json', scope: 'project', settings: project() }])).toEqual([]);
  });

  it('says nothing when there are no settings files at all', () => {
    expect(differences([])).toEqual([]);
  });

  it('says nothing about keys that change nothing here', () => {
    expect(differences([user({ outputStyle: 'Concise', permissions: { allow: ['Bash(npm test)'] }, env: { EDITOR: 'vim' } })])).toEqual([]);
  });

  it('is not thrown by settings of the wrong shape', () => {
    for (const settings of [null, 'text', [], { hooks: 'none' }, { hooks: { Stop: 'x' } }, { hooks: { Stop: [null, { hooks: 'x' }] } }, { env: null }]) {
      expect(differences([user(settings)]), JSON.stringify(settings)).toEqual([]);
    }
  });
});

describe('an extra hook', () => {
  it('is reported with its event, matcher, command and the file that registers it', () => {
    const [said, ...rest] = differences([user({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook('rtk hook claude')] }] } })]);
    expect(rest).toEqual([]);
    expect(said).toContain('~/.claude/settings.json registers an extra PreToolUse hook on Bash: `rtk hook claude`.');
    expect(said).toContain('outside the workflow\'s gate');
    expect(said).toContain('extraHooks.acknowledged in this adapter\'s agent.adapters entry in .katatay/rulebook.json');
  });

  // The plan dialog is a permission dialog, and these two events can answer
  // one. That is how a session could approve its own plan.
  it('is called out when it can answer the plan dialog', () => {
    for (const [event, matcher] of [
      ['PreToolUse', 'ExitPlanMode'], ['PreToolUse', ''], ['PreToolUse', '*'], ['PreToolUse', 'Exit.*'],
      ['PreToolUse', 'Bash,ExitPlanMode'], ['PermissionRequest', 'ExitPlanMode'], ['PermissionRequest', undefined],
    ]) {
      const [said] = differences([user({ hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [hook('approve.sh')] }] } })]);
      expect(said, `${event} ${matcher}`).toContain('can answer the plan dialog');
      expect(said, `${event} ${matcher}`).toContain('approve a plan on the operator\'s behalf');
    }
  });

  it('is not called that when it runs for other tools, or on an event that decides nothing', () => {
    for (const [event, matcher] of [['PreToolUse', 'Bash'], ['PreToolUse', 'Edit|Write'], ['PostToolUse', 'ExitPlanMode'], ['Stop', '']]) {
      const [said] = differences([user({ hooks: { [event]: [{ matcher, hooks: [hook('log.sh')] }] } })]);
      expect(said, `${event} ${matcher}`).not.toContain('plan dialog');
    }
  });

  it('is reported from every kind of file, each named', () => {
    const extra = { hooks: { Stop: [{ hooks: [hook('x.sh')] }] } };
    const said = differences([
      { file: '/etc/claude-code/managed-settings.json', scope: 'managed', settings: extra },
      user(extra),
      { file: '.claude/settings.local.json', scope: 'local', settings: extra },
      { file: '.claude/skills/review/SKILL.md', scope: 'skill', settings: extra },
    ]);
    expect(said.map((line) => line.split(' registers ')[0])).toEqual([
      '/etc/claude-code/managed-settings.json', '~/.claude/settings.json', '.claude/settings.local.json', '.claude/skills/review/SKILL.md',
    ]);
  });

  it('is reported in the project settings too, beside the hooks that belong there', () => {
    const settings = project();
    settings.hooks.PreToolUse.push({ matcher: 'ExitPlanMode', hooks: [hook('node approve.mjs')] });
    const said = differences([{ file: '.claude/settings.json', scope: 'project', settings }]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('`node approve.mjs`');
  });

  // The workflow's own hooks are expected in the project's file and nowhere
  // else, on the event they are registered for.
  it('is reported when a workflow hook is registered somewhere it does not belong', () => {
    expect(differences([user({ hooks: { Stop: [{ hooks: [hook('node src/agents/claude/hooks/turn-end.mjs')] }] } })])).toHaveLength(1);
    expect(differences([{
      file: '.claude/settings.json', scope: 'project', settings: { hooks: { PreToolUse: [{ hooks: [hook('node src/agents/claude/hooks/post-tool.mjs')] }] } },
    }])).toHaveLength(1);
  });

  // `registrationProblems` matches on the path appearing anywhere. Here that
  // would let another program pass by mentioning one of ours.
  it('is not passed off as expected by naming a workflow hook in its command', () => {
    const settings = { hooks: { Stop: [{ hooks: [hook('node evil.mjs # src/agents/claude/hooks/turn-end.mjs')] }] } };
    expect(differences([{ file: '.claude/settings.json', scope: 'project', settings }])).toHaveLength(1);
  });

  it('names a hook that is not a command by what it calls', () => {
    const said = differences([user({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.test/hook' }, { type: 'prompt', prompt: 'Is it done?' }, { type: 'agent' }] }] } })]);
    expect(said.map((line) => /`(.*)`/.exec(line)[1])).toEqual(['https://example.test/hook', 'Is it done?', 'type agent']);
  });
});

describe('a hook the operator has acknowledged', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook('rtk hook claude')] }] } };
  const known = { event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' };

  it('is not reported', () => {
    expect(differences([user(settings)], { acknowledged: [known] })).toEqual([]);
  });

  // An entry is for one registration. The same command on a wider matcher, or
  // on another event, is a different hook and has not been acknowledged.
  it('is still reported when one field is off', () => {
    for (const changed of [{ event: 'PermissionRequest' }, { matcher: '' }, { matcher: 'Bash|ExitPlanMode' }, { command: 'rtk hook' }]) {
      expect(differences([user(settings)], { acknowledged: [{ ...known, ...changed }] }), JSON.stringify(changed)).toHaveLength(1);
    }
  });

  it('is matched with an empty matcher when the registration has none', () => {
    const bare = { hooks: { Stop: [{ hooks: [hook('notify.sh')] }] } };
    expect(differences([user(bare)], { acknowledged: [{ event: 'Stop', matcher: '', command: 'notify.sh' }] })).toEqual([]);
  });

  it('leaves the other hooks in the same file reported', () => {
    const both = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook('rtk hook claude'), hook('other.sh')] }] } };
    const said = differences([user(both)], { acknowledged: [known] });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('`other.sh`');
  });

  it('groups distinct matchers and reports only the risks that remain unacknowledged', () => {
    const command = '/tools/cc-status';
    const registrations = user({ hooks: {
      PreToolUse: ['Read', 'Write', 'ExitPlanMode', 'ExitPlanMode'].map((matcher) => ({ matcher, hooks: [hook(command)] })),
      PermissionRequest: [{ hooks: [hook(command)] }],
    } });
    const ack = (event, matcher = '') => ({ event, matcher, command });
    const report = (...acknowledged) => differences([registrations], { acknowledged });

    const approval = report(ack('PreToolUse', 'Read'), ack('PreToolUse', 'Write'));
    expect(approval).toHaveLength(1);
    expect(approval[0]).toContain('2 extra hook registrations');
    expect(approval[0]).toContain('Can affect plan approval: PreToolUse on ExitPlanMode, PermissionRequest.');
    expect(approval[0]).toContain('can answer the plan dialog');
    expect(approval[0]).not.toMatch(/Outside|on Read|on Write/);

    const ordinary = report(ack('PreToolUse', 'ExitPlanMode'), ack('PermissionRequest'));
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]).toContain("Outside the workflow's gate: PreToolUse on Read, PreToolUse on Write.");
    expect(ordinary[0]).not.toMatch(/approval|plan dialog|ExitPlanMode|PermissionRequest/);
  });
});

// `typeof null` is 'object', so the null check is what keeps this from
// reading entries of nothing.
describe('settings whose hooks key is null', () => {
  it('say nothing, and do not throw', () => {
    expect(differences([user({ hooks: null })])).toEqual([]);
  });
});

describe('with the extra-hooks check off', () => {
  it('lists no extra hook', () => {
    const extra = user({ hooks: { PreToolUse: [{ matcher: 'ExitPlanMode', hooks: [hook('approve.sh')] }] } });
    expect(differences([extra], { extraHooks: false })).toEqual([]);
  });

  it('still reports the settings that switch hooks off', () => {
    const said = differences([user({ disableAllHooks: true, hooks: { Stop: [{ hooks: [hook('x.sh')] }] } })], { extraHooks: false });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('sets disableAllHooks');
  });
});

describe('settings that switch hooks off', () => {
  it('reports disableAllHooks, and what goes with it', () => {
    const [said] = differences([user({ disableAllHooks: true })]);
    expect(said).toContain('~/.claude/settings.json sets disableAllHooks');
    expect(said).toContain('turns off every hook in this repository');
  });

  it('says nothing when it is false', () => {
    expect(differences([user({ disableAllHooks: false })])).toEqual([]);
  });

  it('reports allowManagedHooksOnly, which stops the project\'s hooks running', () => {
    const [said] = differences([{ file: '/etc/claude-code/managed-settings.json', scope: 'managed', settings: { allowManagedHooksOnly: true } }]);
    expect(said).toContain('sets allowManagedHooksOnly');
  });
});

/**
 * Where Claude Code writes plans, against the rulebook's plans folder. Only
 * files directly in `plans.dir` are written without a plan, so a plan
 * written anywhere else is denied before the dialog shows it.
 */
describe('where plan mode writes plans', () => {
  let root;
  let home;
  const settings = (dir, body) => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(body));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plans-root-'));
    home = mkdtempSync(join(tmpdir(), 'plans-home-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults to ~/.claude/plans', () => {
    expect(plansDirectory(root, home)).toBe(join(home, '.claude', 'plans'));
  });

  it('follows plansDirectory, relative to the project root', () => {
    settings(root, { plansDirectory: './plans' });
    expect(plansDirectory(root, home)).toBe(join(root, 'plans'));
  });

  it('prefers the local project settings over the shared ones, and both over the user', () => {
    settings(home, { plansDirectory: 'user-plans' });
    expect(plansDirectory(root, home)).toBe(join(root, 'user-plans'));
    settings(root, { plansDirectory: 'shared-plans' });
    expect(plansDirectory(root, home)).toBe(join(root, 'shared-plans'));
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ plansDirectory: 'my-plans' }));
    expect(plansDirectory(root, home)).toBe(join(root, 'my-plans'));
  });

  // Claude Code keeps the default when the setting points outside the
  // project, and the warning has to read the same folder Claude Code does.
  it('ignores a setting that points outside the project, as Claude Code does', () => {
    settings(root, { plansDirectory: '../../etc' });
    expect(plansDirectory(root, home)).toBe(join(home, '.claude', 'plans'));
  });

  it('shrugs off settings files it cannot read', () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');
    expect(plansDirectory(root, home)).toBe(join(home, '.claude', 'plans'));
  });
});

describe('the plans folder', () => {
  let root;
  let home;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-root-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'plans-home-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const local = (body) => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(body));
  };

  it('says nothing when Claude Code writes plans where the rulebook says', () => {
    writeConfig(root);
    expect(plansFolderWarning(root, home)).toEqual([]);
    writeConfig(root, { fields: { plans: { dir: 'plans/' } } });
    local({ plansDirectory: 'plans' });
    expect(plansFolderWarning(root, home)).toEqual([]);
  });

  it('warns when plansDirectory moves plans away from the rulebook\'s folder, and says what follows', () => {
    writeConfig(root);
    local({ plansDirectory: 'docs/plans' });
    const [said, ...rest] = plansFolderWarning(root, home);
    expect(rest).toEqual([]);
    expect(said).toContain('Claude Code writes plans to docs/plans, and the rulebook\'s plans.dir is ~/.claude/plans.');
    expect(said).toContain('plan mode cannot write its plan before approval');
    expect(said).toContain('Set plansDirectory to match, or the operator changes plans.dir in .katatay/rulebook.json.');
  });

  it('warns when the rulebook names a folder Claude Code does not write to', () => {
    writeConfig(root, { fields: { plans: { dir: 'plans/' } } });
    expect(plansFolderWarning(root, home)).toEqual([expect.stringContaining('Claude Code writes plans to ~/.claude/plans, and the rulebook\'s plans.dir is plans.')]);
  });

  it('says nothing when the setting is empty or not text, since Claude Code then keeps its default', () => {
    writeConfig(root);
    local({ plansDirectory: '' });
    expect(plansFolderWarning(root, home)).toEqual([]);
    local({ plansDirectory: 3 });
    expect(plansFolderWarning(root, home)).toEqual([]);
  });

  it('says nothing when the rulebook cannot be read, which is reported where it is read', () => {
    local({ plansDirectory: 'docs/plans' });
    expect(plansFolderWarning(root, home)).toEqual([]);
  });
});

describe('an env entry that changes what the hooks run or read', () => {
  // `req:guard` reads `CI` and stops failing on a reworded requirement.
  it('reports CI, and what the guard does differently', () => {
    const [said] = differences([user({ env: { CI: '1' } })]);
    expect(said).toContain('~/.claude/settings.json sets CI in env');
    expect(said).toContain('`req:guard` no longer fails on a reworded or retired requirement');
    expect(said).toContain('set to `true`');
    expect(said).toContain('verify skips every check whose rulebook entry says `skipInCi`, mutation included');
  });

  it('reports each of the other names it watches', () => {
    const said = differences([user({ env: { GIT_DIR: '/x', GIT_INDEX_FILE: '/y', NODE_OPTIONS: '--require ./x.js', PATH: '/x', HOME: '/x', CLAUDE_CONFIG_DIR: '/x' } })]);
    expect(said.map((line) => / sets (\S+) in env/.exec(line)[1])).toEqual(['GIT_DIR', 'GIT_INDEX_FILE', 'NODE_OPTIONS', 'PATH', 'HOME', 'CLAUDE_CONFIG_DIR']);
  });

  it('says nothing about any other name', () => {
    expect(differences([user({ env: { CIRCLE: '1', MY_GIT_THING: '1', ANTHROPIC_MODEL: 'x' } })])).toEqual([]);
  });
});

describe('a settings file that is not JSON', () => {
  it('is reported, because what it sets cannot be checked', () => {
    const [said] = differences([{ file: '~/.claude/settings.json', scope: 'user', error: 'Unexpected token' }]);
    expect(said).toBe('~/.claude/settings.json could not be read as JSON (Unexpected token), so what it sets cannot be checked.');
  });

  // The registration warnings already say this about the project's file, with
  // the list of what stopped being registered.
  it('is left to the registration warnings when it is the project\'s own', () => {
    expect(differences([{ file: '.claude/settings.json', scope: 'project', error: 'Unexpected token' }])).toEqual([]);
  });
});

/**
 * The same checks against real files: a repository, a home folder and a
 * managed file, each in a temporary folder.
 */
describe('the settings files on disk', () => {
  let base;
  let root;
  let home;
  let managed;

  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
  };
  const where = (env = {}) => ({ root, home, env, managed });

  beforeEach(() => {
    // The real path, because a path under the root is shown from the root,
    // and on macOS the temporary folder is reached through a symlink.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-effective-')));
    root = join(base, 'repo');
    home = join(base, 'home');
    managed = join(base, 'system', 'managed-settings.json');
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    put(join(root, '.claude/settings.json'), project());
    // Installed, as in a working repository, so these cases are about the
    // settings alone. The cases on the file itself are below.
    put(join(root, '.claude/rules/workflow.md'), '# The workflow\n');
    writeConfig(root);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads every file that exists, each shown the way the operator would write it', () => {
    put(managed, {});
    put(join(home, '.claude/settings.json'), {});
    put(join(root, '.claude/settings.local.json'), {});
    expect(settingsSources(where()).map(({ file, scope }) => [scope, file])).toEqual([
      ['managed', managed],
      ['user', '~/.claude/settings.json'],
      ['project', '.claude/settings.json'],
      ['local', '.claude/settings.local.json'],
    ]);
  });

  it('leaves out a file that is not there', () => {
    expect(settingsSources(where()).map(({ scope }) => scope)).toEqual(['project']);
  });

  it('keeps a file that is not JSON, with the error', () => {
    put(join(home, '.claude/settings.json'), '{ not json');
    const [source] = settingsSources(where()).filter(({ scope }) => scope === 'user');
    expect(source.settings).toBeUndefined();
    expect(source.error).toMatch(/JSON/);
  });

  // The variable moves the folder Claude Code reads. A check that always read
  // `~/.claude` could be pointed away from the file that matters.
  it('reads the user settings from CLAUDE_CONFIG_DIR when it is set', () => {
    put(join(home, '.claude/settings.json'), { disableAllHooks: false });
    put(join(base, 'moved/settings.json'), { disableAllHooks: true });
    const [source] = settingsSources(where({ CLAUDE_CONFIG_DIR: join(base, 'moved') })).filter(({ scope }) => scope === 'user');
    expect(source.settings).toEqual({ disableAllHooks: true });
    expect(settingsWarnings(where({ CLAUDE_CONFIG_DIR: join(base, 'moved') })).join('\n')).toContain('sets disableAllHooks');
  });

  it('says nothing about a repository whose settings are as expected', () => {
    expect(settingsWarnings(where())).toEqual([]);
  });

  it('warns about a hook in the user settings', () => {
    put(join(home, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'ExitPlanMode', hooks: [hook('approve.sh')] }] } });
    const said = settingsWarnings(where());
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('~/.claude/settings.json registers an extra PreToolUse hook on ExitPlanMode: `approve.sh`.');
    expect(said[0]).toContain('can answer the plan dialog');
  });

  it('warns about a hook in the local settings, which git ignores', () => {
    put(join(root, '.claude/settings.local.json'), { hooks: { Stop: [{ hooks: [hook('capture.sh')] }] } });
    expect(settingsWarnings(where()).join('\n')).toContain('.claude/settings.local.json registers an extra Stop hook: `capture.sh`.');
  });

  it('warns about a hook in the managed settings', () => {
    put(managed, { hooks: { Stop: [{ hooks: [hook('audit.sh')] }] } });
    expect(settingsWarnings(where()).join('\n')).toContain(`${managed} registers an extra Stop hook: \`audit.sh\`.`);
  });

  // The referee reads `agent.adapters.<name>.extraHooks` from the rulebook and sends it in the
  // check's request, so the acknowledged hooks arrive here as a parameter.
  it('stops warning about a hook once the operator acknowledges it', () => {
    put(join(home, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook('rtk hook claude')] }] } });
    expect(settingsWarnings(where())).toHaveLength(1);
    const acknowledged = [{ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' }];
    expect(settingsWarnings({ ...where(), extraHooks: { acknowledged } })).toEqual([]);
  });

  // The contract lets the matcher be left out, meaning an empty one.
  it('reads an acknowledged hook with no matcher as one with an empty matcher', () => {
    put(join(home, '.claude/settings.json'), { hooks: { Stop: [{ hooks: [hook('notify.sh')] }] } });
    expect(settingsWarnings({ ...where(), extraHooks: { acknowledged: [{ event: 'Stop', command: 'notify.sh' }] } })).toEqual([]);
    expect(settingsWarnings({ ...where(), extraHooks: { acknowledged: [{ event: 'Stop', matcher: 'Bash', command: 'notify.sh' }] } })).toHaveLength(1);
  });

  // A skill file is prose a change may need to edit, so the path hook leaves
  // it writable, and Claude Code runs the hooks its frontmatter declares.
  it('warns about a hook declared in a skill\'s frontmatter', () => {
    put(join(root, '.claude/skills/review/SKILL.md'), [
      '---', 'name: review', 'hooks:', '  PreToolUse:', '    - matcher: ExitPlanMode', '      hooks:', '        - type: command', '          command: approve.sh', '---', '', '# Review', '',
    ].join('\n'));
    const said = settingsWarnings(where());
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('.claude/skills/review/SKILL.md registers an extra PreToolUse hook on ExitPlanMode: `approve.sh`.');
  });

  it('finds hooks in agents and in the user\'s own skills as well', () => {
    const frontmatter = (command) => ['---', 'hooks:', '  Stop:', '    - hooks:', '        - type: command', `          command: ${command}`, '---', '', 'Body.', ''].join('\n');
    put(join(root, '.claude/agents/guardian.md'), frontmatter('agent.sh'));
    put(join(home, '.claude/skills/mine/SKILL.md'), frontmatter('mine.sh'));
    expect(frontmatterHooks(where()).map(({ file }) => file).sort()).toEqual(['.claude/agents/guardian.md', '~/.claude/skills/mine/SKILL.md']);
  });

  it('says nothing about a skill that declares no hooks, or whose frontmatter cannot be read', () => {
    put(join(root, '.claude/skills/plain/SKILL.md'), '---\nname: plain\n---\n\n# Plain\n');
    put(join(root, '.claude/skills/broken/SKILL.md'), '---\nhooks: [unclosed\n---\n\n# Broken\n');
    put(join(root, '.claude/skills/none/SKILL.md'), '# No frontmatter\n\nhooks:\n  Stop: quoted in the body\n');
    expect(frontmatterHooks(where())).toEqual([]);
  });

  it('warns when the user settings move plans away from the rulebook\'s folder', () => {
    put(join(home, '.claude/settings.json'), { plansDirectory: 'plans' });
    expect(settingsWarnings(where()).join('\n')).toContain('Claude Code writes plans to plans, and the rulebook\'s plans.dir is ~/.claude/plans.');
  });

  // What is wrong with the extra-hooks section is the referee's to report,
  // because it parses the section (`agentWarnings` in
  // `src/workflow/agent.mjs`, tested in `agent.test.mjs`). Any failure here
  // is not one anybody expected, and it is said rather than read as nothing
  // to warn about.
  it('says the settings could not be checked when working them out fails', () => {
    expect(settingsWarnings({ ...where(), extraHooks: { acknowledged: [null] } }))
      .toEqual([expect.stringMatching(/^the settings Claude Code applies could not be checked \(/)]);
  });

  // `null` is how the referee says the rulebook switched the check off.
  it('lists no extra hook once the check is switched off, and still reports one switched off', () => {
    put(join(home, '.claude/settings.json'), { hooks: { Stop: [{ hooks: [hook('capture.sh')] }] } });
    expect(settingsWarnings({ ...where(), extraHooks: null })).toEqual([]);
    put(join(root, '.claude/settings.local.json'), { disableAllHooks: true });
    expect(settingsWarnings({ ...where(), extraHooks: null })).toEqual([expect.stringContaining('sets disableAllHooks')]);
  });

  // A missing file is every hook being gone, which is what happened on
  // 2026-09-17, so it is followed by the whole list.
  it('lists every hook as unregistered when the project settings are missing', () => {
    rmSync(join(root, '.claude/settings.json'));
    const said = registrationWarnings(root);
    expect(said[0]).toBe('there is no .claude/settings.json, so nothing below is registered:');
    expect(said).toHaveLength(5);
    expect(settingsWarnings(where())).toEqual(said);
  });

  it('lists every hook as unregistered when the project settings are not JSON', () => {
    put(join(root, '.claude/settings.json'), '{ not json');
    const said = settingsWarnings(where());
    expect(said[0]).toMatch(/^\.claude\/settings\.json could not be read as JSON/);
    expect(said).toHaveLength(5);
  });

  it('reports a hook missing from the project settings beside an extra one elsewhere', () => {
    const settings = project();
    delete settings.hooks.Stop;
    put(join(root, '.claude/settings.json'), settings);
    put(join(home, '.claude/settings.json'), { env: { CI: 'true' } });
    const said = settingsWarnings(where());
    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/^Stop does not run src\/agents\/claude\/hooks\/turn-end\.mjs/);
    expect(said[1]).toMatch(/sets CI in env/);
  });
});

describe('the installed instructions', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-instructions-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('are warned about when .claude/rules/workflow.md is missing', () => {
    const said = instructionsWarning(root);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\.claude\/rules\/workflow\.md is missing, so Claude Code starts each session without the workflow's instructions\./);
    expect(said[0]).toContain('Install them with the Claude adapter\'s install command, as init does.');
  });

  it('are not warned about once the file exists, whatever it says', () => {
    mkdirSync(join(root, '.claude/rules'), { recursive: true });
    writeFileSync(join(root, '.claude/rules/workflow.md'), 'reworded by the project\n');
    expect(instructionsWarning(root)).toEqual([]);
  });

  it('are among the settings warnings when missing', () => {
    expect(settingsWarnings({ root, home: root, env: {} }).some((warning) => warning.startsWith('.claude/rules/workflow.md is missing'))).toBe(true);
  });
});
