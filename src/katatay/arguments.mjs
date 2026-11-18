import { parseArguments as parseInit } from '../workflow/cli/init-arguments.mjs';

// Each option names the value it takes in the diagnostic. A flag takes none.
const optionForms = {
  verify: { '--results': 'file', '--deadline': 'milliseconds' },
  mutate: { '--base': 'ref', '--budget': 'seconds', '--verbose': null, '--json': null },
  areas: { '--staged': null },
  report: { '--json': null },
  'req guard': { '--record': null },
};

const operand = value => Boolean(value?.trim()) && !value.startsWith('-');

function optionsMatch(args, options) {
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!Object.hasOwn(options, name)) return false;
    const kind = options[name];
    if (kind === null) continue;
    const value = args[++i];
    if (kind === 'seconds' || kind === 'milliseconds') {
      if (!value?.trim() || !Number.isFinite(Number(value))) return false;
    } else if (!operand(value)) return false;
  }
  return true;
}

const positional = {
  replan: ['[--resume]', args => args.length === 0 || (args.length === 1 && args[0] === '--resume')],
  'checks-analysis': ['<verification-seq>', args => args.length === 1 && /^[1-9]\d*$/.test(args[0])],
  'req renumber': ['<fromId> <toId>', args => args.length === 2 && args.every(id => /^(?:AC|INV)\d{4}$/.test(id))],
  'req lint': ['[<directory>]', args => args.length === 0 || (args.length === 1 && operand(args[0]))],
  defaults: ['<adapter command> [arguments]', args => operand(args[0])],
  init: ['[--agent <label>=<defaults command>] [--project <dir>] [--answers <file>] [--questions] [--scratch-module <file>] [--probe [--expect <state>]]',
    args => !('problem' in parseInit(args))],
};

/** Validate only the public argv. An exit code from a running command describes its own outcome. */
export function argumentProblem(name, args) {
  if (Object.hasOwn(optionForms, name)) {
    const options = optionForms[name];
    if (optionsMatch(args, options)) return null;
    const form = Object.entries(options).map(([flag, value]) => value ? `[${flag} <${value}>]` : `[${flag}]`).join(' ');
    return `Usage: ktty ${name} ${form}.`;
  }
  if (Object.hasOwn(positional, name)) {
    const [form, valid] = positional[name];
    return valid(args) ? null : `Usage: ktty ${name} ${form}.`;
  }
  return args.length === 0 ? null : `The '${name}' command takes no arguments. Run 'ktty ${name}'.`;
}
