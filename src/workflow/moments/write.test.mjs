/** `on write`, decided in process. The machine cases in `machine/talking.test.mjs`
 *  and the conformance suite run it as a command, where coverage and
 *  mutation testing cannot see; these reach the same function directly.
 *
 *  There is no git repository here, so the phase cannot be known, and a write
 *  that needs a plan is denied. That makes every allowed write below one that
 *  needed no plan, and every lock one that was checked before the phase. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayWrite } from './write.mjs';
import { bareSections, writeConfig } from '../../../tests/fixtures/workflow/adapter.mjs';

let cwd;
let root;
let home;

beforeEach(() => {
  cwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'on-write-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'on-write-home-')));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const rulebook = (fields = {}) => writeConfig(root, { fields });
const edit = (path, removes = false) => ({ path, delete: removes });
const ask = (writes, command = null) => mayWrite({ writes, command }, { root, home });
const memoryNote = () => join(home, '.claude/projects/-x/memory/a-fact.md');
const allowed = { version: 1, allow: true, messages: [] };
/** A denial's one message as `code/for`, which is what an adapter branches on. */
const kind = (answer) => answer.messages.map((m) => `${m.code}/${m.for}`);

describe('a write the referee cannot judge', () => {
  it('is denied, and the message names the follow-ups file the rulebook keeps', () => {
    rulebook({ followUpsFile: 'docs/LATER.md' });
    const answer = ask([edit('source.txt')]);
    expect(answer.allow).toBe(false);
    expect(answer.messages[0].text).toContain('Plan files, docs/LATER.md and files outside the repository that no lock covers can still be written.');
  });

  it('still lets the follow-ups file the rulebook keeps be written', () => {
    rulebook({ followUpsFile: 'docs/LATER.md' });
    expect(ask([edit('docs/LATER.md')])).toEqual(allowed);
    expect(ask([edit('FOLLOW-UPS.md')]).allow).toBe(false);
  });
});

describe('the order the referee decides in', () => {
  it('allows a file outside the repository, such as a memory note, without asking the phase', () => {
    rulebook();
    expect(ask([edit(memoryNote())])).toEqual(allowed);
  });

  it('allows a plan directly in the plans folder', () => {
    rulebook();
    expect(ask([edit(join(home, '.claude/plans/a-plan.md'))])).toEqual(allowed);
  });

  it('checks the locks before anything outside the repository is allowed', () => {
    rulebook({ agent: { ...bareSections().agent, lockedPaths: ['~/.claude/settings.json'] } });
    expect(ask([edit(join(home, '.claude/settings.json'))]).messages[0].text).toMatch(/switch off its own constraints/);
  });

  it('enforces the rulebook\'s agent.lockedPaths inside the repository too', () => {
    rulebook({ agent: { ...bareSections().agent, lockedPaths: ['.claude/settings.json'] } });
    expect(ask([edit('.claude/settings.json')]).messages[0].text).toMatch(/switch off its own constraints/);
    expect(ask([edit('.claude/skills/a.md')]).messages[0].text).toMatch(/could not read the workflow state/);
  });

  it('denies the referee\'s own locks, and says why', () => {
    rulebook();
    expect(ask([edit('.katatay/state/b/0001__verified.json')]).messages[0].text).toMatch(/workflow logbook/);
    expect(ask([edit(join(root, '.git/config'))]).messages[0].text).toMatch(/outside the review loop/);
  });

  it('denies a delete under the rulebook\'s requirements folder, and allows writing there', () => {
    rulebook({ requirementsDir: 'specs/' });
    expect(ask([edit('specs/AC0001.md', true)]).messages[0].text).toMatch(/under specs\/ is never right/);
    expect(ask([edit('requirements/AC0001.md', true)]).messages[0].text).toMatch(/could not read the workflow state/);
  });

  // A Codex patch can name several files. One locked file denies the call.
  it('denies a call when any of its files is locked, and gates the rest on the phase', () => {
    rulebook();
    expect(ask([edit(memoryNote()), edit('.katatay/x')]).messages[0].text).toMatch(/workflow logbook/);
    expect(ask([edit(memoryNote()), edit('source.txt')]).messages[0].text).toMatch(/could not read the workflow state/);
    expect(ask([edit(memoryNote()), edit('FOLLOW-UPS.md')])).toEqual(allowed);
  });

  it('meets a link into a locked folder at the folder it leads to', () => {
    rulebook();
    mkdirSync(join(root, '.katatay/state'), { recursive: true });
    symlinkSync(join(root, '.katatay/state'), join(root, 'innocent'));
    expect(ask([edit('innocent/0001__verified.json')]).messages[0].text).toMatch(/workflow logbook/);
  });
});

describe('a shell command', () => {
  it('is never held for a plan, and the phase is not asked', () => {
    rulebook();
    expect(ask([], 'echo hi > source.txt')).toEqual(allowed);
  });

  it('is denied when it writes a locked path, and says it was the shell', () => {
    rulebook();
    const answer = ask([], 'echo hi > .katatay/x');
    expect(answer.messages[0].text).toMatch(/workflow logbook/);
    expect(answer.messages[0].text).toMatch(/\(This shell command appears to modify a locked path\.\)$/);
    expect(ask([], 'rm requirements/changes/0001__x.md').messages[0].text).toMatch(/never deleted/);
  });

  it('is judged against the rulebook\'s locks', () => {
    rulebook({ agent: { ...bareSections().agent, lockedPaths: ['.claude/settings.json'] } });
    expect(ask([], 'echo {} > .claude/settings.json').messages[0].text).toMatch(/switch off its own constraints/);
  });
});

describe('a rulebook that cannot be read', () => {
  const refused = () => rulebook({ plans: { dir: '.' } });

  it('reports an invalid high-risk reason on create or edit and permits the default follow-ups file', () => {
    rulebook({ highRisk: [{ paths: ['db/**'], why: '' }], followUpsFile: 'docs/LATER.md' });
    writeFileSync(join(root, 'existing.txt'), 'before');
    for (const path of ['new.txt', 'existing.txt', 'docs/LATER.md']) {
      const answer = ask([edit(path)]);
      expect(answer.allow).toBe(false);
      expect(kind(answer)).toEqual(['stop/operator']);
      expect(answer.messages[0].text).toContain('"highRisk[0]".why must say why');
    }
    expect(ask([edit('FOLLOW-UPS.md')])).toEqual(allowed);
  });

  // Its agent.lockedPaths is unknown, so a file outside the repository might be
  // one it would have locked.
  it('denies a write outside the repository, and says only the follow-ups file is left', () => {
    refused();
    const answer = ask([edit(memoryNote())]);
    expect(answer.messages[0].text).toMatch(/^The rulebook puts `plans\.dir` at `\.`, the repository root/);
    expect(answer.messages[0].text).toMatch(/Only FOLLOW-UPS\.md can still be written/);
  });

  it('still lets FOLLOW-UPS.md be written', () => {
    refused();
    expect(ask([edit('FOLLOW-UPS.md')])).toEqual(allowed);
  });

  it('names FOLLOW-UPS.md when there is no rulebook at all', () => {
    expect(ask([edit('source.txt')]).messages[0].text).toMatch(/Only FOLLOW-UPS\.md can still be written/);
  });

  it('still applies the referee\'s own locks and the default requirements folder to the shell', () => {
    refused();
    expect(ask([], 'echo x > .git/config').messages[0].text).toMatch(/outside the review loop/);
    expect(ask([], 'rm requirements/a.md').messages[0].text).toMatch(/never deleted/);
    expect(ask([], 'ls')).toEqual(allowed);
    expect(ask([], 'rm /tmp/scratch.md')).toEqual(allowed);
  });
});

// The shapes are checked before `mayWrite` runs (`io.mjs`), so a bad input is
// an adapter bug with exit 2. This covers the paths the shape allows.
describe('the paths a write names', () => {
  it('may be absolute or from the repository root', () => {
    rulebook();
    writeFileSync(join(root, 'FOLLOW-UPS.md'), '');
    expect(ask([edit(join(root, 'FOLLOW-UPS.md'))])).toEqual(allowed);
    expect(ask([edit('FOLLOW-UPS.md')])).toEqual(allowed);
  });
});

// Every answer carries the contract's version, and a denial says what kind it
// is, so an adapter can show a lock, a missing plan and a stop differently
// without reading the sentence.
describe('what a denial says it is', () => {
  it('is `locked` for the agent when a lock denies it, from a file or the shell', () => {
    rulebook();
    for (const answer of [ask([edit('.katatay/x')]), ask([], 'echo hi > .katatay/x'), ask([edit('requirements/a.md', true)])]) {
      expect(answer.version).toBe(1);
      expect(answer.allow).toBe(false);
      expect(kind(answer)).toEqual(['locked/agent']);
    }
  });

  // No phase is known here, or no rulebook, and only the operator can fix
  // either, so a plan is not what the agent is told to make.
  it('is `stop` for the operator when the state or the rulebook cannot be read', () => {
    rulebook();
    expect(kind(ask([edit('source.txt')]))).toEqual(['stop/operator']);
    rulebook({ plans: { dir: '.' } });
    expect(kind(ask([edit(memoryNote())]))).toEqual(['stop/operator']);
  });
});

