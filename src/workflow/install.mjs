/**
 * What the referee hands an agent adapter to install into a project: the
 * workflow's instructions and the harness support skills.
 *
 * Both are the referee's own text, in words any agent can follow, and both
 * sit beside this file: `INSTRUCTIONS.md` and `skills/<name>.md`. They are
 * read from here, wherever the harness is installed, because a project has no
 * copy of the harness's files. Once the harness is packaged, nothing under
 * `src/` is in the project at all. So the texts travel in the request to
 * the adapter's `install` command (`installRequest` below, asked through
 * `agentInstall` in `agent.mjs`), and the adapter answers with the files to
 * write, in its agent's format and location. `init` writes them.
 *
 * The skills are an extra. Nothing the referee requires depends on one: what a
 * skill explains that the referee checks, the referee also says itself, in
 * `INSTRUCTIONS.md` and in its messages. An adapter, or an agent running
 * `init`, may reword a skill as it wishes.
 *
 * This is the one referee file that names skills in its code. The
 * `agent-free` scan allows it here and nowhere else, so no message can send an
 * agent to a skill.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { expandPlanTemplate } from './plan-format.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Where the referee keeps its instructions and its skills. */
export const INSTRUCTIONS = join(HERE, 'INSTRUCTIONS.md');
export const SKILLS = join(HERE, 'skills');

/** A skill's name, as its file is named: lower case, digits and dashes. An
 *  adapter builds paths from it, so nothing else is let through. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const notYaml = () => {
  throw new Error('only YAML frontmatter is read');
};

/** The workflow's instructions, as the agent should read them. */
export const readInstructions = (file = INSTRUCTIONS) => expandPlanTemplate(readFileSync(file, 'utf8'));

/**
 * The harness support skills, sorted by name: `{ name, description, prompt }`
 * each. `prompt` is the file's text after its frontmatter.
 *
 * A skill without a `name` or a `description`, or whose `name` is not its
 * file's name, throws: an agent finds a skill by its name and decides to use
 * it from its description, so a skill missing either would be installed and
 * never used, and nobody would notice.
 */
export function readSkills(folder = SKILLS) {
  const files = readdirSync(folder).filter((file) => file.endsWith('.md')).sort();
  return files.map((file) => {
    const where = join(folder, file);
    const { data, content } = matter(readFileSync(where, 'utf8'), { engines: { js: notYaml, javascript: notYaml, json: notYaml } });
    const named = basename(file, '.md');
    const problem = !SKILL_NAME.test(named) ? `its file name is not a skill name (lower case, digits and dashes)`
      : typeof data.name !== 'string' || data.name === '' ? 'it has no `name` in its frontmatter'
        : data.name !== named ? `its \`name\` is ${JSON.stringify(data.name)}, not ${JSON.stringify(named)} as its file is named`
          : typeof data.description !== 'string' || data.description.trim() === '' ? 'it has no `description` in its frontmatter'
            : null;
    if (problem !== null) throw new Error(`install: the skill ${where} cannot be installed: ${problem}.`);
    return { name: data.name, description: data.description.trim(), prompt: `${expandPlanTemplate(content.trim())}\n` };
  });
}

/** The request the adapter's `install` command reads, without its version. */
export const installRequest = ({ instructions = INSTRUCTIONS, skills = SKILLS } = {}) => ({
  instructions: readInstructions(instructions),
  skills: readSkills(skills),
});
