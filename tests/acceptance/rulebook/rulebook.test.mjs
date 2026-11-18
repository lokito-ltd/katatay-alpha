import { expect, it } from 'vitest';
import { thenHookReplies, whenKttyRuns, thenItExits } from '../support/ktty.mjs';
import {
  rulebookPath,
  planFile,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenGitRuns,
  whenHookRuns,
  whenEventsAreRead,
  whenPlanIsApproved,
  whenTurnEnds,
  messages,
} from '../support/project.mjs';
import {
  thenValueIs,
  thenTextMatches,
  thenContains,
  thenObjectIncludes,
  thenValueDiffers,
  thenEventsEqual,
  thenStderrContains,
  thenStdoutContains,
} from '../support/assertions.mjs';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function whenClaudeRuns(folder, action, request) {
  return whenKttyRuns(['agent', 'claude', action], { in: folder, input: JSON.stringify(request) });
}
const givenMissingRulebook = (folder) => rmSync(join(folder.cwd, rulebookPath));
const givenMissingTarget = (folder) =>
  givenRulebookChanges(folder, (book) => {
    delete book.targetBranch;
  });

it('A missing rulebook is refused, and the refusal shows the file it starts as. [AC0008.1]', () => {
  const folder = givenAWorkingBranch();
  givenMissingRulebook(folder);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(
    state,
    'no .katatay/rulebook.json, which starts as { "version": 1, "targetBranch": "origin/main" }',
  );
});

it('A rulebook that is not JSON, or not a JSON object, is refused. [AC0008.2]', () => {
  const folder = givenAWorkingBranch();
  const cases = [
    ['{', 'not readable as JSON'],
    ['null', 'must hold a JSON object'],
    ['[]', 'must hold a JSON object'],
  ];
  for (const [contents, expectedError] of cases) {
    givenFileContents(folder, rulebookPath, contents);

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    thenStderrContains(state, expectedError);
  }
});

it('An unknown key is refused, naming its full path and the keys allowed there. [AC0008.3]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.tests.paths.slower = [];
  });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(state, 'unknown "tests.paths.slower". Allowed keys: all, acceptance, slow, support');
});

it('One invalid section refuses every command, not only the one that reads that section. [AC0008.4]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.tests.paths.slower = [];
  });
  for (const args of [
    'state show',
    'state verify',
    'areas',
    'report',
    'req lint',
    'req guard',
    'req risk',
    'req trace',
    'req renumber AC0001 AC0009',
    'coverage',
    'mutate',
    'triage',
    'verify',
    'verify --rerun',
    'checks-analysis 1',
    'init --probe',
  ]) {
    const run = whenKttyRuns([...args.split(' ')], { in: folder });
    thenValueDiffers(run.status, 0, args);
    thenContains(run.stdout + run.stderr, 'tests.paths.slower', args);
  }
  thenEventsEqual(folder, []);
});

it('A plans folder at the repository root, or overlapping .katatay/, .git/, an agent lock or the requirements folder, is refused. [AC0008.5]', () => {
  const folder = givenAWorkingBranch();
  for (const [dir, reason] of [
    ['.', 'repository root'],
    ['.katatay/plans', '.katatay'],
    ['.git/plans', '.git'],
    ['private/plans', 'private'],
    ['requirements/plans', 'requirements'],
  ]) {
    givenRulebookChanges(folder, (book) => {
      book.plans.dir = dir;
    });

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    const why = state.stderr;
    thenContains(why, 'plans.dir');
    thenContains(why, dir);
    thenContains(why, reason);
  }
});

it('While the rulebook is refused, ktty state show exits 1, the turn end blocks, and no approval is recorded. [AC0008.6]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.plans.dir = '.';
  });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(state, 'repository root');

  const stoppedRun = whenTurnEnds(folder);
  const stopped = thenHookReplies(stoppedRun, 0);
  thenValueIs(stopped.keepWorking, true);
  thenContains(messages(stopped), 'repository root');

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenObjectIncludes(approval, { recorded: false });
  thenEventsEqual(folder, []);

  const started = givenAWorkingBranch();

  const existingApprovalRun = whenPlanIsApproved(started);
  const existingApproval = thenHookReplies(existingApprovalRun, 0);
  thenValueIs(existingApproval.recorded, true);
  givenRulebookChanges(started, (book) => {
    book.plans.dir = '.';
  });

  const stop = whenClaudeRuns(started, 'turn-end', { stop_hook_active: false });
  thenItExits(stop, 0);
  thenObjectIncludes(JSON.parse(stop.stdout), {
    decision: 'block',
    reason: expect.stringContaining('repository root'),
  });
});

it('While the rulebook is refused, every write is denied except the default follow-ups file, including writes outside the repository. [AC0008.7]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.plans.dir = '.';
  });
  for (const path of ['src/add.sh', 'CLAUDE.md', planFile, join(folder.env.HOME, 'outside.md')]) {
    const answerRun = whenHookRuns(folder, 'write', {
      writes: [{ path: path, delete: false }],
      command: null,
    });
    const answer = thenHookReplies(answerRun, 0);
    thenValueIs(answer.allow, false);
    thenContains(messages(answer), 'repository root');
    thenContains(messages(answer), 'Only FOLLOW-UPS.md');
  }

  const writeRun = whenHookRuns(folder, 'write', {
    writes: [{ path: 'FOLLOW-UPS.md', delete: false }],
    command: null,
  });
  const writeReply = thenHookReplies(writeRun, 0);
  thenValueIs(writeReply.allow, true);

  for (const path of ['src/add.sh', 'CLAUDE.md', planFile]) {
    const attempt = whenClaudeRuns(folder, 'pre-tool', {
      tool_name: 'Write',
      tool_input: { file_path: resolve(folder.cwd, path) },
    });
    thenItExits(attempt, 0);
    const denied = JSON.parse(attempt.stdout).hookSpecificOutput;
    thenValueIs(denied.permissionDecision, 'deny');
    thenContains(denied.permissionDecisionReason, 'Only FOLLOW-UPS.md can still be written');
  }

  const allowed = whenClaudeRuns(folder, 'pre-tool', {
    tool_name: 'Write',
    tool_input: { file_path: resolve(folder.cwd, 'FOLLOW-UPS.md') },
  });
  thenItExits(allowed, 0);
  thenValueIs(allowed.stdout.trim() ? JSON.parse(allowed.stdout) : null, null);
});

it('A rulebook without a version is refused, saying it must state the version. [AC0009.1]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    delete book.version;
  });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(state, 'must specify "version": 1');
});

it('A rulebook at a version Katatay does not read is refused, naming the version it reads. [AC0009.2]', () => {
  const folder = givenAWorkingBranch();

  const version = whenKttyRuns(['version'], { in: folder });
  thenItExits(version, 0);
  thenTextMatches(version.stdout, /schema[^\n]*1/i);
  givenRulebookChanges(folder, (book) => {
    book.version = 999;
  });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(state, '"version": 999, and this referee reads version 1');
});

it('A version given as a string, a fraction or null is refused. [AC0009.3]', () => {
  const folder = givenAWorkingBranch();
  for (const version of ['1', 1.5, null]) {
    givenRulebookChanges(folder, (book) => {
      book.version = version;
    });

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    thenStderrContains(state, '"version": ' + JSON.stringify(version) + ', and this referee reads version 1');
  }
});

it('A missing, blank or non-string targetBranch is refused. [AC0010.1]', () => {
  const folder = givenAWorkingBranch();
  for (const target of [undefined, '   ', 5]) {
    givenRulebookChanges(folder, (book) => {
      book.targetBranch = target;
    });

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    thenStderrContains(state, 'has no "targetBranch" key');
  }
});

it('A value such as main, /main or origin/ is refused as not remote/branch. [AC0010.2]', () => {
  const folder = givenAWorkingBranch();
  for (const target of ['main', '/main', 'origin/']) {
    givenRulebookChanges(folder, (book) => {
      book.targetBranch = target;
    });

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    thenStderrContains(state, JSON.stringify(target) + ', which is not <remote>/<branch>');
  }
});

it('A remote that git does not list is refused. [AC0010.3]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.targetBranch = 'absent/main';
  });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 1);
  thenStderrContains(state, 'remote "absent", and git has no remote by that name');
});

it('origin/release/2026 is read as remote origin and branch release/2026. [AC0010.4]', () => {
  const folder = givenAWorkingBranch('release/2026');

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const target = whenGitRuns(folder, 'rev-parse', 'origin/release/2026');
  const [approved] = whenEventsAreRead(folder);
  thenValueIs(approved.payload.baseline, target);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenStdoutContains(state, 'on origin/release/2026');
});

it('Without a target, plan approval records nothing. [AC0010.5]', () => {
  for (const invalidate of [givenMissingTarget, givenMissingRulebook]) {
    const folder = givenAWorkingBranch();
    invalidate(folder);

    const answerRun = whenPlanIsApproved(folder);
    const answer = thenHookReplies(answerRun, 0);
    thenValueIs(answer.recorded, false);
    thenContains(messages(answer), '.katatay/rulebook.json');
    thenEventsEqual(folder, []);
  }
});

it('Without a target, edits are denied except the files that never need a plan. [AC0010.6]', () => {
  for (const invalidate of [givenMissingTarget, givenMissingRulebook]) {
    const folder = givenAWorkingBranch();
    invalidate(folder);

    const deniedRun = whenHookRuns(folder, 'write', {
      writes: [{ path: 'src/add.sh', delete: false }],
      command: null,
    });
    const denied = thenHookReplies(deniedRun, 0);
    thenValueIs(denied.allow, false);
    thenContains(messages(denied), '"targetBranch": "origin/main"');

    const writeRun = whenHookRuns(folder, 'write', {
      writes: [{ path: 'FOLLOW-UPS.md', delete: false }],
      command: null,
    });
    const writeReply = thenHookReplies(writeRun, 0);
    thenValueIs(writeReply.allow, true);
  }
});

it('Without a target, the turn end blocks, ktty state show exits 1, and ktty triage refuses without recording. [AC0010.7]', () => {
  for (const invalidate of [givenMissingTarget, givenMissingRulebook]) {
    const folder = givenAWorkingBranch();

    const approvalRun = whenPlanIsApproved(folder);
    const approval = thenHookReplies(approvalRun, 0);
    thenValueIs(approval.recorded, true);
    invalidate(folder);
    const before = whenEventsAreRead(folder);

    const stoppedRun = whenTurnEnds(folder);
    const stopped = thenHookReplies(stoppedRun, 0);
    thenValueIs(stopped.keepWorking, true);
    thenContains(messages(stopped), 'refuses to run');

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenItExits(state, 1);
    thenStderrContains(state, '.katatay/rulebook.json');

    const run = whenKttyRuns(['triage'], { in: folder });
    thenItExits(run, 1);
    thenContains(run.stderr + run.stdout, '.katatay/rulebook.json');
    thenEventsEqual(folder, before);
  }
});
