import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPECTED, registrationProblems } from './registration.mjs';
import { proposal } from './proposal.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';

/** The machine-readable half of the agent contract. */
const contract = JSON.parse(readFileSync(new URL('../contract.json', import.meta.url), 'utf8'));
const ANSWER = contract.schemas.DefaultsAnswer;

describe('what the Claude adapter proposes', () => {
  it('has exactly the fields the contract\'s defaults answer requires', () => {
    expect(Object.keys(proposal()).sort()).toEqual([...ANSWER.required].sort());
    expect(Object.keys(proposal().registration).sort()).toEqual([...ANSWER.properties.registration.required].sort());
  });

  it('answers with the contract\'s version', () => {
    expect(proposal().version).toBe(contract.version);
  });

  it('names the instructions file the install command writes and the check looks for', () => {
    expect(proposal().instructions).toBe(INSTRUCTIONS_FILE);
  });

  it('matches the contract\'s example answer in everything but the registration text', () => {
    const { registration, ...rest } = contract.commands.defaults.examples[0].stdout;
    const { registration: proposed, ...mine } = proposal();
    expect(mine).toEqual(rest);
    expect(proposed.file).toBe(registration.file);
    expect(proposed.steps).toEqual(registration.steps);
  });

  it('proposes a hook registration the check finds nothing wrong with', () => {
    const { registration } = proposal();
    expect(registration.file).toBe('.claude/settings.json');
    expect(registrationProblems(JSON.parse(registration.text))).toEqual([]);
  });

  it('registers every workflow hook once, and nothing else', () => {
    const { hooks } = JSON.parse(proposal().registration.text);
    const commands = Object.entries(hooks).flatMap(([event, entries]) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => `${event} ${hook.command}`)));
    expect(commands).toEqual(EXPECTED.map(({ event, command }) => `${event} node ${command}`));
  });

  it('gives a matcher only to the hooks that need one, and a timeout only where one is expected', () => {
    const { hooks } = JSON.parse(proposal().registration.text);
    expect(hooks.UserPromptSubmit[0]).not.toHaveProperty('matcher');
    expect(hooks.PreToolUse[0].hooks[0]).not.toHaveProperty('timeout');
    expect(hooks.Stop[0].hooks[0].timeout).toBe(900);
  });

  it('hands out a fresh list each time, so a caller cannot change the next answer', () => {
    proposal().locked.push('changed');
    expect(proposal().locked).not.toContain('changed');
  });
});
