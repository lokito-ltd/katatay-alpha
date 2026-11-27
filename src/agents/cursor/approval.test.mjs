import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedPlan as capturedPlan, payload, transcript } from '../../../tests/fixtures/cursor/payloads.mjs';
import { cursorPlans, isBuild, matchingSavedPlan, newPlanFile, plansDir, recordBuild, savePlan, savedPlan, tidy } from './approval.mjs';
import { capturePlan } from './plans.mjs';

const PATHS = { home: '/home/operator', repo: '/work/repo' };
const PLANS = '/home/operator/.cursor/katatay-plans';

/** A project with a rulebook naming `dir` as its plans folder. */
function project(dir = PLANS) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-approval-'));
  mkdirSync(join(root, '.katatay'));
  writeFileSync(join(root, '.katatay/rulebook.json'), JSON.stringify({ plans: { dir } }));
  return root;
}

/** Everything `recordBuild` touches, in memory. `files` maps a path to its text and modification time. */
function world({ files = {}, ask = () => ({ answer: 'recorded' }) } = {}) {
  const written = {};
  const asked = [];
  return {
    written, asked,
    read: (path) => {
      if (path in files) return files[path].text;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    write: (path, text) => { written[path] = text; },
    makeFolder: () => {},
    exists: (path) => path in written,
    list: () => Object.keys(files).filter((path) => path.endsWith('.plan.md')),
    modified: (path) => files[path].modified,
    ask: (request) => { asked.push(request); return ask(request); },
    answer: (result) => ({ context: `answered ${JSON.stringify(result)}` }),
  };
}

const TRANSCRIPT = '/home/operator/.cursor/projects/repo/agent-transcripts/t.jsonl';
const saved = (name, body) => `---\nname: ${name}\noverview: o\ntodos:\n  - id: a\n    status: pending\nisProject: false\n---\n\n${body}\n`;

describe('recognising Build', () => {
  it('is the captured prompt, by its first sentence at the start, and nothing else', () => {
    expect(isBuild(payload('before-submit-prompt-build', {}, PATHS).prompt)).toBe(true);
    expect(isBuild(payload('before-submit-prompt', {}, PATHS).prompt)).toBe(false);
    expect(isBuild(payload('before-submit-prompt-followup', {}, PATHS).prompt)).toBe(false);
    expect(isBuild(' Implement the plan as specified, it is attached for your reference.')).toBe(false);
    expect(isBuild('implement the plan as specified, it is attached for your reference.')).toBe(false);
    expect(isBuild(undefined)).toBe(false);
    expect(cursorPlans('/h')).toBe('/h/.cursor/plans');
  });
});

describe('Cursor\'s saved plan files', () => {
  it('reads the captured file\'s name and the text after its frontmatter', () => {
    const { name, body } = savedPlan(capturedPlan());
    expect(name).toBe('Add hello.txt');
    expect(body.startsWith('\n# Add hello.txt\n')).toBe(true);
    expect(body).not.toContain('todos:');
  });

  it('reads quoted names and Windows line ends, and nothing without frontmatter', () => {
    expect(savedPlan('---\nname: "Fix: the gate"\n---\nbody').name).toBe('Fix: the gate');
    expect(savedPlan("---\nname: 'It''s done'\n---\nbody").name).toBe("It's done");
    expect(savedPlan('---\nname: "broken\n---\nbody').name).toBeNull();
    expect(savedPlan('---\r\nname: A\r\n---\r\nbody\r\n')).toEqual({ name: 'A', body: 'body\n' });
    expect(savedPlan('---\noverview: x\n---\nbody')).toEqual({ name: null, body: 'body' });
    expect(savedPlan('# Just a plan')).toBeNull();
    expect(savedPlan('---\nname: A\nno end')).toBeNull();
  });

  it('prefers the newest copy whose text is unchanged, else the newest one, which holds the operator\'s edits', () => {
    const files = {
      '/p/old.plan.md': { text: saved('A', 'proposed'), modified: 1 },
      '/p/edited.plan.md': { text: saved('A', 'proposed, then edited'), modified: 3 },
      '/p/other.plan.md': { text: saved('B', 'proposed'), modified: 9 },
      '/p/empty.plan.md': { text: saved('A', ''), modified: 8 },
      '/p/nofront.plan.md': { text: 'proposed', modified: 7 },
    };
    const w = world({ files });
    expect(matchingSavedPlan({ name: 'A', plan: 'proposed' }, w).path).toBe('/p/old.plan.md');
    expect(matchingSavedPlan({ name: 'A', plan: 'something else' }, w).path).toBe('/p/edited.plan.md');
    expect(matchingSavedPlan({ name: 'A', plan: null }, w).path).toBe('/p/edited.plan.md');
    expect(matchingSavedPlan({ name: 'C', plan: 'proposed' }, w)).toBeNull();
    const unreadable = { ...w, list: () => ['/p/gone.plan.md', '/p/old.plan.md'] };
    expect(matchingSavedPlan({ name: 'A', plan: 'x' }, unreadable).path).toBe('/p/old.plan.md');
  });
});

describe('the plans folder and the new plan file', () => {
  it('reads plans.dir from the rulebook, with ~ and relative paths resolved', () => {
    expect(plansDir(project('~/plans'), '/h')).toEqual({ folder: '/h/plans' });
    expect(plansDir(project('~'), '/h')).toEqual({ folder: '/h' });
    const root = project('plans');
    expect(plansDir(root, '/h')).toEqual({ folder: join(root, 'plans') });
    expect(plansDir(project('/abs'), '/h')).toEqual({ folder: '/abs' });
    expect(plansDir(project(' '), '/h').problem).toBe('.katatay/rulebook.json names no `plans.dir`');
    expect(plansDir('/nowhere', '/h').problem).toMatch(/^\.katatay\/rulebook\.json could not be read \(ENOENT\)$/);
  });

  it('names a new file with three words, drawing again when taken, and numbers it when every draw is', () => {
    const picks = [0, 0, 0, 1, 1, 1];
    const pick = () => picks.shift() ?? 0;
    expect(newPlanFile('/f', { pick, exists: (path) => path === '/f/amber-building-anchor.md' })).toBe('/f/brisk-carving-bridge.md');
    expect(newPlanFile('/f', { pick: () => 0, exists: (path) => path !== '/f/plan-3.md' })).toBe('/f/plan-3.md');
  });

  it('writes a plan tidied, and says why when it cannot', () => {
    const w = world();
    const { file } = savePlan('\n\n# Plan\n\n', project(), PATHS.home, w);
    expect(file.startsWith(`${PLANS}/`)).toBe(true);
    expect(w.written[file]).toBe('# Plan\n');
    expect(tidy('a')).toBe('a\n');
    expect(savePlan('x', '/nowhere', PATHS.home, w).problem).toMatch(/^the plans folder is not known: /);
    const failing = { ...w, write: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } };
    expect(savePlan('x', project(), PATHS.home, failing).problem).toMatch(/^the plan could not be written to .+ \(EACCES\)$/);
  });
});

describe('recording a Build', () => {
  const files = () => ({
    [TRANSCRIPT]: { text: transcript('transcript-build', PATHS), modified: 0 },
    '/home/operator/.cursor/plans/add_hello.txt_0fdd314f.plan.md': { text: capturedPlan(), modified: 2 },
  });

  it('saves the plan Cursor kept, without its frontmatter, to a new file, and asks the referee to record it', () => {
    const w = world({ files: files() });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0].version).toBe(1);
    const text = w.written[w.asked[0].planFile];
    expect(text.startsWith('# Add hello.txt\n\nCreate [hello.txt](hello.txt)')).toBe(true);
    expect(text).not.toContain('todos:');
    expect(out).toEqual({ context: 'answered {"answer":"recorded"}' });
  });

  it('falls back to the proposed text when Cursor\'s copy is missing, and warns that editor edits are not in it', () => {
    const only = { [TRANSCRIPT]: files()[TRANSCRIPT] };
    const w = world({ files: only });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.written[w.asked[0].planFile].startsWith('# Add hello.txt\n')).toBe(true);
    expect(out.context).toBe('answered {"answer":"recorded"}');
    expect(out.warning).toMatch(/^Cursor's saved copy of the plan "Add hello\.txt" was not found in ~\/\.cursor\/plans/);
    expect(out.warning).toContain('Edits made in Cursor\'s plan editor before Build are not in it.');
  });

  it('records nothing, and says why, when the plan cannot be found or written', () => {
    const root = project();
    const run = (transcriptPath, filesNow, rootNow = root) => {
      const w = world({ files: filesNow });
      const out = recordBuild({ transcriptPath, root: rootNow, home: PATHS.home }, w);
      expect(w.asked).toEqual([]);
      expect(out.warning).toBeUndefined();
      return out.context;
    };
    const opening = 'The operator clicked Build, but ';
    const closing = ', so no approval was recorded and the current workflow state is unchanged. Tell the operator.';
    expect(run(undefined, {})).toBe(`${opening}Cursor sent no \`transcript_path\`, and the plan Build approves is named in the conversation's transcript${closing}`);
    expect(run('', {})).toContain('sent no `transcript_path`');
    expect(run(TRANSCRIPT, {})).toBe(`${opening}the transcript ${TRANSCRIPT} could not be read (ENOENT)${closing}`);
    const noPlan = { [TRANSCRIPT]: { text: '{"role":"user","message":{"content":[]}}\n', modified: 0 } };
    expect(run(TRANSCRIPT, noPlan)).toBe(`${opening}this conversation holds no plan proposed with \`CreatePlan\`. Present one in Plan mode first${closing}`);
    const empty = { [TRANSCRIPT]: { text: '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"CreatePlan","input":{}}]}}\n', modified: 0 } };
    expect(run(TRANSCRIPT, empty)).toContain('the newest plan in this conversation has no name and no text');
    const blank = { [TRANSCRIPT]: { text: '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"CreatePlan","input":{"name":"Z","plan":" "}}]}}\n', modified: 0 } };
    expect(run(TRANSCRIPT, blank)).toContain('neither Cursor\'s saved copy nor the transcript holds the text of the plan "Z"');
    expect(run(TRANSCRIPT, files(), '/nowhere')).toMatch(/^The operator clicked Build, but the plans folder is not known: /);
  });

  it('uses the proposed text for a plan with no name', () => {
    const unnamed = { [TRANSCRIPT]: { text: '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"CreatePlan","input":{"plan":"# P"}}]}}\n', modified: 0 } };
    const w = world({ files: unnamed });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.written[w.asked[0].planFile]).toBe('# P\n');
    expect(out.warning).toContain('"without a name"');
  });
});

describe('capturing a plan presented in the turn', () => {
  const turn = '{"role":"user","message":{"content":[]}}\n{"role":"assistant","message":{"content":[{"type":"tool_use","name":"CreatePlan","input":{"name":"A","plan":"# A"}}]}}\n';

  it('saves the turn\'s plan to a new file, and finds none in a turn that proposed none', () => {
    const w = world({ files: { [TRANSCRIPT]: { text: turn, modified: 0 } } });
    const { planFile } = capturePlan({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.written[planFile]).toBe('# A\n');
    const after = world({ files: { [TRANSCRIPT]: { text: `${turn}{"role":"user","message":{"content":[]}}\n`, modified: 0 } } });
    expect(capturePlan({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, after)).toEqual({ planFile: null });
  });

  it('says why when the plan cannot be read or saved', () => {
    expect(capturePlan({ transcriptPath: undefined, root: '/r' }, world()).problem).toBe('Cursor sent no transcript_path, so a plan presented in this turn could not be checked.');
    expect(capturePlan({ transcriptPath: TRANSCRIPT, root: '/r' }, world()).problem)
      .toBe(`The transcript ${TRANSCRIPT} could not be read (ENOENT); a plan presented in this turn could not be checked.`);
    const w = world({ files: { [TRANSCRIPT]: { text: turn, modified: 0 } } });
    expect(capturePlan({ transcriptPath: TRANSCRIPT, root: '/nowhere', home: PATHS.home }, w).problem).toMatch(/^The presented plan could not be checked: the plans folder is not known: .+\.$/);
  });
});

describe('edge cases the mutation run found', () => {
  it('keeps a name with a quote at one end only, and reads an empty quoted name as empty', () => {
    expect(savedPlan("---\nname: plans'\n---\nb").name).toBe("plans'");
    expect(savedPlan("---\nname: 'plans\n---\nb").name).toBe("'plans");
    expect(savedPlan("---\nname: ''\n---\nb").name).toBe('');
    expect(savedPlan("---\nname: '\n---\nb").name).toBe("'");
  });

  it('reads nothing from text that does not open with frontmatter, and takes the name from the frontmatter only', () => {
    expect(savedPlan('intro\n---\nname: A\n---\nbody')).toBeNull();
    expect(savedPlan('---\noverview: x\n---\nname: B\n').name).toBeNull();
  });

  it('draws fifty names before numbering', () => {
    // Every word drawn is taken for the first fifty draws, and free after.
    let draws = 0;
    const exists = (path) => {
      if (path.includes('plan-')) return false;
      draws += 1;
      return draws <= 50;
    };
    const file = newPlanFile('/f', { pick: () => 0, exists });
    expect(draws).toBe(50);
    expect(file).toBe('/f/plan-2.md');
  });

  it('names no plans folder for a rulebook that is null, empty or names a number', () => {
    for (const rulebook of ['null', '{}', '{"plans":{"dir":3}}']) {
      const root = mkdtempSync(join(tmpdir(), 'cursor-rulebook-'));
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, '.katatay/rulebook.json'), rulebook);
      expect(plansDir(root, '/h'), rulebook).toEqual({ problem: '.katatay/rulebook.json names no `plans.dir`' });
    }
  });

  it('makes the plans folder before writing into it', () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'cursor-plans-')), 'not', 'yet');
    const real = { write: (path, text) => writeFileSync(path, text, { flag: 'wx' }), makeFolder: (path) => mkdirSync(path, { recursive: true }) };
    const { file } = savePlan('# Plan', project(folder), PATHS.home, real);
    expect(file.startsWith(`${folder}/`)).toBe(true);
  });

  it('passes the world\'s own view of which names are taken', () => {
    const taken = (path) => path.endsWith('.md') && !path.includes('plan-');
    const { file } = savePlan('# Plan', project(), PATHS.home, { ...world(), exists: taken });
    expect(file).toBe(`${PLANS}/plan-2.md`);
  });

  it('names the file it could not write', () => {
    const failing = { ...world(), write: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } };
    expect(savePlan('x', project(), PATHS.home, failing).problem).toMatch(new RegExp(`^the plan could not be written to ${PLANS}/[a-z]+-[a-z]+-[a-z]+\\.md \\(EACCES\\)$`));
  });

  const plan = (input) => ({ [TRANSCRIPT]: { text: `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CreatePlan', input }] } })}\n`, modified: 0 } });

  it('records a named plan with no text from Cursor\'s saved copy', () => {
    const files = { ...plan({ name: 'A' }), '/home/operator/.cursor/plans/a.plan.md': { text: saved('A', '# Saved'), modified: 1 } };
    const w = world({ files });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.written[w.asked[0].planFile]).toBe('# Saved\n');
    expect(Object.keys(out)).toEqual(['context']);
  });

  it('never matches an unnamed plan to a saved copy without a name', () => {
    const files = { ...plan({ plan: '# P' }), '/home/operator/.cursor/plans/x.plan.md': { text: '---\noverview: o\n---\n\n# Other\n', modified: 1 } };
    const w = world({ files });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.written[w.asked[0].planFile]).toBe('# P\n');
    expect(out.warning).toContain('"without a name"');
  });

  it('records nothing for a named plan with no text and no saved copy', () => {
    const w = world({ files: plan({ name: 'A' }) });
    const out = recordBuild({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w);
    expect(w.asked).toEqual([]);
    expect(out.context).toContain('neither Cursor\'s saved copy nor the transcript holds the text of the plan "A"');
  });

  it('saves nothing for a turn whose plan is only spaces, or for an empty transcript path', () => {
    const turn = { [TRANSCRIPT]: { text: `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CreatePlan', input: { name: 'A', plan: '   ' } }] } })}\n`, modified: 0 } };
    const w = world({ files: turn });
    expect(capturePlan({ transcriptPath: TRANSCRIPT, root: project(), home: PATHS.home }, w)).toEqual({ planFile: null });
    expect(w.written).toEqual({});
    expect(capturePlan({ transcriptPath: '', root: '/r' }, world()).problem).toBe('Cursor sent no transcript_path, so a plan presented in this turn could not be checked.');
  });
});
