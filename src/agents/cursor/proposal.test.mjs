import { expect, it } from 'vitest';
import { HARNESS_ROOT, hookRegistration } from './registration.mjs';
import { LOCKED, PLANS_FOLDER, proposal } from './proposal.mjs';

it('proposes Cursor\'s locks, its own plans folder, its rule file, its commands and its hook registration', () => {
  const answer = proposal(HARNESS_ROOT);
  expect(answer.version).toBe(1);
  expect(answer.locked).toEqual(['.cursor/hooks.json', '.cursor/hooks/**', '~/.cursor/hooks.json', '~/.cursor/plans/**', '~/.cursor/projects/**']);
  expect(answer.locked).not.toBe(LOCKED);
  expect(answer.plansFolder).toBe('~/.cursor/katatay-plans');
  expect(PLANS_FOLDER).toBe('~/.cursor/katatay-plans');
  expect(answer.instructions).toBe('.cursor/rules/workflow.mdc');
  expect(answer.commands).toEqual({ check: 'node src/agents/cursor/check.mjs', install: 'node src/agents/cursor/install.mjs' });
  expect(answer.registration.file).toBe('.cursor/hooks.json');
  expect(JSON.parse(answer.registration.text)).toEqual(hookRegistration(HARNESS_ROOT));
  expect(answer.registration.text.endsWith('}\n')).toBe(true);
  expect(answer.registration.steps).toHaveLength(3);
  expect(answer.registration.steps.join(' ')).toMatch(/trust the workspace/);
});

it('says each step for the operator in full', () => {
  expect(proposal(HARNESS_ROOT).registration.steps).toEqual([
    'Check the hooks merged into .cursor/hooks.json. The file is locked, so a session cannot change them.',
    'Open the project in Cursor and trust the workspace when Cursor asks. Cursor runs no project hook in an untrusted workspace.',
    'Open the Hooks tab in Cursor\'s settings and check that the three workflow hooks are listed with no errors.',
  ]);
});
