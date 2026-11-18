/**
 * `workflow verify --rerun`: run verify now and record its result, as the
 * turn-end hook would, whatever the hook's guard against repeating a failure
 * says.
 *
 * The guard is right for turn ends: verify would fail the same way on the
 * same tree, rulebook and baseline, and it can take minutes. But some failures
 * come from causes outside all three: another branch's logbook, the network,
 * the operating system, the sandbox. Fixing one of them is not a change the
 * guard can see, and a plain `workflow verify` records nothing, so before this
 * the stale failure stood until someone edited the tree for no other reason.
 *
 * It records through `verify-record.mjs`, the code the hook uses, so the result
 * is measured the same whoever ran it. Each event it writes carries
 * `trigger: 'rerun'`, and a pass says so wherever it is shown, because the
 * shell that started it is not the hook's: a changed PATH, for example, can
 * shape the result.
 */
import { current, followTarget } from './state.mjs';
import { inCi } from './ci.mjs';
import { command } from './commands.mjs';
import { REPLAN_PENDING } from './phase.mjs';
import { runReferee } from './runtime.mjs';
import { failureMessages, RERUN, verifyAndRecord } from './verify-record.mjs';
import { message } from './moments/messages.mjs';

/** The exit statuses: a pass recorded, a failure recorded, nothing recorded. */
export const PASSED = 0;
export const FAILED = 1;
export const REFUSED = 2;

const refused = (text) => ({ status: REFUSED, messages: [message('refused', 'agent', `\`${command('verify')} --rerun\` refused, and recorded nothing: ${text}`)] });

/**
 * Run and record, or refuse. `env` is the environment CI is read from, and
 * `referee` starts verify; tests give their own.
 *
 * @returns {{ status: number, messages: { code: string, for: string, text: string }[] }}
 */
export function rerunVerify({ env = process.env, referee = runReferee } = {}) {
  // The agent sets the environment of its own shell commands, which it cannot
  // do for the hook. Under `CI=true` verify behaves as it does in CI: checks
  // marked skipInCi and mutation are left out, and the requirements guard fails
  // on other things. A pass measured that way must not become a receipt.
  if (inCi(env)) return refused('`CI=true` makes verify behave as it does in CI, and a pass measured that way is not this change\'s receipt. Run it without `CI` set.');
  let state = current();
  // A sync made since the last turn is caught up first, as the hook does, so
  // the verify sees the baseline the branch now has.
  if (followTarget(state)) state = current();
  if (state.broken) return refused(`the workflow state chain is broken: ${state.broken}\n\nStop and tell the operator.`);
  if (state.replan) return refused(REPLAN_PENDING);
  // Only where the turn end would verify. Before triage a red suite is the
  // expected state and nothing is verified; after a pass there is nothing to
  // rerun.
  if (state.phase !== 'converging') return refused(`it records only in phase \`converging\`, where the turn end would verify, and the phase is \`${state.phase}\`: ${state.why}`);
  if (state.drift) return refused(state.why);
  const ran = verifyAndRecord(state, { referee, trigger: RERUN });
  if (ran.outcome === 'failed') return { status: FAILED, messages: failureMessages(state, ran) };
  if (ran.outcome === 'changed') return refused(ran.why);
  return { status: PASSED, messages: ran.messages };
}
