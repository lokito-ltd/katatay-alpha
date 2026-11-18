#!/usr/bin/env node
/**
 * `on write`: may this tool call happen? Asked before every tool call that may
 * write: file edits, and shell commands.
 *
 * In:  `{ version, writes: [{ path, delete }], command: string|null }`. `writes` is
 *      every file the call writes, moves or removes, absolute or from the
 *      repository root; empty for a shell call. `command` is the shell line,
 *      or null. Both are the adapter's to say, because only it knows the
 *      agent's tools. It holds no rule about which files are locked or need
 *      no plan: that is all decided here, from the rulebook.
 * Out: `{ version, allow, messages }`. Allowed, `messages` is empty. Denied,
 *      it holds one message saying why: `locked` for a lock, `needs_plan`
 *      when an approved plan would allow it, `stop` when only the operator
 *      can fix what is wrong. See `./messages.mjs`.
 *
 * The order, as `src/agents/README.md` sets it:
 *
 * 1. A locked path is denied, as is a delete under the requirements folder
 *    (`../locks.mjs`). A shell command is read for locks and nothing else.
 * 2. A file outside the repository is allowed. Claude's memory notes are
 *    there, and so is every other agent's scratch space.
 * 3. A file directly in the plans folder, or the follow-ups file, is allowed
 *    (`../places.mjs`).
 * 4. What is left needs an approved plan, which is the phase gate
 *    (`gateReason` in `../hooks/gate.mjs`).
 *
 * When the rulebook cannot be read, its `agent.lockedPaths` cannot either. The
 * referee's own locks and the default requirements folder still apply, and
 * step 2 does not, because a file outside the repository may be one the
 * rulebook would have locked, such as the agent's user settings.
 */
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { current } from '../state.mjs';
import { isFrozen } from '../frozen.mjs';
import { ignoredByGit, isChangeFile } from '../tree.mjs';
import { gateReason } from '../hooks/gate.mjs';
import { TargetError } from '../target.mjs';
import {
  DEFAULT_FOLLOW_UPS, parseLockedPaths, parseFollowUpsFile, parsePlansDir, parseRequirementsDir, readConfig,
} from '../rulebook.mjs';
import { lockRules } from '../locks.mjs';
import { isRulebookExempt, real } from '../places.mjs';
import { serve, versionShape } from './io.mjs';
import { answer, message } from './messages.mjs';

export const SHAPE = { version: versionShape, writes: 'list of { path, delete }', command: 'string|null' };

const SHELL = ' (This shell command appears to modify a locked path.)';

/** What the rulebook says about locks, or what is left when it says nothing. */
function readRules(root) {
  try {
    const config = readConfig(root);
    return {
      config,
      agentLocked: parseLockedPaths(config),
      requirements: parseRequirementsDir(config),
      followUps: parseFollowUpsFile(config),
      // As written, for the `needs_plan` text. `readConfig` has already
      // refused a rulebook without one.
      plans: parsePlansDir(config),
    };
  } catch (error) {
    return { refused: error?.message ?? String(error), agentLocked: [], requirements: 'requirements', followUps: DEFAULT_FOLLOW_UPS };
  }
}

/**
 * @param {{ writes: { path: string, delete: boolean }[], command: string|null }} input
 * @param {{ root?: string, home?: string }} [where] for tests; the repository
 *   is the working directory otherwise
 */
export function mayWrite({ writes, command }, { root = process.cwd(), home = homedir() } = {}) {
  const rules = readRules(root);
  const realRoot = real(root);
  const locks = lockRules({ root: realRoot, home: real(home), agentLocked: rules.agentLocked, requirements: rules.requirements });
  const allowed = answer({ allow: true }, []);
  const deny = ({ code, text }) => answer({ allow: false }, [message(code, code === 'stop' ? 'operator' : 'agent', text)]);

  const resolved = writes.map((write) => ({ ...write, at: real(resolve(root, write.path)) }));
  for (const write of resolved) {
    const reason = locks.forWrite({ path: write.at, delete: write.delete });
    if (reason) return deny({ code: 'locked', text: reason });
  }
  if (command !== null) {
    const reason = locks.forCommand(command);
    if (reason) return deny({ code: 'locked', text: `${reason}${SHELL}` });
  }

  const outside = (at) => relative(realRoot, at).startsWith('..');
  const gated = resolved.filter((write) => (
    !(rules.refused === undefined && outside(write.at)) && !isRulebookExempt(write.path, root, home)
  ));
  // A shell command, or writes that need no plan. Nothing here asks the
  // phase, so the full state read below is skipped: it runs before every
  // shell command too.
  if (gated.length === 0) return allowed;

  const { followUps, plans = null } = rules;
  let reason;
  if (rules.refused !== undefined) {
    reason = gateReason({ unconfigured: rules.refused, followUps, rulebookRead: false });
  } else {
    try {
      // The full read. The gate only asks whether the phase is `open`, which
      // the logbook alone could answer, but a cheaper read would return a
      // guessed phase. See `current` in `state.mjs` for what this costs.
      const { phase, broken, triage } = current();
      reason = gateReason({ phase, broken, followUps, plans });
      if (!reason) {
        for (const { at } of gated) {
          const file = relative(realRoot, at);
          if (ignoredByGit(file, root)) continue;
          if (phase === 'implementing' && isFrozen(file)) {
            return deny({ code: 'frozen', text: `${file} is frozen until triage. Finish the implementation and run triage first.` });
          }
          if (triage && !isFrozen(file) && !isChangeFile(file)) {
            return deny({ code: 'frozen', text: `${file} is part of the triaged implementation. To change it, present a revised plan for approval.` });
          }
        }
      }
    } catch (error) {
      // No target configured is a refusal, not a crash. Without it there is no
      // baseline to measure a change from, so nothing may be edited but the
      // files that never need a plan.
      //
      // Anything else means the phase is not known, and an edit is denied then
      // too. This used to allow the call. See `gateReason` for what that let
      // through.
      reason = error instanceof TargetError
        ? gateReason({ unconfigured: error.message, followUps })
        : gateReason({ unreadable: error?.message ?? String(error), followUps });
    }
  }
  return reason ? deny(reason) : allowed;
}

await serve(import.meta.url, 'write', SHAPE, mayWrite);
