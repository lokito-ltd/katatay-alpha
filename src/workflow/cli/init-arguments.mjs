import { PROBE_STATES } from '../../evidence/probe-states.mjs';

/** The arguments, or `{ problem }`. */
export function parseArguments(argv) {
  const adapters = [];
  let project;
  let answers;
  let scratchModule;
  let list = false;
  let probe = false;
  let expect;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      return argv[index];
    };
    if (argument === '--questions') list = true;
    else if (argument === '--probe') probe = true;
    else if (argument === '--agent') {
      const given = value() ?? '';
      const equals = given.indexOf('=');
      const label = equals < 0 ? '' : given.slice(0, equals);
      const command = given.slice(equals + 1);
      if (!label.trim() || label.startsWith('-') || !command.trim()) {
        return { problem: `--agent needs <label>=<defaults command>, and got ${JSON.stringify(given)}` };
      }
      adapters.push({ label, command });
    } else {
      if (!['--expect', '--project', '--answers', '--scratch-module'].includes(argument)) {
        return { problem: `init does not take ${JSON.stringify(argument)}` };
      }
      const supplied = value();
      if (!supplied?.trim() || supplied.startsWith('-')) return { problem: `${argument} needs a value` };
      if (argument === '--expect') expect = supplied;
      else if (argument === '--project') project = supplied;
      else if (argument === '--answers') answers = supplied;
      else scratchModule = supplied;
    }
  }
  if (expect !== undefined && !PROBE_STATES.includes(expect)) return { problem: `--expect takes one of ${PROBE_STATES.join(', ')}, and got ${JSON.stringify(expect)}` };
  // A state is a break someone planted. Setting a project up on one would
  // write a rulebook proved on a broken tree.
  if (expect !== undefined && !probe) return { problem: '--expect needs --probe: a break is only looked for, never set up on' };
  return { adapters, project, answers, list, probe, expect, scratchModule };
}
