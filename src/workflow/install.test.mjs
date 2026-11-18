import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTemplate, templateGuidance } from './plan-format.mjs';
import { INSTRUCTIONS, SKILL_NAME, installRequest, readInstructions, readSkills } from './install.mjs';
import { installFiles as claudeFiles } from '../agents/claude/install-files.mjs';
import { installFiles as codexFiles } from '../agents/codex/install-files.mjs';

let folder;
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-skills-')));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const skill = (file, text) => writeFileSync(join(folder, file), text);
const refused = () => {
  try {
    readSkills(folder);
  } catch (error) {
    return error.message;
  }
  return null;
};

describe('the harness support skills', () => {
  it('are the three the referee ships, each with a description and a prompt', () => {
    const skills = readSkills();
    expect(skills.map(({ name }) => name)).toEqual(['author-acs', 'commit-message', 'plan-change']);
    for (const { name, description, prompt } of skills) {
      expect(description.length, name).toBeGreaterThan(20);
      expect(prompt, name).toMatch(/^# /);
    }
  });

  it('are read as their frontmatter and the text after it, in name order', () => {
    skill('b-two.md', '---\nname: b-two\ndescription: Second.\n---\n\n# Two\n\nBody.\n\n\n');
    skill('a-one.md', '---\nname: a-one\ndescription: "  First: quoted.  "\n---\n# One\n');
    skill('notes.txt', 'not a skill');
    expect(readSkills(folder)).toEqual([
      { name: 'a-one', description: 'First: quoted.', prompt: '# One\n' },
      { name: 'b-two', description: 'Second.', prompt: '# Two\n\nBody.\n' },
    ]);
  });

  it('refuse a skill with no name', () => {
    skill('a.md', '---\ndescription: D.\n---\n\n# A\n');
    expect(refused()).toMatch(/a\.md cannot be installed: it has no `name` in its frontmatter\.$/);
  });

  it('refuse a skill whose name is not its file\'s', () => {
    skill('a.md', '---\nname: b\ndescription: D.\n---\n\n# A\n');
    expect(refused()).toContain('its `name` is "b", not "a" as its file is named');
  });

  it('refuse a skill with no description, or an empty one', () => {
    skill('a.md', '---\nname: a\n---\n\n# A\n');
    expect(refused()).toContain('it has no `description` in its frontmatter');
    skill('a.md', '---\nname: a\ndescription: "  "\n---\n\n# A\n');
    expect(refused()).toContain('it has no `description` in its frontmatter');
  });

  it('refuse a file whose name an adapter could not build a path from', () => {
    skill('Plan Change.md', '---\nname: Plan Change\ndescription: D.\n---\n\n# A\n');
    expect(refused()).toContain('its file name is not a skill name');
    expect(SKILL_NAME.test('plan-change')).toBe(true);
    expect(SKILL_NAME.test('../x')).toBe(false);
    expect(SKILL_NAME.test('-x')).toBe(false);
  });

  it('read only YAML frontmatter, never code', () => {
    skill('a.md', '---js\n({ name: "a", description: "D." })\n---\n\n# A\n');
    expect(refused()).toContain('only YAML frontmatter is read');
  });
});

describe('the install request', () => {
  it('keeps the installed instructions and skills in sync with both adapters', () => {
    const request = installRequest();
    for (const { path, text } of [...claudeFiles(request), ...codexFiles(request)]) {
      const installed = readFileSync(path, 'utf8');
      // The repository prefixes the generated workflow with a blockquote pointing at CLAUDE.md.
      const workflow = path === 'AGENTS.md' ? installed.replace(/^(?:>[^\n]*\n)+\n/, '') : installed;
      const expected = path === 'AGENTS.md' ? `<!-- workflow: begin -->\n${text}<!-- workflow: end -->\n` : text;
      expect(workflow, path).toBe(expected);
    }
  });

  it('keeps the shared instructions and complete Codex file within their byte limits', () => {
    expect(readFileSync(INSTRUCTIONS).byteLength).toBeLessThanOrEqual(26_000);
    expect(readFileSync('AGENTS.md').byteLength).toBeLessThanOrEqual(32_768);
  });

  it('tells agents to read the approved snapshot and present revisions as new plan files', () => {
    const instructions = readInstructions();
    expect(instructions).toContain('Read the approved plan from the snapshot named in the state summary.');
    expect(instructions).toContain('The working file has no force after approval');
    expect(instructions).toContain('restore its exact approved bytes at the recorded path');
    expect(instructions).toContain('Write a revision as a new plan file in the plans folder and present it for approval.');
    expect(instructions).toContain('Never edit the approved snapshot into a revision');
  });

  it('carries the instructions as they are, and the skills as read', () => {
    expect(readInstructions()).toBe(readFileSync(INSTRUCTIONS, 'utf8').replace('<!-- PLAN_TEMPLATE -->', templateGuidance()));
    expect(readInstructions()).toContain(planTemplate());
    expect(readSkills().find((s) => s.name === 'plan-change').prompt).toContain(planTemplate());
    expect(readInstructions()).not.toContain('<!-- PLAN_TEMPLATE -->');
    expect(installRequest()).toEqual({ instructions: readInstructions(), skills: readSkills() });
  });

  it('reads from where it is told', () => {
    mkdirSync(join(folder, 'skills'));
    writeFileSync(join(folder, 'skills/x.md'), '---\nname: x\ndescription: X.\n---\n\n# X\n');
    writeFileSync(join(folder, 'I.md'), '# Elsewhere\n');
    expect(installRequest({ instructions: join(folder, 'I.md'), skills: join(folder, 'skills') })).toEqual({
      instructions: '# Elsewhere\n',
      skills: [{ name: 'x', description: 'X.', prompt: '# X\n' }],
    });
  });

  it('describes sending a presented plan as a courtesy in every installed copy', () => {
    for (const file of ['AGENTS.md', '.agents/skills/plan-change/SKILL.md',
      '.claude/rules/workflow.md', '.claude/skills/plan-change/SKILL.md']) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).toContain('agent adapters should send `planFile`');
      expect(text, file).toContain('approval does not depend on it');
      expect(text, file).toContain('never replace the freeze check, verification, mutation or recording');
      expect(text, file).not.toContain('At turn end, a presented plan is checked by the referee');
    }
    expect(readFileSync('AGENTS.md', 'utf8')).toMatch(/^> \*\*This project's own instructions are in `CLAUDE.md`/);
  });
});
