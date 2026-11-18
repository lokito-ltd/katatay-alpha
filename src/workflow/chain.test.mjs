import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verified, triaged } from '../../tests/fixtures/workflow/events.mjs';
import { append, canonical, currentBranch, hashPayload, readChain, slugFor } from './chain.mjs';

let root;
let dir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workflow-'));
  dir = join(root, 'state', 'branch');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the event chain', () => {
  it('reads back what it appended, in order', () => {
    append(dir, 'reset', { note: 'a' }, 'branch');
    append(dir, 'verified', verified(), 'branch');

    const { entries, broken } = readChain(dir, 'branch');
    expect(broken).toBeNull();
    expect(entries.map((e) => e.event)).toEqual(['reset', 'verified']);
    expect(entries[0].prev).toBeNull();
    expect(entries[1].prev).toEqual(expect.any(String));
  });

  it('accepts an analysis prepared at the current end of the chain', () => {
    append(dir, 'verified', verified(), 'branch');
    const payload = { verification: 1, summary: 'Accepted.', analysisSnapshot: `.katatay/local/branch/checks-analysis/20261105T000000.000Z_${'a'.repeat(43)}.txt` };
    append(dir, 'checks_analysis', payload, 'branch', 1);
    const chain = readChain(dir, 'branch');
    expect(chain.broken).toBeNull();
    expect(chain.entries.at(-1)).toMatchObject({ seq: 2, event: 'checks_analysis', payload });
  });

  it('refuses a submission prepared before another event was appended', () => {
    append(dir, 'verified', verified(), 'branch');
    append(dir, 'reset', { note: null }, 'branch');
    expect(() => append(dir, 'checks_analysis', { verification: 1, summary: 'Stale', analysisSnapshot: `.katatay/local/branch/checks-analysis/20261105T000000.000Z_${'a'.repeat(43)}.txt` }, 'branch', 1)).toThrow('logbook changed');
    expect(readChain(dir, 'branch').entries.map(e => e.event)).toEqual(['verified', 'reset']);
  });

  it('treats an empty logbook as a valid empty chain', () => {
    expect(readChain(dir, 'branch')).toEqual({ entries: [], broken: null });
  });

  it('detects an event edited after the fact', () => {
    append(dir, 'reset', { note: 'a' }, 'branch');
    append(dir, 'verified', verified(), 'branch');

    writeFileSync(join(dir, '0001__reset.json'),
      JSON.stringify({ version: 1, seq: 1, prev: null, ts: new Date().toISOString(), event: 'reset', payload: { note: 'forged' }, branch: 'branch' }, null, 2) + '\n');

    expect(readChain(dir, 'branch').broken).toMatch(/does not link to the event before it/);
  });

  it('detects an event removed from the middle', () => {
    append(dir, 'reset', { note: null }, 'branch');
    append(dir, 'verified', verified(), 'branch');
    append(dir, 'verified', verified({ treeFingerprint: 'b'.repeat(64) }), 'branch');

    unlinkSync(join(dir, '0002__verified.json'));

    expect(readChain(dir, 'branch').broken).toMatch(/claims seq 3, but it is entry 2/);
  });

  it('refuses to append over an existing event file', () => {
    append(dir, 'verified', verified(), 'branch');
    // A second event whose name would collide with the first.
    writeFileSync(join(dir, '0002__verified.json'),
      JSON.stringify({ seq: 2, prev: 'wrong', ts: 'x', event: 'verified', payload: {} }) + '\n');

    expect(() => append(dir, 'verified', verified({ treeFingerprint: 'b'.repeat(64) }), 'branch')).toThrow(/broken chain/);
  });

  it('refuses to append to a chain that no longer links up', () => {
    append(dir, 'reset', { note: null }, 'branch');
    append(dir, 'verified', verified(), 'branch');
    writeFileSync(join(dir, '0001__reset.json'),
      '{"seq":1,"prev":null,"ts":"x","event":"reset","payload":{"proposal":"forged"},"branch":"branch"}\n');

    expect(() => append(dir, 'verified', verified({ treeFingerprint: 'b'.repeat(64) }), 'branch')).toThrow(/broken chain/);
  });

  // Recorded as a limit, not a bug. The chain catches a rewrite that did not
  // recompute forward, and nothing else: the hash is not a secret, and the
  // genesis event has no predecessor to link to. What makes this visible is
  // `alteredStateFiles` holding the logbook against git. Hashing cannot.
  it('does NOT catch a rewritten genesis event on its own', () => {
    append(dir, 'verified', verified(), 'branch');
    writeFileSync(join(dir, '0001__verified.json'),
      JSON.stringify({ version: 1, seq: 1, prev: null, ts: new Date().toISOString(), event: 'verified', payload: verified({ treeFingerprint: 'c'.repeat(64) }), branch: 'branch' }));

    expect(readChain(dir, 'branch').broken).toBeNull();
  });

  it('rejects an unknown event type rather than storing it', () => {
    expect(() => append(dir, 'merged', {}, 'branch')).toThrow(/unknown event type/);
  });

  // An event type the chain does not know is refused on the way in, and one
  // that reached the logbook anyway would read as tampering and break every later
  // fold. The triage events have to be here for the phase to exist at all.
  it('knows the triage events, so recording one does not read as tampering', () => {
    append(dir, 'triaged', triaged(), 'branch');
    append(dir, 'triage_refused', { reason: 'tests_modified', files: ['test.ts'] }, 'branch');

    const { entries, broken } = readChain(dir, 'branch');
    expect(broken).toBeNull();
    expect(entries.map((e) => e.event)).toEqual(['triaged', 'triage_refused']);
  });

  it('notices when two branch names collide on one directory', () => {
    dir = join(root, 'state', 'feat_x');
    append(dir, 'reset', { note: null }, 'feat/x');
    expect(readChain(dir, 'feat_x').broken).toMatch(/belongs to branch feat\/x/);
  });

  // `readdirSync` throws `ENOTDIR` on a file. That used to reach the caller,
  // so `state:show` and `state:verify` crashed, and the gate allowed the edit
  // it could not judge.
  describe('with a file where the logbook folder should be', () => {
    const asFile = () => {
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, 'not a folder\n');
    };

    it('reads as a broken logbook, and says what is in the way', () => {
      asFile();
      const { entries, broken } = readChain(dir, 'branch');
      expect(entries).toEqual([]);
      expect(broken).toMatch(/cannot be read as a folder \(ENOTDIR\)/);
      expect(broken).toContain(dir);
    });

    it('refuses to append, so nothing is recorded into it', () => {
      asFile();
      expect(() => append(dir, 'verified', {}, 'branch')).toThrow(/broken chain/);
    });
  });

  it('slugs a branch name into something a directory can be called', () => {
    expect(slugFor('feat/state-machine')).toBe('feat_state-machine');
  });
});

describe('payload hashing', () => {
  it('does not depend on key order', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('distinguishes payloads that differ', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it('canonicalises nested structures', () => {
    expect(canonical({ b: [2, { d: 4, c: 3 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":3,"d":4}]}');
  });
});

// No commit yet means no branch name git will give, and `currentBranch` throws.
// Callers that expect that catch it; the others let it reach the operator.
describe('the current branch on a repository with no commit yet', () => {
  const inEmptyRepo = (run) => {
    const cwd = process.cwd();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    process.chdir(root);
    try {
      return run();
    } finally {
      process.chdir(cwd);
    }
  };

  it("throws with git's own message, so an operator who sees it knows why", () => {
    expect(() => inEmptyRepo(currentBranch)).toThrow(/ambiguous argument 'HEAD'/);
  });

  it('prints nothing while it fails', () => {
    const noise = [];
    const real = process.stderr.write;
    process.stderr.write = function (chunk, ...rest) { noise.push(String(chunk)); return real.call(this, chunk, ...rest); };
    try {
      inEmptyRepo(() => { try { currentBranch(); } catch { /* the failure is expected */ } });
    } finally {
      process.stderr.write = real;
    }
    expect(noise.join('')).toBe('');
  });
});
