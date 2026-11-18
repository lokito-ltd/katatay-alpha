/**
 * The referee says nothing in any agent's words.
 *
 * The referee is meant to run under any agent, so its messages say what to do
 * in words every agent can follow: "present a plan", "write the commit
 * message". How that is done is the agent adapter's to add, by the message's
 * code (see "One answer shape" in `src/agents/README.md`). Before the agent
 * adapters were split out, the gate told every agent to call `EnterPlanMode`
 * and the record step named the `commit-message` skill, so a Codex session
 * would have been sent to tools it does not have.
 *
 * `language-free.test.mjs` does the same for tool names. Comments are left out
 * here too: a comment that explains how the Claude adapter delivers a report
 * says nothing to an agent.
 *
 * "hook" is not on the list. Both agents the harness plans for have hooks, and
 * the word says nothing about which one is running.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { code, referee, withoutComments } from '../../tests/fixtures/workflow/referee-code.mjs';
import { INSTRUCTIONS, SKILLS, readSkills } from './install.mjs';

/** Words that belong to one agent: its tools, its folders, its name. */
const AGENT_ONLY = /EnterPlanMode|ExitPlanMode|\bClaude\b|\bCodex\b|\bplan[- ]mode\b|\bmemory notes?\b|\.claude\b|\.codex\b|\bAGENTS\.md\b/i;

/** The same, with skills: a message that sends the agent to a skill would
 *  make the referee depend on one. */
const AGENT_WORDS = new RegExp(`${AGENT_ONLY.source}|\\bskills?\\b`, 'i');

/**
 * The files that may name skills, and why. The referee ships the harness
 * support skills, so the file that reads them has to say the word. Its
 * messages still say nothing in any agent's words.
 */
const MAY_NAME_SKILLS = {
  'workflow/install.mjs': 'the one file that reads the harness support skills, to hand them to an adapter',
};

/** Each match in `text`, with its file and line, so a failure says where to look. */
const matchesIn = (path, text, words) =>
  text.split('\n').flatMap((line, i) => {
    const found = line.match(words);
    return found ? [`${path}:${i + 1} ${found[0]}`] : [];
  });

const agentWordsIn = (path) => matchesIn(path, code(path), path in MAY_NAME_SKILLS ? AGENT_ONLY : AGENT_WORDS);

describe('the referee', () => {
  it('names no agent\'s tools, skills or folders in its code', () => {
    expect(referee().flatMap(agentWordsIn)).toEqual([]);
  });

  it('names skills only where it reads them, and only files that exist name them', () => {
    expect(referee()).toEqual(expect.arrayContaining(Object.keys(MAY_NAME_SKILLS)));
    expect(AGENT_WORDS.test(withoutComments("const a = 'the skills';"))).toBe(true);
    expect(AGENT_ONLY.test(withoutComments("const a = 'the skills';"))).toBe(false);
  });

  // Prose, so nothing is left out as a comment.
  it('names no agent\'s tools, skills or folders in the instructions it ships', () => {
    expect(matchesIn('workflow/INSTRUCTIONS.md', readFileSync(INSTRUCTIONS, 'utf8'), AGENT_WORDS)).toEqual([]);
  });

  it('names no agent\'s tools or folders in the harness support skills', () => {
    const skills = readSkills();
    expect(skills.map(({ name }) => name)).toEqual(['author-acs', 'commit-message', 'plan-change']);
    expect(skills.flatMap(({ name, description, prompt }) =>
      matchesIn(`${SKILLS}/${name}.md`, `${description}\n${prompt}`, AGENT_ONLY))).toEqual([]);
  });

  // Without these, a pattern that matched nothing, or a walk that found
  // nothing, would pass on every tree.
  it('is found by the check above, and the check finds what it looks for', () => {
    expect(referee()).toEqual(expect.arrayContaining([
      'workflow/hooks/gate.mjs', 'workflow/moments/turn-end.mjs', 'workflow/phase.mjs', 'workflow/state.mjs',
      'workflow/rulebook.mjs', 'workflow/cli/triage.ts', 'requirements/guard.ts', 'requirements/renumber.ts',
    ]));
    for (const said of [
      "'Switch into plan mode (EnterPlanMode).'",
      "'present it with ExitPlanMode'",
      "'the plan-mode dialog'",
      "`Write it with the \\`commit-message\\` skill.`",
      "'Ask Claude for the commit message.'",
      "'Ask Codex.'",
      "'your memory notes'",
      "'such as ~/.claude/plans'",
      "'such as ~/.codex/plans'",
      "'see AGENTS.md'",
    ]) {
      expect(AGENT_WORDS.test(withoutComments(`const a = ${said};`)), said).toBe(true);
    }
    for (const neutral of [
      "'Present a plan to the operator for approval.'",
      "'Write the commit message now.'",
      "'a hook records it'",
      "'Every test file is frozen.'",
      "'the agent adapter'",
    ]) {
      expect(AGENT_WORDS.test(withoutComments(`const a = ${neutral};`)), neutral).toBe(false);
    }
    expect(AGENT_WORDS.test(withoutComments('// the Claude adapter refuses the stop\nconst a = 1;'))).toBe(false);
    expect(AGENT_WORDS.test(withoutComments('/** written with the skill */\nconst a = 1;'))).toBe(false);
  });
});
