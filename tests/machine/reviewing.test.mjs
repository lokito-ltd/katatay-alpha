/** Where review should look, said before the operator types `record`.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, machineFixture, approvedChange, setCoverage, show, stop, triage, userSettings } from '../support/machine/harness.mjs';

machineFixture({ approved: true });

/**
 * `workflow verify` prints the settings warnings, and the `Stop` hook throws
 * that output away when it passes. So they ride with the message that says
 * verification passed, which is what the operator reads before typing
 * `record`.
 */
describe('the settings warnings, once verification has passed', () => {
  const stranger = { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'approve.sh' }] }] } };

  it('appear when verification passes and again on the next verified turn', () => {
    approvedChange();
    userSettings(stranger);
    triage();
    const { reason } = stop();
    // Under Warnings, wrapped; its words are what matter here.
    expect(reason).toMatch(/Verification passed\.\n[\s\S]*\nWarnings:\nsettings: claude: /);
    expect(reason.replace(/\n/g, ' ')).toContain('settings: claude: ~/.claude/settings.json registers an extra PermissionRequest hook: `approve.sh`.');
    expect(reason.replace(/\n/g, ' ')).toContain('can answer the plan dialog');
    expect(stop().systemMessage).toMatch(/Verification passed on this working tree[\s\S]*settings: [^\n]*approve\.sh/);
  });

  it('are left out when there are none', () => {
    approvedChange();
    triage();
    expect(stop().reason).not.toMatch(/^settings: /m);
  });
});

/**
 * Where review should look, said before the operator types `record` and not
 * only later in the commit message. The same list in both places, from the
 * same function, so they cannot disagree. The acceptance tests in
 * tests/acceptance/areas/ cover the cases AC0064 and AC0065 name; these are the
 * ones that reach the list through the Claude Stop hook and state show.
 */
describe('the review areas', () => {
  it('say nothing when there is nothing to look at', () => {
    approvedChange();
    triage();
    expect(stop().reason).not.toMatch(/Where review should look/);
    expect(show()).not.toMatch(/^review/m);
  });

  /**
   * A coverage ignore comment takes code out of the coverage figure. The file
   * that gains one is product code, which no path rule lists, so each place the
   * areas are shown has to ask for these files itself. One case per place,
   * because a caller that stopped asking would otherwise show a shorter list
   * and nothing would say it was shorter.
   */
  describe('name a file that gains a coverage ignore comment', () => {
    const REASON = 'New coverage ignore comments. Each takes code out of the figure.';
    /**
     * Coverage switched on in the fixture, with this repository's ignore
     * patterns. The patterns are the coverage entry's, and a project with
     * coverage switched off has none, so the fixture's default "none" would
     * list nothing. The report is one the coverage check passes on.
     */
    const coverageOn = () => setCoverage({ 'modules/thing.ts': { total: 2, uncovered: [] } });
    const ignoring = () => {
      coverageOn();
      mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
      writeFileSync(join(ctx.repo, 'modules/thing.ts'), 'export const a = 1;\n/* v8 ignore next */\nexport const b = () => 2;\n');
    };

    it('in the message that says verification passed', () => {
      approvedChange();
      ignoring();
      triage();
      const { reason } = stop();
      expect(reason).toMatch(/Verification passed\.\n[\s\S]*\nReview:\n/);
      expect(reason).toContain(REASON);
      expect(reason).toContain('- modules/thing.ts');
    });

    it('in state:show', () => {
      approvedChange();
      ignoring();
      triage();
      expect(show()).toContain(REASON);
      expect(show()).toContain('- modules/thing.ts');
    });

  });
});
