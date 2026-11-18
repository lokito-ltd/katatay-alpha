import { describe, expect, it } from 'vitest';
import { LOCKED, PLANS_FOLDER, proposal } from './proposal.mjs';
import { hookRegistration } from './registration.mjs';

describe('what the Codex adapter proposes', () => {
  it('locks Codex\'s own config, and the transcripts a plan is approved from', () => {
    expect(LOCKED).toEqual(['.codex/**', '~/.codex/config.toml', '~/.codex/hooks.json', '~/.codex/sessions/**']);
  });

  it('proposes the folder, the instructions file and its own commands', () => {
    const answer = proposal();
    expect(answer.version).toBe(1);
    expect(answer.locked).toEqual(LOCKED);
    expect(answer.plansFolder).toBe(PLANS_FOLDER);
    expect(PLANS_FOLDER).toBe('~/.codex/plans');
    expect(answer.instructions).toBe('AGENTS.md');
    expect(answer.commands).toEqual({ check: 'node src/agents/codex/check.mjs', install: 'node src/agents/codex/install.mjs' });
  });

  // `check` measures against the same list, so it finds nothing wrong with this.
  it('registers the hooks `check` measures against, and says what only the operator can do', () => {
    const { registration } = proposal();
    expect(registration.file).toBe('.codex/hooks.json');
    expect(JSON.parse(registration.text)).toEqual(hookRegistration());
    expect(registration.steps.join('\n')).toMatch(/trust the project/);
    expect(registration.steps.join('\n')).toMatch(/`\/hooks`/);
  });

  // A caller that edits its copy must not change the next answer.
  it('gives a fresh list each time', () => {
    proposal().locked.push('x');
    expect(proposal().locked).toEqual(LOCKED);
  });
});
