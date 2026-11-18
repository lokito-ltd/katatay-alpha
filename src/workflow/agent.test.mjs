import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentDefaults, agentInstall, agentWarnings, setupMessages } from './agent.mjs';
import { installRequest } from './install.mjs';
import * as rulebook from './rulebook.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-agent-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A rulebook whose agent check is `script`, a Node program printing what the
 * case needs. `adapter` adds to the named adapter's entry.
 */
function checkedBy(script, adapter = {}) {
  writeFileSync(join(root, 'check.mjs'), script);
  writeConfig(root, { fields: { agent: { lockedPaths: [], adapters: { local: { checkCommand: 'node check.mjs', ...adapter } } } } });
}

/** A check that answers `warnings`, with the contract's version. */
const answering = (warnings) => `process.stdout.write(JSON.stringify({ version: 1, warnings: ${warnings} }));`;

/** A check that answers with the request it was given, as its one warning. */
const ECHO = 'let input = ""; process.stdin.on("data", (d) => { input += d; }); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ version: 1, warnings: [input] })));';
const request = () => JSON.parse(agentWarnings(root, { backstop: 10 })[0].slice('local: '.length));

describe('asking the agent adapter what is wrong', () => {
  it('passes on the warnings the check prints', () => {
    checkedBy(answering('["one", "two"]'));
    expect(agentWarnings(root)).toEqual(['local: one', 'local: two']);
  });

  it('has nothing to say when the check finds nothing', () => {
    checkedBy(answering('[]'));
    expect(agentWarnings(root)).toEqual([]);
  });

  it('runs the check in the repository it was asked about', () => {
    checkedBy(answering('[process.cwd()]'));
    expect(agentWarnings(root)).toEqual([`local: ${root}`]);
  });

  it('reports missing adapters and a missing agent section', () => {
    writeConfig(root, { fields: { agent: { lockedPaths: [] } } });
    expect(agentWarnings(root)).toEqual([expect.stringContaining('"agent.adapters" must be an object keyed by agent name')]);
    writeConfig(root, { fields: { agent: undefined } });
    expect(agentWarnings(root)).toEqual([expect.stringContaining('"agent" must be an object')]);
  });
});

// No answer is never a pass. Each of these would otherwise read as a clean
// report, and the operator would not hear that the check stopped working.
describe('a check that gives no answer', () => {
  const noAnswer = (warnings) => {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^local: the agent check \(`node check\.mjs`\) gave no answer: /);
    expect(warnings[0]).toMatch(/Nothing was concluded from it, so the agent's setup is unchecked\.$/);
    return warnings[0];
  };

  it('crashing is one warning', () => {
    checkedBy('throw new Error("boom");');
    expect(noAnswer(agentWarnings(root))).toContain('it exited with 1');
  });

  it('printing something that is not JSON is one warning', () => {
    checkedBy('process.stdout.write("all fine");');
    expect(noAnswer(agentWarnings(root))).toContain('not JSON');
  });

  it('printing JSON without a list of warning strings is one warning', () => {
    for (const printed of ['{"version":1}', '{"version":1,"warnings":"none"}', '{"version":1,"warnings":[1]}']) {
      checkedBy(`process.stdout.write(${JSON.stringify(printed)});`);
      expect(noAnswer(agentWarnings(root)), printed).toContain('without a "warnings" list of strings');
    }
  });

  // The referee and the adapters change together, so another number means one
  // of them was left behind, and its warnings cannot be read.
  it('answering without a version, or with another one, is one warning', () => {
    for (const printed of ['{}', '{"warnings":[]}', 'null', '[]']) {
      checkedBy(`process.stdout.write(${JSON.stringify(printed)});`);
      expect(noAnswer(agentWarnings(root)), printed).toContain('it answered without a version');
    }
    for (const version of [null, '1']) {
      checkedBy(`process.stdout.write(${JSON.stringify(JSON.stringify({ version, warnings: [] }))});`);
      expect(noAnswer(agentWarnings(root))).toContain(`it answered version ${JSON.stringify(version)}, not 1`);
    }
    checkedBy('process.stdout.write(JSON.stringify({ version: 2, warnings: [] }));');
    expect(noAnswer(agentWarnings(root))).toContain('it answered version 2, not 1');
  });

  it('printing nothing at all is one warning', () => {
    checkedBy('');
    expect(noAnswer(agentWarnings(root))).toContain('not JSON');
  });

  it('being a command that does not exist is one warning', () => {
    writeConfig(root, { fields: { agent: { lockedPaths: [], adapters: { local: { checkCommand: 'node check.mjs' } } } } });
    expect(noAnswer(agentWarnings(root))).toContain('it exited with');
  });
});

describe('a rulebook the referee cannot read', () => {
  it('is reported as the warning, not thrown, because the agent check is a warning and never a failure', () => {
    writeConfig(root, { fields: { agent: { lockedPaths: [], adapters: { local: { checkCommand: '' } } } } });
    expect(agentWarnings(root)).toEqual([expect.stringContaining('"agent.adapters.local.checkCommand" must be a command')]);
  });
});

// The check is told the repository, and the extra hooks the operator has
// acknowledged, which the referee reads from the rulebook so that a section it
// refuses is refused in one place.
describe('what the check is asked', () => {
  it('does not hide an unexpected parser failure as an invalid configuration warning', () => {
    checkedBy(ECHO);
    const failure = new Error('unexpected parser failure');
    vi.spyOn(rulebook, 'parseExtraHooks').mockImplementationOnce(() => { throw failure; });
    expect(() => agentWarnings(root)).toThrow(failure);
  });

  it('is the version, the repository, and the acknowledged hooks', () => {
    const acknowledged = [{ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' }];
    checkedBy(ECHO, { extraHooks: { check: true, acknowledged } });
    expect(request()).toEqual({ version: 1, root, extraHooks: { acknowledged } });
  });

  it('sends nothing acknowledged when the rulebook has no extra-hooks section', () => {
    checkedBy(ECHO);
    expect(request().extraHooks).toEqual({ acknowledged: [] });
  });

  it('sends null when the rulebook switches the extra-hooks check off', () => {
    checkedBy(ECHO, { extraHooks: { check: false, acknowledged: [] } });
    expect(request().extraHooks).toBeNull();
  });

  it('reports the invalid extra-hook switch as the sole diagnostic', () => {
    checkedBy(ECHO, { extraHooks: { check: 'yes' } });
    expect(agentWarnings(root)).toEqual([
      expect.stringContaining('"agent.adapters.local.extraHooks.check" must be true or false'),
    ]);
  });
});

describe('the warnings as messages', () => {
  it('is one warning for the operator each, saying it is a setting to pass on', () => {
    checkedBy(answering('["first.", "second."]'));
    expect(setupMessages(root)).toEqual([
      { code: 'warning', for: 'operator', text: 'settings: local: first. Tell the operator.' },
      { code: 'warning', for: 'operator', text: 'settings: local: second. Tell the operator.' },
    ]);
  });

  it('is nothing at all when there are none', () => {
    checkedBy(answering('[]'));
    expect(setupMessages(root)).toEqual([]);
  });
});

describe('several named agents', () => {
  const configure = (adapters) => writeConfig(root, { fields: { agent: { lockedPaths: [], adapters } } });
  const entry = (script) => {
    writeFileSync(join(root, 'healthy.mjs'), script);
    return { checkCommand: 'node healthy.mjs' };
  };

  it('runs sequentially in configured order and preserves duplicate warnings', () => {
    writeFileSync(join(root, 'first.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "first"); ' + answering('["same", "same"]'));
    writeFileSync(join(root, 'second.mjs'), 'import { readFileSync } from "node:fs"; ' + answering('[readFileSync("ran", "utf8"), "same"]'));
    configure({ z: { checkCommand: 'node first.mjs' }, a: { checkCommand: 'node second.mjs' } });
    expect(agentWarnings(root)).toEqual(['z: same', 'z: same', 'a: first', 'a: same']);
  });

  it('reports an empty map as a setup error', () => {
    configure({});
    expect(agentWarnings(root)).toEqual([expect.stringContaining('"agent.adapters" must contain at least one named adapter')]);
  });

  it.each([['crashed', 'process.exit(3);', 'exited with 3'], ['malformed', 'process.stdout.write("no");', 'not JSON']])('continues after a check %s', (_kind, script, problem) => {
    writeFileSync(join(root, 'bad.mjs'), script);
    configure({ broken: { checkCommand: 'node bad.mjs' }, healthy: entry(answering('["still checked"]')) });
    const warnings = agentWarnings(root, { backstop: 1 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^broken: the agent check/);
    expect(warnings[0]).toContain(problem);
    expect(warnings[1]).toBe('healthy: still checked');
  });

  it('keeps acknowledgements and switches separate even for identical hook signatures', () => {
    const hook = { event: 'Stop', matcher: '', command: 'notify' };
    writeFileSync(join(root, 'hooks.mjs'), `let input = ''; process.stdin.on('data', (d) => input += d); process.stdin.on('end', () => {
      const { extraHooks } = JSON.parse(input);
      const hook = ${JSON.stringify(hook)};
      const acknowledged = extraHooks?.acknowledged.some((item) => JSON.stringify(item) === JSON.stringify(hook));
      process.stdout.write(JSON.stringify({ version: 1, warnings: extraHooks === null || acknowledged ? [] : ['extra notify'] }));
    });`);
    const adapter = (extraHooks) => ({ checkCommand: 'node hooks.mjs', extraHooks });
    configure({ acknowledged: adapter({ acknowledged: [hook] }), watching: adapter(), disabled: adapter({ check: false }), watchingAgain: adapter({ acknowledged: [] }) });
    expect(agentWarnings(root)).toEqual(['watching: extra notify', 'watchingAgain: extra notify']);
  });

  it("sends only each agent's resolved settings and leaves the protocol unchanged", () => {
    writeFileSync(join(root, 'echo.mjs'), ECHO);
    const acknowledged = [{ event: 'Stop', matcher: '', command: 'notify' }];
    const adapter = (extraHooks) => ({ checkCommand: 'node echo.mjs', extraHooks });
    configure({ a: adapter({ acknowledged }), b: adapter({ check: false }), c: adapter() });
    expect(agentWarnings(root)).toEqual([
      `a: ${JSON.stringify({ version: 1, root, extraHooks: { acknowledged } })}`,
      `b: ${JSON.stringify({ version: 1, root, extraHooks: null })}`,
      `c: ${JSON.stringify({ version: 1, root, extraHooks: { acknowledged: [] } })}`,
    ]);
  });

  it('reports a later adapter’s invalid acknowledgement before starting any setup check', () => {
    const check = entry('import { writeFileSync } from "node:fs"; writeFileSync("ran", "yes"); ' + answering('[]'));
    configure({ first: check, bad: { ...check, extraHooks: { check: false, acknowledged: 'all' } } });
    expect(agentWarnings(root)).toEqual([
      expect.stringContaining('"agent.adapters.bad.extraHooks.acknowledged" must be a list'),
    ]);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });
});

// `init` asks the adapter's defaults before any rulebook exists, so the command
// line is handed in. The real Claude command is started as a command line, never
// imported: the referee knows no agent.
describe('asking the agent adapter for its defaults', () => {
  const CLAUDE = `node ${JSON.stringify(resolve('src/agents/claude/defaults.mjs'))}`;
  const PROPOSAL = {
    locked: ['.claude/settings.json'],
    plansFolder: '~/.claude/plans',
    instructions: 'CLAUDE.md',
    commands: { check: 'node check.mjs' },
    registration: { file: '.claude/settings.json', text: '{}', steps: ['restart'] },
  };
  /** A defaults command that prints `answer` as JSON. */
  const printing = (answer) => {
    writeFileSync(join(root, 'defaults.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
    return 'node defaults.mjs';
  };

  it('returns the proposal of the Claude adapter, without the version', () => {
    const { proposal } = agentDefaults(CLAUDE, root);
    expect(Object.keys(proposal)).toEqual(['locked', 'plansFolder', 'instructions', 'commands', 'registration']);
    expect(proposal.commands.check).toContain('check.mjs');
  });

  it('returns what the command printed, run in the project it was asked about', () => {
    expect(agentDefaults(printing({ version: 1, ...PROPOSAL }), root)).toEqual({ proposal: PROPOSAL });
  });

  it('asks with the version only', () => {
    writeFileSync(join(root, 'defaults.mjs'), `let input = ""; process.stdin.on("data", (d) => { input += d; }); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ...${JSON.stringify({ version: 1, ...PROPOSAL })}, instructions: input })));`);
    expect(JSON.parse(agentDefaults('node defaults.mjs', root).proposal.instructions)).toEqual({ version: 1 });
  });

  // No answer is never a pass, and half a proposal is no answer: a draft
  // rulebook with the agent's locks missing would look complete.
  describe('gives no proposal at all when the command', () => {
    const none = (result, why, input) => {
      expect(Object.keys(result), input).toEqual(['none']);
      expect(result.none, input).toMatch(/^the agent's defaults \(`node defaults\.mjs`\) gave no answer: /);
      expect(result.none, input).toContain(why);
    };

    it('exits with anything but 0', () => {
      writeFileSync(join(root, 'defaults.mjs'), 'process.exit(3);');
      none(agentDefaults('node defaults.mjs', root), 'it exited with 3');
    });

    it('prints something that is not JSON', () => {
      writeFileSync(join(root, 'defaults.mjs'), 'process.stdout.write("hello");');
      none(agentDefaults('node defaults.mjs', root), 'not JSON');
    });

    it('answers without a version, or with another one', () => {
      none(agentDefaults(printing(PROPOSAL), root), 'without a version');
      for (const version of [null, '1']) {
        none(agentDefaults(printing({ version, ...PROPOSAL }), root), `version ${JSON.stringify(version)}, not 1`);
      }
      none(agentDefaults(printing({ version: 2, ...PROPOSAL }), root), 'version 2, not 1');
    });

    it('cannot be started, here because the project it is asked about is not there', () => {
      none(agentDefaults('node defaults.mjs', join(root, 'missing')), 'it could not be started');
    });

    it.each([
      ['locked', ['not a list', ['.claude/settings.json', 7]]],
      ['plansFolder', ['']],
      ['instructions', [7]],
      ['commands', [{ check: 1 }, ['node check.mjs'], { check: 'node check.mjs', other: 1 }]],
      ['registration', [
        { file: '.claude/settings.json', text: '{}' },
        null,
        { text: '{}', steps: [] },
        { file: '.claude/settings.json', text: 7, steps: [] },
        { file: '.claude/settings.json', text: '{}', steps: ['merge', 7] },
      ]],
    ])('omits %s or supplies an invalid value', (field, invalidValues) => {
      const { [field]: _left, ...rest } = PROPOSAL;
      const diagnostic = JSON.stringify(field);
      none(agentDefaults(printing({ version: 1, ...rest }), root), diagnostic, `missing ${field}`);
      for (const value of invalidValues) {
        const result = agentDefaults(printing({ version: 1, ...rest, [field]: value }), root);
        none(result, diagnostic, `${field} = ${JSON.stringify(value)}`);
      }
    });
  });
});

// `init` asks the adapter's install command for the files that carry the
// workflow's instructions and skills to its agent, and writes what comes back.
// So the answer is held to the project and kept off every lock.
describe('asking the agent adapter what to install', () => {
  const CLAUDE = `node ${JSON.stringify(resolve('src/agents/claude/install.mjs'))}`;
  const REQUEST = { instructions: '# The workflow\n', skills: [{ name: 'plan-change', description: 'Plan.', prompt: '# Plan\n' }] };
  const LOCKED = ['.claude/settings.json', '.claude/hooks/**', '~/.claude/settings.json'];
  /** An install command that prints `answer` as JSON. */
  const printing = (answer) => {
    writeFileSync(join(root, 'install.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
    return 'node install.mjs';
  };
  const asked = (answer, options = {}) => agentInstall(printing(answer), REQUEST, { root, home: join(root, 'home'), locked: LOCKED, ...options });

  it('returns the files of the Claude adapter for the referee\'s own texts', () => {
    const { files } = agentInstall(CLAUDE, installRequest(), { root, home: join(root, 'home'), locked: LOCKED });
    expect(files.map(({ path }) => path)).toEqual([
      '.claude/rules/workflow.md',
      '.claude/skills/author-acs/SKILL.md',
      '.claude/skills/commit-message/SKILL.md',
      '.claude/skills/plan-change/SKILL.md',
    ]);
  });

  it('asks with the version and the texts', () => {
    writeFileSync(join(root, 'install.mjs'), 'let input = ""; process.stdin.on("data", (d) => { input += d; }); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ version: 1, files: [{ path: "asked.json", text: input }] })));');
    const { files } = agentInstall('node install.mjs', { ...REQUEST, version: 99 }, { root });
    expect(JSON.parse(files[0].text)).toEqual({ version: 1, ...REQUEST });
  });

  it('returns what the command printed, without the version', () => {
    const files = [{ path: '.claude/rules/workflow.md', text: 'x' }, { path: 'nested/./file.md', text: '' }];
    expect(asked({ version: 1, files })).toEqual({ files });
  });

  describe('gives no files at all when the answer', () => {
    const none = (result, why) => {
      expect(Object.keys(result)).toEqual(['none']);
      expect(result.none).toMatch(/^the agent's install command \(`node install\.mjs`\) gave no answer: /);
      expect(result.none).toContain(why);
    };

    it.each([undefined, null, '1', 2])('refuses an install reply with version %j', version => {
      none(asked({ version, files: [] }), version === undefined ? 'without a version' : `version ${JSON.stringify(version)}, not 1`);
    });

    it('has no list of files, or a file without a path or a text', () => {
      none(asked({ version: 1 }), '"files" is not a list');
      none(asked({ version: 1, files: [{ path: 'a.md' }] }), '"files" is not a list');
      none(asked({ version: 1, files: [{ path: '', text: '' }] }), '"files" is not a list');
      none(asked({ version: 1, files: ['a.md'] }), '"files" is not a list');
      none(asked({ version: 1, files: [{ path: 'a.md', text: '' }, { path: 'b.md' }] }), '"files" is not a list');
    });

    it('names a path that is absolute or from the home folder', () => {
      none(asked({ version: 1, files: [{ path: join(root, 'a.md'), text: '' }] }), 'is not relative to the project');
      none(asked({ version: 1, files: [{ path: '~/a.md', text: '' }] }), 'is not relative to the project');
      none(asked({ version: 1, files: [{ path: '~', text: '' }] }), 'is not relative to the project');
    });

    it('names a path that leaves the project, or is the project itself', () => {
      none(asked({ version: 1, files: [{ path: '../a.md', text: '' }] }), 'leaves the project');
      none(asked({ version: 1, files: [{ path: 'a/../../b.md', text: '' }] }), 'leaves the project');
      none(asked({ version: 1, files: [{ path: '.', text: '' }] }), 'leaves the project');
    });

    it('names a path the referee locks, or the agent locks', () => {
      none(asked({ version: 1, files: [{ path: '.git/hooks/pre-commit', text: '' }] }), 'is locked (.git/**)');
      none(asked({ version: 1, files: [{ path: '.katatay/rulebook.json', text: '' }] }), 'is locked (.katatay/**)');
      none(asked({ version: 1, files: [{ path: '.claude/settings.json', text: '' }] }), 'is locked (.claude/settings.json)');
      none(asked({ version: 1, files: [{ path: '.claude/hooks/x.mjs', text: '' }] }), 'is locked (.claude/hooks/**)');
    });

    it('names one path twice, however it is spelled', () => {
      none(asked({ version: 1, files: [{ path: 'a.md', text: '1' }, { path: './a.md', text: '2' }] }), 'twice');
    });

    it('comes from a command that gives no answer', () => {
      writeFileSync(join(root, 'install.mjs'), 'process.exit(3);');
      none(agentInstall('node install.mjs', REQUEST, { root }), 'it exited with 3');
    });
  });

  // A command that exits before reading its request closes the pipe while it
  // is still being written, and the write fails with EPIPE. A request larger
  // than the pipe's buffer, 64 KB on macOS, makes that happen every time
  // instead of only under load, where it made `exit 3` read as "could not be
  // started". The command still ran, so its exit status and output decide.
  describe('a command that does not read its request', () => {
    const LARGE = { instructions: `# The workflow\n\n${'A rule. '.repeat(40_000)}\n`, skills: [] };

    it('is reported by its exit status', () => {
      const result = agentInstall('exit 3', LARGE, { root });
      expect(result).toEqual({ none: 'the agent\'s install command (`exit 3`) gave no answer: it exited with 3.' });
    });

    it('is answered when it prints an answer', () => {
      const files = [{ path: 'AGENTS.md', text: 'x' }];
      expect(agentInstall(printing({ version: 1, files }), LARGE, { root })).toEqual({ files });
    });
  });
});
