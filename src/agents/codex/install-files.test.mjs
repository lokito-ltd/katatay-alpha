import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { INSTRUCTIONS_FILE, SKILL_WORDS, installFiles, skillFile } from './install-files.mjs';

const REQUEST = {
  instructions: '# The workflow\n\nThe rules.\n\n',
  skills: [
    { name: 'plan-change', description: 'Produce a bounded change plan.', prompt: '# Planning\n\nPresent it.\n' },
    { name: 'brand-new', description: 'Something: with a colon, and # a hash.', prompt: '# New\n' },
  ],
};

// Built inside each test, never when the file loads: a mutation tool switches
// a mutant on per test, so files built at load time would never meet one.
const at = (path) => installFiles(REQUEST).find((file) => file.path === path)?.text;

describe('what the Codex adapter installs', () => {
  it('puts the instructions in AGENTS.md, and each skill where Codex finds a repository\'s skills', () => {
    expect(installFiles(REQUEST).map(({ path }) => path)).toEqual([INSTRUCTIONS_FILE, '.agents/skills/plan-change/SKILL.md', '.agents/skills/brand-new/SKILL.md']);
    expect(INSTRUCTIONS_FILE).toBe('AGENTS.md');
    expect(skillFile('x')).toBe('.agents/skills/x/SKILL.md');
  });

  it('keeps the referee\'s instructions first, then adds what only Codex needs', () => {
    const text = at(INSTRUCTIONS_FILE);
    expect(text.startsWith('# The workflow\n\nThe rules.\n\n## In Codex\n')).toBe(true);
    for (const word of ['UserPromptSubmit', 'PreToolUse', 'apply_patch', 'Stop', 'Plan mode', '<proposed_plan>', 'Yes, implement this plan',
      'Yes, clear context and implement', '/hooks', 'allow_managed_hooks_only', '~/.codex/sessions/', 'bypassPermissions']) {
      expect(text, word).toContain(word);
    }
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('names every skill it was given, with its description', () => {
    expect(at(INSTRUCTIONS_FILE)).toContain('\n- `plan-change`: Produce a bounded change plan.\n- `brand-new`: Something: with a colon, and # a hash.\n');
  });

  it('ends with a visible triage reply and resumes convergence from Stop', () => {
    const text = at(INSTRUCTIONS_FILE).replace(/\s+/g, ' ');
    expect(text).toContain('Run triage in a separate tool call.');
    expect(text).toContain('end the turn before editing.');
    expect(text).toContain('Start that final reply with **Triage recorded** on its own line');
    expect(text).toContain('copy the summary it prints verbatim into a plain-text code block, its link included.');
    expect(text).not.toContain('full report verbatim');
    expect(text).toContain('Unless a revision is pending, the Stop hook then asks you to resume.');
    expect(text).toContain('request a revision before asking for Plan mode');
  });

  it('calls capture and unreadable plans warnings and preserves the turn end work', () => {
    for (const path of [INSTRUCTIONS_FILE, skillFile('plan-change')]) {
      const text = at(path);
      expect(text).toContain('Capture problems and an unreadable or misplaced plan file are warnings');
      expect(text).toContain("the referee still does the turn end's other work");
      expect(text).toContain('approval does not depend on the check');
    }
  });

  it('documents embedded approvals and the latest-plan fallback in both installed prompts', () => {
    for (const path of [INSTRUCTIONS_FILE, skillFile('plan-change')]) {
      expect(at(path)).toContain('PLEASE IMPLEMENT THIS PLAN:');
      expect(at(path)).toContain('even after intervening discussion');
      expect(at(path)).toContain('identical content preserves the current phase');
    }
  });

  it('gives each skill the frontmatter Codex reads, with the name and description carried over', () => {
    for (const { name, description } of REQUEST.skills) {
      const { data } = matter(at(skillFile(name)));
      expect(data).toEqual({ name, description });
    }
  });

  it('adds Codex\'s words to the plan skill, and leaves a skill it has none for as the referee wrote it', () => {
    expect(at(skillFile('plan-change'))).toContain(`Present it.\n\n${SKILL_WORDS['plan-change'].trimEnd()}\n`);
    expect(SKILL_WORDS['plan-change']).toMatch(/<proposed_plan>/);
    expect(at(skillFile('brand-new')).endsWith('---\n\n# New\n')).toBe(true);
  });

  // A project has no copy of the harness.
  it('points nothing it installs into src/', () => {
    for (const { text } of installFiles(REQUEST)) expect(text).not.toMatch(/src\//);
  });
});
