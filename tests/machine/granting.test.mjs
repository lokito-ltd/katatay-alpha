/** Getting permission: what plan mode grants, and what it refuses to grant.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ctx, machineFixture, approvedChange, approvePlan, attempt, events, git, hook, phase, planFile, sent, show, triage, publish,
} from '../support/machine/harness.mjs';

machineFixture({ approved: true });

describe('the walk from open to recorded', () => {
  // A memory note changes no code and grants no permission, so the `open`
  // phase lets it through. Claude Code names the folder after the working
  // directory with its separators flattened, so the fixture's own path is
  // flattened the same way here — `exempt.test.mjs` is where the spelling
  // itself is pinned, against a real project path.
  it('lets Claude write its own memory notes before any plan is approved', () => {
    expect(phase()).toBe('open');
    const slug = realpathSync(ctx.repo).replace(/[^A-Za-z0-9]+/g, '-');
    expect(attempt(join(ctx.home, '.claude/projects', slug, 'memory/a-fact.md'))).toBeNull();
  });

  // The logbook is committed and travels to `main` with the branch, so a name used
  // a second time arrives carrying its predecessor's events. Read as live, they
  // would hand the new change a plan nobody approved and a freeze already gone.
  it('grants nothing from a logbook that the target already holds', () => {
    approvedChange();
    triage();
    expect(phase()).toBe('converging');

    git('add', '-A');
    git('commit', '--quiet', '-m', 'the change, logbook and all');
    publish();

    expect(phase()).toBe('open');
    expect(show()).toMatch(/merged\s+2 of them already in origin\/main/);
    const decision = attempt('source.txt');
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('permits editing once the operator approves a plan in plan mode', () => {
    const decision = approvePlan();
    expect(decision.systemMessage).toMatch(/approval recorded/i);
    expect(phase()).toBe('implementing');
    expect(attempt('source.txt')).toBeNull();
  });

  // The operator can edit the plan before approving it, and `tool_response.plan`
  // is what they approved. This case used to pass a draft in `tool_input` and
  // check the draft lost. It could not have been otherwise: Claude Code sends
  // `tool_input: { _targetMode }` and no draft at all, so the losing value was
  // one only the test had ever supplied.
  it('binds the approval to the plan in the response', () => {
    const plan = '# Plan\n\nOnly fix the typo.';
    approvePlan({ plan });
    const approved = JSON.parse(readFileSync(join(ctx.logbook, '0001__plan_approved.json'), 'utf8'));
    expect(approved.payload).not.toHaveProperty('excerpt');
    expect(approved.payload.proposal).toBe(createHash('sha256').update(plan).digest('hex'));
    expect(readFileSync(join(ctx.repo, approved.payload.planSnapshot), 'utf8')).toBe(plan);
    expect(approved.payload).not.toHaveProperty('planFile');
    expect(readFileSync(planFile(), 'utf8')).toBe(plan);
  });

  // Claude Code saves the operator's dialog edits to the plan file (the edited
  // fixture's capture settled it), but the hook does not rely on that: the
  // workflow reads the plan from the file, so the file must hold what the
  // operator approved, and the hook writes it there when it does not.
  it('writes the approved text into the plan file when the file holds the draft', () => {
    const edited = sent('post-tool-use-exit-plan-mode-edited');
    const file = edited.tool_response.filePath;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Fixture plan\n\nChange source.txt.');
    hook('post-tool.mjs', edited);
    expect(readFileSync(file, 'utf8')).toBe(edited.tool_response.plan);
    const approved = JSON.parse(readFileSync(join(ctx.logbook, '0001__plan_approved.json'), 'utf8'));
    expect(approved.payload).not.toHaveProperty('excerpt');
    expect(approved.payload.proposal).toBe(createHash('sha256').update(edited.tool_response.plan).digest('hex'));
    expect(readFileSync(join(ctx.repo, approved.payload.planSnapshot), 'utf8')).toBe(edited.tool_response.plan);
    expect(phase()).toBe('implementing');
  });

  it('records nothing when the approved text cannot be written to the plan file, and says so', () => {
    const decision = hook('post-tool.mjs', sent('post-tool-use-exit-plan-mode', {
      tool_response: { plan: '# Plan', filePath: planFile('gone/a-plan.md') },
    }));
    expect(decision.systemMessage).toMatch(/could not write the approved plan to .*gone\/a-plan\.md \(ENOENT\), so no approval was recorded/);
    expect(events()).toEqual([]);
  });

  // Frontmatter in the text the operator accepted, so the declaration is
  // theirs. Everything downstream — the triage, the turn-end hook, `state:show`
  // — reads it from the logbook rather than from the plan file, which lives outside
  // the repository and can be edited after approval.
  it('records a plan that declares its change test-only', () => {
    approvePlan({ plan: '# Plan\n\nAdd the missing cases.\n\n```workflow\ntest-only: true\n```\n' });
    const approved = JSON.parse(readFileSync(join(ctx.logbook, '0001__plan_approved.json'), 'utf8'));
    expect(approved.payload.testOnly).toBe(true);
  });

  it('records an ordinary plan as not test-only, quoted declaration and all', () => {
    approvePlan({ plan: '# Plan\n\nSee the skill:\n\n```\n---\ntest-only: true\n---\n```\n' });
    const approved = JSON.parse(readFileSync(join(ctx.logbook, '0001__plan_approved.json'), 'utf8'));
    expect(approved.payload.testOnly).toBe(false);
  });

  // What the fixture pins down, stated as a case so that a future Claude Code
  // that starts sending a draft is a red test rather than a silent question.
  it('is sent no plan draft to bind to by mistake', () => {
    const real = sent('post-tool-use-exit-plan-mode');
    expect(real.tool_input).toEqual({ _targetMode: 'default' });
    expect(Object.keys(real.tool_response).sort()).toEqual(['filePath', 'isAgent', 'plan']);
  });

  // The failure that broke plan mode: the plan file could not be written, and
  // Claude Code reported the approval with no plan in it. An approval of
  // nothing grants nothing, and says so, rather than leaving the operator
  // wondering why edits are still refused.
  it('records nothing when Claude Code sends no plan text, and says so', () => {
    const decision = approvePlan({ plan: null });
    expect(decision.systemMessage).toMatch(/no approval was recorded/);
    expect(events()).toEqual([]);
    expect(phase()).toBe('open');
  });

  it('records a revised plan approved later, which replaces the earlier one', () => {
    approvePlan({ file: planFile('first.md') });
    const decision = approvePlan({ plan: '# Plan\n\nRevised.', file: planFile('second.md') });
    expect(decision.systemMessage).toMatch(/replaces the earlier/);
    expect(events()).toEqual(['0001__plan_approved.json', '0002__plan_approved.json']);
    const revision = JSON.parse(readFileSync(join(ctx.logbook, events().at(-1)), 'utf8')).payload;
    expect(show()).toContain(revision.planSnapshot);
    expect(decision.systemMessage).toContain(revision.planSnapshot);
    expect(phase()).toBe('implementing');
  });
});
