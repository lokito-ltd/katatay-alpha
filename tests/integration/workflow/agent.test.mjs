import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDefaults, agentWarnings } from '../../../src/workflow/agent.mjs';
import { writeConfig } from '../../fixtures/workflow/adapter.mjs';

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

// No answer is never a pass. Each of these would otherwise read as a clean
// report, and the operator would not hear that the check stopped working.
describe('a check that gives no answer', () => {
  const noAnswer = (warnings) => {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^local: the agent check \(`node check\.mjs`\) gave no answer: /);
    expect(warnings[0]).toMatch(/Nothing was concluded from it, so the agent's setup is unchecked\.$/);
    return warnings[0];
  };

  it('running past the backstop is one warning that says how long it waited', () => {
    checkedBy('setTimeout(() => {}, 60000);');
    expect(noAnswer(agentWarnings(root, { backstop: 1 }))).toContain('still running after 1 seconds');
  });
});

describe('several named agents', () => {
  const configure = (adapters) => writeConfig(root, { fields: { agent: { lockedPaths: [], adapters } } });
  const entry = (script) => {
    writeFileSync(join(root, 'healthy.mjs'), script);
    return { checkCommand: 'node healthy.mjs' };
  };

  it.each([['timed out', 'setTimeout(() => {}, 60000);', 'after 1 seconds']])('continues after a check %s', (_kind, script, problem) => {
    writeFileSync(join(root, 'bad.mjs'), script);
    configure({ broken: { checkCommand: 'node bad.mjs' }, healthy: entry(answering('["still checked"]')) });
    const warnings = agentWarnings(root, { backstop: 1 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^broken: the agent check/);
    expect(warnings[0]).toContain(problem);
    expect(warnings[1]).toBe('healthy: still checked');
  });
});

// `init` asks the adapter's defaults before any rulebook exists, so the command
// line is handed in. The real Claude command is started as a command line, never
// imported: the referee knows no agent.
describe('asking the agent adapter for its defaults', () => {

  // No answer is never a pass, and half a proposal is no answer: a draft
  // rulebook with the agent's locks missing would look complete.
  describe('gives no proposal at all when the command', () => {
    const none = (result, why) => {
      expect(Object.keys(result)).toEqual(['none']);
      expect(result.none).toMatch(/^the agent's defaults \(`node defaults\.mjs`\) gave no answer: /);
      expect(result.none).toContain(why);
    };

    it('runs past the backstop', () => {
      writeFileSync(join(root, 'defaults.mjs'), 'setTimeout(() => {}, 60_000);');
      none(agentDefaults('node defaults.mjs', root, { backstop: 1 }), 'still running after 1 seconds');
    });
  });
});
