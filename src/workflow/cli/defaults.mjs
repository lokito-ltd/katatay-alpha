#!/usr/bin/env node
/**
 * `workflow.mjs defaults <command line>`: an agent adapter's defaults, for a
 * person to read.
 *
 * `init` asks the same command and writes the answer into a draft
 * rulebook. This shows what it would get, without writing anything. The answer
 * goes through `agentDefaults`, so it is checked exactly as `init` will check
 * it: a command that gives no answer prints why and exits 1, never half a
 * proposal.
 *
 * The command line is every argument after `defaults`, joined with spaces, so
 * an alias for it, such as an npm script, needs no quoting.
 */
import { fileURLToPath } from 'node:url';
import { agentDefaults } from '../agent.mjs';

export const USAGE = 'usage: workflow.mjs defaults <the agent adapter\'s defaults command>';

/** The width of the label column, so the values line up. */
const LABEL = 14;

/** `label` padded to the column, then the first of `values`, and the rest
 *  under it, one per line. */
const rows = (label, values) =>
  values.map((value, index) => `${(index === 0 ? label : '').padEnd(LABEL)}${value}`);

/** The proposal as text for a person. `line` is the command that made it. */
export function shown(line, proposal) {
  const { locked, plansFolder, instructions, commands, registration } = proposal;
  const names = Object.keys(commands);
  const width = Math.max(0, ...names.map((name) => name.length)) + 2;
  return [
    `Proposed by \`${line}\`:`,
    '',
    ...rows('locked', locked.length === 0 ? ['(nothing)'] : locked),
    ...rows('plans folder', [plansFolder]),
    ...rows('instructions', [instructions]),
    ...rows('commands', names.length === 0 ? ['(none)'] : names.map((name) => `${name.padEnd(width)}${commands[name]}`)),
    '',
    `Hook registration, to merge into ${registration.file}:`,
    '',
    registration.text.trimEnd(),
    '',
    ...(registration.steps.length === 0
      ? ['No other steps for the operator.']
      : ['Steps only the operator can take:', ...registration.steps.map((step, index) => `  ${index + 1}. ${step}`)]),
  ].join('\n');
}

/** What the command prints and its exit code, for `argv` after `defaults`. */
export function run(argv, root = process.cwd()) {
  if (argv.length === 0) return { stderr: USAGE, code: 2 };
  const line = argv.join(' ');
  const asked = agentDefaults(line, root);
  if ('none' in asked) return { stderr: asked.none, code: 1 };
  return { stdout: shown(line, asked.proposal), code: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { stdout, stderr, code } = run(process.argv.slice(2));
  if (stderr !== undefined) process.stderr.write(`${stderr}\n`);
  if (stdout === undefined) process.exit(code);
  process.stdout.write(`${stdout}\n`, () => process.exit(code));
}
