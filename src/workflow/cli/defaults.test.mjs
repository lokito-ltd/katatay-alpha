import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { USAGE, run, shown } from './defaults.mjs';
/** The real Claude command, as a command line: the referee never imports it. */
const CLAUDE = ['node', resolve('src/agents/claude/defaults.mjs')];

const PROPOSAL = {
  locked: ['.claude/settings.json', '~/.claude/settings.json'],
  plansFolder: '~/.claude/plans',
  instructions: 'CLAUDE.md',
  commands: { check: 'node check.mjs', longer: 'node longer.mjs' },
  registration: { file: '.claude/settings.json', text: '{\n  "hooks": {}\n}\n', steps: ['Merge them.', 'Restart.'] },
};

describe('an agent adapter\'s defaults, shown for a person', () => {
  // Built inside each test, never once for the file: mutation testing switches
  // a mutant on only while a test runs, so text built while the file is
  // collected would never show one.
  const shownLines = () => shown('node defaults.mjs', PROPOSAL).split('\n');

  it('says which command proposed them', () => {
    expect(shownLines()[0]).toBe('Proposed by `node defaults.mjs`:');
  });

  it('puts each locked path on its own line, the values lined up under the first', () => {
    expect(shownLines()).toContain('locked        .claude/settings.json');
    expect(shownLines()).toContain('              ~/.claude/settings.json');
  });

  it('shows the plans folder, the instructions file and each command, names lined up', () => {
    expect(shownLines()).toContain('plans folder  ~/.claude/plans');
    expect(shownLines()).toContain('instructions  CLAUDE.md');
    expect(shownLines()).toContain('commands      check   node check.mjs');
    expect(shownLines()).toContain('              longer  node longer.mjs');
  });

  it('gives the registration text as it is, after the file it goes in', () => {
    const text = shown('x', PROPOSAL);
    expect(text).toContain('Hook registration, to merge into .claude/settings.json:\n\n{\n  "hooks": {}\n}\n\n');
  });

  it('numbers the steps only the operator can take, last', () => {
    expect(shownLines().slice(-3)).toEqual(['Steps only the operator can take:', '  1. Merge them.', '  2. Restart.']);
  });

  it('says so when there is nothing to lock, no command and no step', () => {
    const empty = shown('x', { ...PROPOSAL, locked: [], commands: {}, registration: { ...PROPOSAL.registration, steps: [] } }).split('\n');
    expect(empty).toContain('locked        (nothing)');
    expect(empty).toContain('commands      (none)');
    expect(empty.at(-1)).toBe('No other steps for the operator.');
  });
});

describe('the defaults subcommand', () => {
  it('shows the Claude adapter\'s answer and exits 0', () => {
    const { stdout, code } = run(CLAUDE);
    expect(code).toBe(0);
    expect(stdout).toContain('plans folder  ~/.claude/plans');
    expect(stdout).toContain('"command": "node src/agents/claude/hooks/turn-end.mjs"');
  });

  it('joins the arguments into the command line it asks', () => {
    expect(run(CLAUDE).stdout.split('\n')[0]).toBe(`Proposed by \`${CLAUDE.join(' ')}\`:`);
  });

  it('says why and exits 1 when the command gives no answer, showing nothing', () => {
    expect(run(['exit', '3'])).toEqual({ stderr: 'the agent\'s defaults (`exit 3`) gave no answer: it exited with 3.', code: 1 });
  });

  it('prints the usage and exits 2 without a command line', () => {
    expect(run([])).toEqual({ stderr: USAGE, code: 2 });
  });
});
