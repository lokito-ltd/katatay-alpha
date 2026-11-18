/**
 * How a message names a command of the referee.
 *
 * Every message that tells the operator or the agent to run something builds
 * the name here, so that how the referee is started is said in one line. The
 * referee calls itself `workflow`, as its instructions do. How `workflow` is
 * started is the project's business: the project's own instructions say it,
 * such as an npm script for each command. So the messages name the referee's
 * command and never a project's alias for it.
 *
 * `name` is the subcommand as `cli/workflow.mjs` takes it, such as `triage` or
 * `req guard`. Arguments are not part of it: a message that wants `--staged`
 * adds it after the name.
 *
 * A name not listed in `COMMANDS` throws, so a message can never name a command
 * that does not exist. The list is checked against the routes of
 * `cli/workflow.mjs` by `commands.test.mjs`. The test reads the list rather than
 * the referee's source, because a mutation tool rewrites the source of the
 * files it mutates, and a scan of them finds nothing inside its sandbox.
 */
import { packaged } from '../distribution.mjs';

export const COMMANDS = ['checks-analysis', 'mutate', 'replan', 'report', 'req guard', 'req renumber', 'state show', 'triage', 'verify'];

export function command(name) {
  if (!COMMANDS.includes(name)) throw new Error(`commands: no referee command is named ${JSON.stringify(name)}`);
  return `${packaged ? 'ktty' : 'workflow'} ${name}`;
}
