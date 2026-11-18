/**
 * The phase gate, as a pure function so it can be tested without a session.
 *
 * It decides on *phase*, never on paths. The caller, `on write`
 * (`../moments/write.mjs`), has already applied the locks (`../locks.mjs`)
 * and dropped the writes that need no plan: files outside the repository,
 * files directly in the plans folder, and the follow-ups file. What reaches
 * this function is a write that needs an approved plan. The two questions
 * stay apart so that the lock rules live in one place: two rule sets meant to
 * agree have drifted apart once in this project already.
 *
 * A shell command never reaches it. Classifying one as a phase-gated write
 * would mean a second reading of the shell, and an unapproved edit made
 * through the shell is caught at the end of the turn instead.
 */
import { DEFAULT_FOLLOW_UPS } from '../rulebook.mjs';
import { planFormat } from '../plan-format.mjs';

/**
 * The plan format is printed here, where an agent first needs a plan, so that
 * nothing the referee checks at approval depends on a skill explaining it.
 * When the rulebook names no plans folder the format is left out: no plan can
 * be approved until it does, and the rulebook's own refusal says why.
 */
const openPhaseReason = (followUps, plans) => `No plan has been approved on this branch, so edits are not permitted yet.

Write the plan and present it to the operator for approval. Their approval is recorded when they give it. Nobody has to type anything.

You cannot approve a plan yourself. Only the operator can. Meanwhile you can still write plan files, ${followUps}, and files outside the repository that no lock covers.${plans ? `\n\n${planFormat(plans)}` : ''}`;

/**
 * What can still be written when an edit is refused for a reason no plan
 * fixes. When the rulebook itself cannot be read, its locks cannot either, so
 * a write outside the repository is refused too, and only the default
 * follow-ups file is left.
 */
const stillWritable = (followUps, rulebookRead) => (rulebookRead
  ? `Plan files, ${followUps} and files outside the repository that no lock covers can still be written.`
  : `Only ${followUps} can still be written: the rulebook's locks cannot be read, so nothing else is known to be safe to write.`);

/**
 * @param {{ phase?: string, broken?: string|null, unconfigured?: string, unreadable?: string, followUps?: string, rulebookRead?: boolean }} input
 *   `unconfigured` is the reason no target or no rulebook could be read, when
 *   none could. `unreadable` is the error that stopped the state being read at
 *   all, when one did. No phase is known then, so none is passed. `followUps`
 *   is the rulebook's follow-ups file, named in the messages. `plans` is the
 *   rulebook's plans folder as written, or null when it names none. `rulebookRead`
 *   is false when the rulebook itself was refused.
 * @returns {{ code: 'stop' | 'needs_plan', text: string } | null} why to deny,
 *   or null to stay out of the way. `needs_plan` when a plan would fix it, and
 *   `stop` when only the operator can.
 */
export function gateReason({ phase, broken, unconfigured = null, unreadable = null, followUps = DEFAULT_FOLLOW_UPS, plans = null, rulebookRead = true }) {
  const stop = (text) => ({ code: 'stop', text });
  if (unconfigured) {
    return stop(`${unconfigured}\n\nStop and tell the operator. ${stillWritable(followUps, rulebookRead)}`);
  }
  // An edit is denied when nobody can say which phase this is. The gate used
  // to allow the call whenever reading the state threw, so that a crashed hook
  // would not block ordinary work. But a state that cannot be read is not
  // known to be an approved one, and two ordinary states made the read throw:
  // a branch with no commit yet, and a logbook path that was a file. Each let an
  // unapproved edit through. Reading and the shell stay possible, because that
  // is how anyone finds out what went wrong.
  if (unreadable) {
    return stop(`The gate could not read the workflow state, so it cannot tell whether a plan has been approved, and the edit is not permitted: ${unreadable}\n\nStop and tell the operator. ${stillWritable(followUps, rulebookRead)}`);
  }
  if (broken) {
    return stop(`The workflow state chain on this branch is broken: ${broken}\n\nAn event file was edited or removed outside the append-only path. Stop and tell the operator. Do not work around it.`);
  }
  if (phase === 'open') return { code: 'needs_plan', text: openPhaseReason(followUps, plans) };
  return null;
}
