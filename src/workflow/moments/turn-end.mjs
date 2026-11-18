#!/usr/bin/env node
/**
 * `on turn-end`: the agent's turn ended. Where verification stops being a claim
 * and becomes a fact.
 *
 * In:  `{ version, stopRefusedBefore, secondsLeft, planFile?, triageReplyId? }`.
 *      `planFile` names a plan presented in this turn, saved by the adapter.
 *      Adapters should send it as a courtesy before approval. Omitted or
 *      null skips that courtesy. Its messages never replace phase-specific
 *      work, and approval never depends on it.
 *      `stopRefusedBefore` is true when an earlier stop in this turn was
 *      refused, by this command's `keepWorking` or by the adapter delivering a
 *      message. It is used only to stop a turn looping. `secondsLeft` is how
 *      long the agent still gives the turn end before it is killed.
 * Out: `{ version, keepWorking, messages }`. `keepWorking: true` means the
 *      agent has more work to do and the turn may not end yet. A pass with
 *      only something to tell the operator, such as `verified`, answers
 *      `keepWorking: false`: delivering it is the adapter's job, and an adapter
 *      may refuse the stop to do that.
 *
 * It runs the referee verify (`../cli/verify-change.ts`, what `workflow verify`
 * runs) itself rather than believing the agent did. A transcript line reading
 * `workflow verify` proves nothing, because `echo` produces the same shape, and
 * no signature could fix that: this command, the verify script and the agent's
 * shell are the same user. Running it here is the only version of "verified"
 * worth recording.
 *
 * It runs once when a turn ends, and once more if that stop was refused, to
 * check what the forced turn did. A receipt is keyed to a fingerprint of the
 * working tree, so it stays valid until the next edit and is invalid
 * immediately after one.
 *
 * A passing verify, and the triage that rides with it, are for the operator.
 * How they reach the operator is the adapter's choice. The Claude adapter
 * refuses the stop and has Claude repeat them, because Claude Code may fold a
 * plain message away (`src/agents/claude/hooks/translate.mjs`).
 */
import { fileURLToPath } from 'node:url';
import { current, followTarget } from '../state.mjs';
import { join } from 'node:path';
import { append, fileFor } from '../chain.mjs';
import { declaredSummary, WRITE_COMMIT_MESSAGE } from '../record.mjs';
import { isDirty } from '../tree.mjs';
import { gitText } from '../git.mjs';
import { frozenChanges, describeFreeze } from '../frozen.mjs';
import { triageReport } from '../triage-summary.mjs';
import { provedOnServer } from '../baseline.mjs';
import { TargetError } from '../target.mjs';
import { requirementsPrefix } from '../rulebook.mjs';
import { checkPresentedPlan } from '../presented-plan.mjs';
import { setupMessages } from '../agent.mjs';
import { readBaseline, receiptFor, REPLAN_PENDING, sameMeasurement } from '../phase.mjs';
import { runReferee } from '../runtime.mjs';
import { command } from '../commands.mjs';
import { areasSummary, failureMessages, RERUN, summaryMessage, tail, verifyAndRecord } from '../verify-record.mjs';
import { serve, versionShape } from './io.mjs';
import { answer, message } from './messages.mjs';

export { VERIFY } from '../verify-record.mjs';

export const SHAPE = { version: versionShape, stopRefusedBefore: 'boolean', secondsLeft: 'number',
  planFile: 'optional string|null', triageReplyId: 'optional string|null' };

/** The requirements guard, which the record step runs on the change file. */
export const GUARD = fileURLToPath(new URL('../../requirements/guard.ts', import.meta.url));

/** Said on a failure the turn end repeats without running verify. */
export const NOT_RUN_AGAIN = `Verify was not run again: the working tree, the rulebook and the baseline are unchanged since this failure. \`${command('verify')} --rerun\` runs it again.`;

/**
 * The last `verify_failed`, when nothing verify reads has changed since it:
 * the same tree, rulebook bytes and baseline commit.
 * Verify would fail the same way again, and it can take minutes, so it is not
 * run again on any turn end until one of the three changes. Null otherwise.
 *
 * A `verified` after the failure ends it: the latest of the two is the one
 * that says what the tree does now.
 */
function unchangedSinceFailure(state) {
  const last = state.live.findLast((e) => e.event === 'verified' || e.event === 'verify_failed' || e.event === 'triaged');
  if (last?.event !== 'verify_failed') return null;
  return last.payload.treeFingerprint === state.treeFingerprint && readBaseline(last.payload.baseline) === state.baseline
    && last.payload.rulebookFingerprint === state.rulebookFingerprint ? last : null;
}

/**
 * `referee` starts the referee's own commands: verify, the requirements guard
 * at record. It is `runReferee` unless a test gives another. Each
 * is a process of its own, and verify alone starts dozens more, so a test of
 * what this moment does with their answers spent most of its time waiting for
 * them. The machine tests start this moment as the agent does, with the real
 * one, and prove the commands themselves.
 */
export function onTurnEnd({ stopRefusedBefore, secondsLeft, planFile = null, triageReplyId = null }, { referee = runReferee } = {}) {
  const started = Date.now();
  // How the command pushes back, chosen once per run.
  //
  // `stopRefusedBefore` is set on the turn end that follows a refused stop.
  // Asking for more work there would force a third turn end, and so on, so on
  // that pass `keepWorking` is false and the turn ends. Asking is one-shot;
  // the checks are not. This pass used to stop before checking anything,
  // which left the work done in answer to the refusal — a fixed test, a
  // change file written on request — unchecked and unrecorded until some
  // later turn ended.
  const keep = !stopRefusedBefore;
  const planMessages = [];
  let correctPlan = false;
  const finish = (keepWorking, messages) => answer(
    { keepWorking: keepWorking || (correctPlan && keep) },
    [...planMessages, ...messages].filter(Boolean),
  );
  const done = (...messages) => finish(false, messages);
  const more = (...messages) => finish(keep, messages);
  const stop = (text) => more(message('stop', 'operator', text));

  try {
    let state = current();
    // A sync made during the turn is caught up before anything is measured, so
    // the freeze and the verify below see the baseline the branch now has.
    if (followTarget(state)) state = current();

    if (state.broken) {
      // Nothing is written on top of a broken logbook, a `recorded` event least
      // of all: `state.broken` says what is wrong and how to mend it.
      return stop(`The workflow state chain is broken: ${state.broken}\n\nStop and tell the operator.`);
    }

    if (planFile !== null) {
      const checked = checkPresentedPlan(planFile);
      correctPlan = checked.needsCorrection || checked.checkFailed === true;
      planMessages.push(...checked.messages);
    }

    if (state.phase === 'open') {
      if (isDirty()) {
        // Reported, not pushed back on. Only the operator can permit work on
        // this branch, so more work would demand the agent fix something
        // outside its power. It also fired on every turn that ended with the
        // tree still dirty, including turns that changed nothing. The
        // condition is real, so it is still said out loud, here and in
        // `state:show`.
        //
        // The message is vague about where the changes came from, on purpose.
        // The gate covers the editing tools, so changes reaching this phase
        // either came through the shell or predate the permission, and from
        // here the two look identical.
        return done(message('warning', 'operator', 'The working tree has changes, but no plan has been approved on this branch. They came either through the shell, which the gate does not classify, or from before this branch started. Say what changed and present a plan for the operator to approve, or revert it.'));
      }
      return done();
    }

    // Nothing is verified in this phase, on purpose. A red suite is the
    // expected state of a half-implemented change. Pushing back on it here
    // used to force the fix straight away, which meant the triage only ever
    // ran on a suite that had already been driven green, with nothing left to
    // classify.
    if (state.phase === 'implementing') {
      // Declared by the operator when they approved the plan. It changes none
      // of the rules here — the freeze holds either way — only what the agent
      // is told to do about them, because for this change the triage comes
      // first.
      const testOnly = state.grant.payload.testOnly;
      const touched = frozenChanges(state.baseline);
      if (touched.length > 0) {
        const freeze = `${describeFreeze()} These differ from the baseline:\n\n${touched.map((f) => `  ${f}`).join('\n')}`;
        if (state.replan) return more(message('frozen', 'agent', freeze + '\n\nRestore these files. ' + REPLAN_PENDING));
        return more(message(
          'frozen',
          'agent',
          freeze + '\n\n'
            + (testOnly
              ? 'This change is declared test-only, so the triage runs first, on the tree as it stood before '
                + 'your work: all it has to find is a green suite. Unwind these, run `' + command('triage') + '`, and then write them.'
              : 'Unwind them, then run `' + command('triage') + '`. The freeze is what makes the triage mean something: '
                + 'every failure it reports was caused by the implementation and nothing else. A test written '
                + 'beside the code it covers, before anyone has seen what broke, only shows that the two agree.'),
        ));
      }
      if (state.replan) return done(message('info', 'agent', REPLAN_PENDING));
      return done(message('run_triage', 'agent', testOnly
        ? 'This change is declared test-only, so there is no implementation to wait for. Run `' + command('triage') + '` now: '
          + 'it has to find the suite green before new tests land on top of it. Then write them.'
        : 'Nothing is verified while the implementation is in progress, and a red suite is expected here. '
          + 'Run `' + command('triage') + '` once the implementation is complete. It will say what actually broke.'));
    }

    // A restored tree can match an older passing receipt while its revision
    // is under discussion. The request still belongs to this approval.
    if (state.replan) {
      const lastWork = state.live.findLast(e => e.event !== 'replan_requested' && e.event !== 'replan_resumed');
      const due = state.triage && lastWork === state.triage && !triageReplyId && !stopRefusedBefore;
      return finish(Boolean(state.drift) && keep, [
        due && message('triaged', 'operator', triageReport(state.triage, { branch: state.branch, dir: state.dir, testOnly: state.grant.payload.testOnly })),
        state.drift && message('stop', 'operator', state.why),
        message('info', 'agent', REPLAN_PENDING),
      ]);
    }

    if (state.phase === 'converging') {
      if (state.drift) return stop(state.why);
      const last = state.live.at(-1);
      if (triageReplyId) {
        const prior = state.entries.findLast(e => e.event === 'convergence_requested' && e.payload.reply === triageReplyId);
        // A delayed copy of the same Stop can arrive after convergence has
        // started editing. Only the ordinary completion may verify those edits.
        if (prior?.payload.triage === state.triage.seq) return done();
        if (!prior && last === state.triage && last.payload.treeFingerprint === state.treeFingerprint) {
          append(state.dir, 'convergence_requested', { triage: last.seq, reply: triageReplyId }, state.branch);
          return finish(true, [message('info', 'agent', 'The operator has the triage report. Continue the approved work now: fix the failures and write the tests the change needs. When the work is done, finish with an ordinary completion reply so verification can run.')]);
        }
      }
      // The triage, said out loud on the turn it was recorded. Nobody reads a
      // committed JSON file, and the surprises are about to be worked through
      // and disappear, so it goes out to the operator whether verify then
      // passes or fails: the same compact text `workflow triage` printed.
      const fresh = last?.event === 'triaged'
        ? message('triaged', 'operator', triageReport(state.triage, { branch: state.branch, dir: state.dir, testOnly: state.grant.payload.testOnly }))
        : null;
      const failedBefore = unchangedSinceFailure(state);
      if (failedBefore !== null) {
        // The summary is rebuilt from the stored event: verify did not run.
        return more(fresh, summaryMessage(state, failedBefore, { warnings: [NOT_RUN_AGAIN] }), message(
          'info',
          'agent',
          '`' + command('verify') + '` still fails: the working tree has not changed since it failed, and neither has the rulebook or the baseline, so it was not run again. The failure stands:\n\n'
            + failedBefore.payload.tail
            + '\n\nIf the cause lay outside the working tree, such as the network or the environment, and is fixed now, run `' + command('verify') + ' --rerun` to verify again and record the result.',
        ));
      }
      // An adapter may refuse a stop to deliver a passing verify, as the Claude
      // one does. Spent on that, the turn's one push back would be gone when a
      // failure needed it: the forced turn edits a file, verify now fails, and
      // that could only be a message folded away. So a failure may still ask
      // for more work on the turn end after a delivered pass. The last event
      // identifies either report delivery. A triage reply leaves
      // `convergence_requested`. A pass leaves `verified`, possibly followed
      // by its analysis. If this verify fails it leaves `verify_failed`, so
      // the next stop cannot claim that opportunity again.
      const relayed = state.entries.findLast((e) => e.event !== 'checks_analysis');
      const afterRelay = stopRefusedBefore && (relayed?.event === 'verified' || relayed?.event === 'convergence_requested');
      const ran = verifyAndRecord(state, { deadline: Math.floor(started + secondsLeft * 1000), referee });
      if (ran.outcome === 'failed') return finish(keep || afterRelay, [fresh, ...failureMessages(state, ran)].filter(Boolean));
      if (ran.outcome === 'changed') return stop(ran.why);
      return done(fresh, ...ran.messages);
    }

    // Not more work. Finishing is the operator's word, so nothing the agent
    // could do would satisfy it — least of all writing the change file, which
    // is what this used to demand, and was how the agent declared its own work
    // done.
    //
    // For the agent, because it tells the agent to tell the operator. Marked
    // for the operator, an adapter that refuses a stop to deliver a `verified`
    // would refuse every stop in this phase.
    if (state.phase === 'verified') {
      return done(
        message('verified', 'agent', 'Verification passed on this working tree.'
          + (receiptFor(state.live, state)?.payload.trigger === RERUN
            ? ' The pass came from `' + command('verify') + ' --rerun`, not from a turn end: say so.'
            : '')
          + ' Tell the operator. The change is finished only when they say so: they type `record`, and the change file is written after that.'
          + areasSummary(state)),
        ...setupMessages(),
      );
    }

    if (state.phase === 'declared') {
      if (state.changeFiles.length === 0) {
        return more(message('change_file', 'agent', `The operator declared this change finished, and no change file records it. Write one under \`${requirementsPrefix()}changes/\` — see TEMPLATE.md.`));
      }
      // The baseline is proved before anything else, because a change
      // measured from a commit that is not on the target was measured from the
      // wrong place, whatever its change file says. The remote-tracking ref it
      // came from is a file a session can rewrite; the server's branch is not.
      const proof = provedOnServer(state.target, state.baselines);
      // News, not work: nothing the agent does makes the server answer, and
      // the next turn end tries again.
      if (!proof.ok && proof.reason === 'unreachable') {
        return done(message('info', 'operator', `The change stays declared: its baseline is not proved, because the server behind ${state.target.name} did not answer. Nothing else is wrong. It is recorded on the first turn the server answers.`));
      }
      if (!proof.ok) {
        return stop(
          `The change cannot be recorded: these baselines are not on ${state.target.name} as the server has it (tip ${proof.tip.slice(0, 12)}):\n\n`
            + `${proof.shas.map((sha) => `  ${sha}`).join('\n')}\n\n`
            + 'The change was measured from a commit the target never had, so its freeze and triage were measured from the wrong place. Stop and tell the operator.',
        );
      }
      // The change files sit outside the tree fingerprint, so the verification
      // receipt says nothing about them. The guard runs here instead, against
      // them as they now stand, and its pass is keyed to their contents.
      //
      // `--record`, because until now the approved plan could account for a
      // reworded requirement in place of its change file. From here only a
      // change file does: it is the record that outlives the plan.
      const guardRun = referee(GUARD, ['--record'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (guardRun.status !== 0) {
        return more(message('change_file', 'agent', `\`${command('req guard')}\` failed on the change file, so nothing was recorded.\n\nFix the change file so it tells the truth about the branch.\n\n${tail(`${guardRun.stdout ?? ''}${guardRun.stderr ?? ''}${guardRun.error ? `\n${guardRun.error.message}` : ''}`)}`));
      }
      const checked = current();
      if (!sameMeasurement(state, checked) || checked.changeDigest !== state.changeDigest || checked.phase !== 'declared') {
        return stop('The declared tree or change file changed during the guard. Check the current state before recording.');
      }
      append(state.dir, 'recorded', { treeFingerprint: state.treeFingerprint, changes: state.changeDigest, files: state.changeFiles }, state.branch, checked.entries.length);
      const recorded = `Recorded by ${state.changeFiles.join(', ')}. The merge is the operator's.`;
      // Staged here rather than by the agent, because the `recorded` event was
      // written a line above. Staged any earlier, it would miss the commit.
      // The tree fingerprint already counts untracked files, so moving them
      // into the index leaves the receipt standing.
      //
      // More work rather than news, so the agent takes one more step: the
      // commit message. It is one-shot like every push back here, and the
      // commit itself still waits for the operator's yes. After a refused stop
      // it cannot ask for more, so the operator gets the change summary
      // straight away and is told how to get the message: a repeated `record`
      // asks the agent for it (see `repeatedRecordContext` in `../record.mjs`).
      //
      // The change summary rides along either way. The agent was asked to show
      // it at `record`, and on 2026-11-04 it showed only the title line, so
      // recording is the second chance, built from the logbook.
      try {
        gitText(['add', '-A']);
      } catch (failure) {
        return stop(`${recorded}\n\nStaging the change failed, so nothing is staged. Tell the operator.\n\n${tail(`${failure.stdout ?? ''}${failure.stderr ?? ''}`)}`);
      }
      const summary = state.declaration
        ? declaredSummary({ summary: state.declaration.payload.summary, link: join(state.dir, fileFor(state.declaration)) })
        : null;
      return stopRefusedBefore
        ? done(message('recorded', 'operator', [recorded, summary,
          'Every file is staged, the `recorded` event included. Type `record` to have the agent write the commit message. Nothing is committed without your yes.']
          .filter(Boolean).join('\n\n')))
        : more(message('recorded', 'agent', [recorded,
          summary && `If this change summary is not already in the chat, show it to the operator verbatim:\n\n${summary}`,
          `Every file is staged, the \`recorded\` event included. ${WRITE_COMMIT_MESSAGE}`]
          .filter(Boolean).join('\n\n')));
    }
    return done();
  } catch (error) {
    // Silence here would mean the gate did not run at all, which looks
    // exactly like passing. Say so instead. No target is a refusal rather than
    // a failure, and is said as one.
    return stop(error instanceof TargetError
      ? `The workflow refuses to run: ${error.message}\n\nStop and tell the operator.`
      : `The workflow turn-end hook failed, so nothing was verified: ${error.message}`);
  }
}

await serve(import.meta.url, 'turn-end', SHAPE, onTurnEnd);
