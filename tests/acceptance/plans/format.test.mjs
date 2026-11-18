import { it } from 'vitest';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  planFile,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  whenEventsAreRead,
  whenPlanIsApproved,
  whenPlanIsPresented,
  messages,
  block,
} from '../support/project.mjs';
import { thenValueIs, thenContains, thenObjectIncludes, thenEventsEqual } from '../support/assertions.mjs';

it("A plan missing a section is reported with that section's name. [AC0011.1]", () => {
  const folder = givenAWorkingBranch();
  for (const section of ['Why', 'What', 'How', 'Requirements', 'Predicted failures', 'Test delta']) {
    const plan = completePlan.replace(new RegExp('## ' + section + '\\n\\n[^\\n]+\\n'), '');
    givenFileContents(folder, planFile, plan);

    const replyRun = whenPlanIsPresented(folder);
    const reply = thenHookReplies(replyRun, 0);
    thenValueIs(reply.needsCorrection, true);
    const diagnostic = messages(reply).split('\n\n')[1];
    thenContains(diagnostic, 'section ' + section + ' is missing');
  }
});

it('An empty section is reported, even when it holds only comments or subheadings. [AC0011.2]', () => {
  const folder = givenAWorkingBranch();
  for (const empty of ['', '<!-- note -->', '### Heading', '<!-- note -->\n### Heading']) {
    givenFileContents(folder, planFile, completePlan.replace('Concrete content.', empty));

    const replyRun = whenPlanIsPresented(folder);
    const reply = thenHookReplies(replyRun, 0);
    thenValueIs(reply.needsCorrection, true);
    const diagnostic = messages(reply).split('\n\n')[1];
    thenContains(diagnostic, 'section Why is empty');
  }
});

it('A duplicate section, a section out of order and a leftover template placeholder are reported together. [AC0011.3]', () => {
  const folder = givenAWorkingBranch();
  const plan =
    completePlan
      .replace('## Why', '## Swap')
      .replace('## What', '## Why')
      .replace('## Swap', '## What')
      .replace('Concrete content.', '{{WHAT}}') + '\n## Why\nAnother reason.\n';
  givenFileContents(folder, planFile, plan);

  const replyRun = whenPlanIsPresented(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.needsCorrection, true);
  const why = messages(reply).split('\n\n')[1];
  for (const problem of [
    'section Why appears more than once',
    'section Why is out of order',
    'section What still contains a template placeholder',
  ])
    thenContains(why, problem);
});

it('A heading at the wrong level, case or spacing is named as a near miss and not accepted. [AC0011.4]', () => {
  const folder = givenAWorkingBranch();
  for (const heading of ['### Predicted failures', '## Predicted Failures', '## Predicted  failures']) {
    givenFileContents(folder, planFile, completePlan.replace('## Predicted failures', heading));

    const replyRun = whenPlanIsPresented(folder);
    const reply = thenHookReplies(replyRun, 0);
    thenValueIs(reply.needsCorrection, true);
    const why = messages(reply).split('\n\n')[1];
    thenContains(why, 'section Predicted failures is missing; found `' + heading + '`');
  }
});

it('Headings inside fenced examples, blockquotes, indented code or comments do not count as sections. [AC0011.5]', () => {
  const folder = givenAWorkingBranch();
  for (const example of ['```markdown\n## Why\n```', '> ## Why', '    ## Why', '<!--\n## Why\n-->']) {
    givenFileContents(folder, planFile, completePlan.replace('## Why', example));

    const replyRun = whenPlanIsPresented(folder);
    const reply = thenHookReplies(replyRun, 0);
    thenValueIs(reply.needsCorrection, true);
    const diagnostic = messages(reply).split('\n\n')[1];
    thenContains(diagnostic, 'section Why is missing');
  }
});

it('Requirements and Predicted failures may say None. [AC0011.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, completePlan.replaceAll('None.', 'None'));

  const presentationRun = whenPlanIsPresented(folder);
  const presentation = thenHookReplies(presentationRun, 0);
  thenObjectIncludes(presentation, { needsCorrection: false, messages: [] });
});

it('The closing workflow block does not count as content for the section above it. [AC0011.7]', () => {
  const folder = givenAWorkingBranch();
  const plan =
    completePlan.slice(0, completePlan.lastIndexOf('Concrete content.')) + block('test-only: true');
  givenFileContents(folder, planFile, plan);

  const replyRun = whenPlanIsPresented(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.needsCorrection, true);
  const diagnostic = messages(reply).split('\n\n')[1];
  thenContains(diagnostic, 'section Test delta is empty');
});

it('A block holding any other key, a misspelling included, is refused, and every problem is named. [AC0012.1]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, completePlan + block('test-onyl: true\nextra-key: false'));

  const replyRun = whenPlanIsApproved(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.recorded, false);
  thenEventsEqual(folder, []);
  const reasons = messages(reply).split('\n\n')[1];
  thenContains(reasons, 'test-onyl');
  thenContains(reasons, 'extra-key');
});

it('A test-only value that is not true or false is refused. [AC0012.2]', () => {
  const folder = givenAWorkingBranch();
  for (const value of ['"true"', '1', '[]']) {
    givenFileContents(folder, planFile, completePlan + block('test-only: ' + value));

    const replyRun = whenPlanIsApproved(folder);
    const reply = thenHookReplies(replyRun, 0);
    thenValueIs(reply.recorded, false);
    thenEventsEqual(folder, []);
    const diagnostic = messages(reply).split('\n\n')[1];
    thenContains(diagnostic, 'must be true or false');
  }
});

it('Every wrong field in every requirement-changes entry is named. [AC0012.3]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(
    folder,
    planFile,
    completePlan +
      block(
        'requirement-changes:\n  - {id: bad, status: wrong, statement: 5, scenarios: 7}\n  - {id: AC0001, renumberedFrom: INV0001, status: other, statement: "", scenarios: [5]}',
      ),
  );

  const replyRun = whenPlanIsApproved(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.recorded, false);
  thenEventsEqual(folder, []);
  const why = messages(reply).split('\n\n')[1];
  for (const [entry, fields] of [
    ['bad (entry 1)', ['id', 'status', 'statement', 'scenarios']],
    ['AC0001 (entry 2)', ['renumberedFrom', 'status', 'statement', 'scenarios']],
  ]) {
    for (const field of fields) thenContains(why, entry + ': `' + field + '` must');
  }
});

it('Each predicted-failures entry must be a scenario id, a repository path, or path::test name, and each bad entry is named with the reason. [AC0012.4]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(
    folder,
    planFile,
    completePlan + block('predicted-failures: [AC0002, "../file", "/tmp/file", "file::", 42]'),
  );

  const replyRun = whenPlanIsApproved(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.recorded, false);
  thenEventsEqual(folder, []);
  const why = messages(reply).split('\n\n')[1];
  for (const [i, reason] of [
    'names the requirement',
    'leaves the repository',
    'is an absolute path',
    'names no test after',
    'must be a string',
  ].entries())
    thenContains(why, 'entry ' + (i + 1) + ': ' + reason);
  givenFileContents(
    folder,
    planFile,
    completePlan + block('predicted-failures: [AC0002.1, tests/add.sh, "tests/add.sh::adds"]'),
  );

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
});

it("A declaration quoted in the plan's prose declares nothing. [AC0012.5]", () => {
  const folder = givenAWorkingBranch();
  givenFileContents(
    folder,
    planFile,
    completePlan + '\nThe quoted declaration `test-only: true` is an example.\n',
  );

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const [event] = whenEventsAreRead(folder);
  thenObjectIncludes(event.payload, { testOnly: false, requirementChanges: [] });
});

it('An example block labelled yaml at the end of the plan declares nothing. [AC0012.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, completePlan + '\n```yaml\ntest-only: true\n```\n');

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const [event] = whenEventsAreRead(folder);
  thenObjectIncludes(event.payload, { testOnly: false, requirementChanges: [] });
});

it('The block is read as plain YAML and runs no code. [AC0012.7]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, completePlan + block('---js\ntest-only: true'));

  const replyRun = whenPlanIsApproved(folder);
  const reply = thenHookReplies(replyRun, 0);
  thenValueIs(reply.recorded, false);
  thenEventsEqual(folder, []);
  const diagnostic = messages(reply).split('\n\n')[1];
  thenContains(diagnostic, 'would end the YAML');
  const literal = '2 + 2';
  givenFileContents(
    folder,
    planFile,
    completePlan + block('requirement-changes:\n  - {id: AC0001, status: active, statement: "2 + 2"}'),
  );

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const [event] = whenEventsAreRead(folder);
  thenValueIs(event.payload.requirementChanges[0].statement, literal);
});
