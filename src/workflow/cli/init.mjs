#!/usr/bin/env node
/**
 * `workflow.mjs init`: set up a project. The logic is in `../init.mjs`; this
 * reads the arguments, the answers and the terminal.
 *
 *   init --agent <label>=<defaults command> [--agent ...] [--project <dir>]
 *        [--answers <file>] [--questions] [--scratch-module <file>] [--probe [--expect <state>]]
 *
 * - `--agent`: an agent adapter, by a label for the rulebook and the command
 *   line of its `defaults`. At least one, so the project is guarded.
 * - `--project`: the folder to set up. Otherwise `INIT_CWD`, the folder npm
 *   was started from when an npm script runs this, and otherwise the working
 *   directory. A relative `--project` or `--answers` is read from that same
 *   folder.
 * - `--answers`: a JSON file of answers, keyed by question id. Without it,
 *   answers are read as JSON from stdin when stdin is not a terminal.
 * - `--questions`: print the questions as JSON, for an agent to read first,
 *   and write nothing.
 * - `--scratch-module`: the one project-relative source file the setup
 *   probe mutates. Supply it when the probe runs mutation testing.
 * - `--probe`: run the rulebook's commands, print whether each keeps the
 *   contract, and write nothing. Exit 0 only when every one passed. The
 *   rulebook is the one the answers draft, or the project's own when it has
 *   one. Without `--probe`, `init` runs the same probe before it writes.
 * - `--expect <state>`: with `--probe`, pass only when the probe sees that
 *   one break, which whoever is setting up planted: `compile-error-in-code`,
 *   `compile-error-in-test`, `failing-test`, `below-minimum` or `survivors`.
 *   Exit 2 when the state's item is switched off in the rulebook.
 *
 * In a terminal, each question still unanswered is asked in turn, and Enter
 * takes its default.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArguments } from './init-arguments.mjs';
export { parseArguments };
import { agentDefaults } from '../agent.mjs';
import { init, questionsJson } from '../init.mjs';

export const USAGE = 'usage: workflow.mjs init --agent <label>=<defaults command> [--agent ...] [--project <dir>] [--answers <file>] [--questions] [--scratch-module <file>] [--probe [--expect <state>]]';

/** The answers given as JSON text, or `{ problem }`. Empty text is no answers. */
export function parseAnswers(text, from) {
  if (text.trim() === '') return { given: {} };
  let given;
  try {
    given = JSON.parse(text);
  } catch (error) {
    return { problem: `the answers in ${from} are not JSON (${error.message})` };
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return { problem: `the answers in ${from} must be one JSON object keyed by question id` };
  return { given };
}

/**
 * What the command prints and its exit code.
 *
 * @param {string[]} argv the arguments after `init`
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, stdin?: () => string, ask?: ((question: object) => Promise<string>) | null, say?: (line: string) => void }} [io]
 *   `stdin` reads the answers when no `--answers` is given and `ask` is null;
 *   `ask` asks one question in a terminal.
 */
export async function run(argv, { cwd = process.cwd(), env = process.env, stdin = () => '', ask = null, say = () => {}, probe } = {}) {
  const args = parseArguments(argv);
  if ('problem' in args) return { stderr: `${args.problem}\n${USAGE}`, code: 2 };
  // npm starts a script in its own package's folder and says where it was
  // started from in `INIT_CWD`, so relative paths are read from there.
  const base = resolve(cwd, env.INIT_CWD ?? '.');
  const root = resolve(base, args.project ?? '.');

  if (args.list) {
    const first = args.adapters[0];
    const asked = first === undefined ? null : agentDefaults(first.command, root);
    if (asked !== null && 'none' in asked) return { stderr: `${first.label}: ${asked.none}`, code: 1 };
    return { stdout: JSON.stringify(questionsJson({ plansFolder: asked?.proposal.plansFolder }), null, 2), code: 0 };
  }
  if (args.adapters.length === 0) return { stderr: `name at least one agent adapter with --agent\n${USAGE}`, code: 2 };

  let given = {};
  if (args.answers !== undefined || ask === null) {
    let text;
    try {
      text = args.answers === undefined ? stdin() : readFileSync(resolve(base, args.answers), 'utf8');
    } catch (error) {
      return { stderr: `the answers cannot be read: ${error.message}`, code: 1 };
    }
    const parsed = parseAnswers(text, args.answers ?? 'stdin');
    if ('problem' in parsed) return { stderr: parsed.problem, code: 1 };
    given = parsed.given;
  }

  const result = await init({
    root, adapters: args.adapters, given, ask, say, probeOnly: args.probe, expect: args.expect ?? null,
    scratchModule: args.scratchModule, ...(probe === undefined ? {} : { probe }),
  });
  // Only the probe was asked for: its items, and whether every one passed.
  if (result.probed !== undefined) return { stdout: [`Probed ${root}:`, ...result.probed.map((line) => `- ${line}`)].join('\n'), code: result.ok ? 0 : 1 };
  // A state whose item is switched off was asked for wrongly, as a bad argument is.
  if (result.refused) return { stderr: result.problems.join('\n'), code: 2 };
  if (!result.ok) {
    return { stderr: ['init wrote nothing:', ...result.problems.map((problem) => `- ${problem}`)].join('\n'), code: 1 };
  }
  return {
    stdout: [
      `Set up ${root}:`,
      ...result.lines.map((line) => `- ${line}`),
      '',
      'Steps only the operator can take:',
      ...result.steps.map((step, index) => `  ${index + 1}. ${step}`),
    ].join('\n'),
    code: 0,
  };
}

/** Asks in the terminal, one question at a time; a repeated one shows its question once. */
function terminal() {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  let last = null;
  const ask = async (question) => {
    if (question !== last) {
      const shown = question.default === undefined ? '' : ` [${Array.isArray(question.default) ? question.default.join(', ') : typeof question.default === 'object' ? JSON.stringify(question.default) : String(question.default)}]`;
      process.stderr.write(`\n${question.ask}${shown}\n`);
      last = question;
    }
    return lines.question('> ');
  };
  return { ask, close: () => lines.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tty = process.stdin.isTTY === true;
  const prompts = tty ? terminal() : null;
  const { stdout, stderr, code } = await run(process.argv.slice(2), {
    stdin: () => readFileSync(0, 'utf8'),
    ask: prompts?.ask ?? null,
    say: (line) => process.stderr.write(`${line}\n`),
  });
  prompts?.close();
  if (stderr !== undefined) process.stderr.write(`${stderr}\n`);
  if (stdout === undefined) process.exit(code);
  process.stdout.write(`${stdout}\n`, () => process.exit(code));
}
