import { fileURLToPath } from 'node:url';
import { loadCatalogue, scenarioText, type Requirement } from '../requirements/parse.js';
import { matchesAcceptance } from '../workflow/adapter.mjs';
import { TargetError } from '../workflow/target.mjs';
import { sameWords, taggedTests, withoutTags, type NotEvidence, type TaggedTest } from './tags.js';
import { readTestRun, type LeftOutFile } from './test-run.js';

export interface TraceProblem {
  id: string;
  message: string;
}

/**
 * Why none of a requirement's or a scenario's tests count, for its message. The
 * reasons are listed in the order they are found among the tests, without
 * repeats, so a mix reads as one.
 */
const WHY: Record<NotEvidence, string> = {
  skipped: 'skipped — a test that may not run is not evidence',
  inverted: 'marked as expected to fail — a test that passes when its body fails proves the opposite of its title',
};

const whyNone = (tests: TaggedTest[]): string =>
  [...new Set(tests.map((t) => t.notEvidence!))].map((reason) => WHY[reason]).join('; or ');

/**
 * Enforces the promise the `active` status makes: a requirement claiming to be
 * built has evidence, and that evidence proves the behaviour rather than only
 * its parts.
 *
 * `accepted` requirements are deliberately exempt. They are agreed but unbuilt,
 * and demanding evidence for them would make it impossible to agree a
 * requirement before implementing it.
 */
export function trace(catalogue: Requirement[], tests: TaggedTest[], leftOut: LeftOutFile[] = []): TraceProblem[] {
  tests = tests.filter((test) => matchesAcceptance(test.file));
  leftOut = leftOut.filter((entry) => matchesAcceptance(entry.file));
  const problems: TraceProblem[] = [...leftOutProblems(leftOut)];
  const byId = new Map(catalogue.map((r) => [r.id, r]));
  // Reported once, by `leftOutProblems`, rather than again as carrying no test.
  const inLeftOut = new Set(leftOut.flatMap((f) => [...f.ids, ...f.scenarios]));

  const covering = new Map<string, TaggedTest[]>();
  for (const test of tests) {
    for (const id of test.ids) {
      if (!covering.has(id)) covering.set(id, []);
      covering.get(id)!.push(test);
    }
  }

  for (const requirement of catalogue) {
    if (requirement.status !== 'active') continue;
    // A requirement with scenarios is held to them one by one, in
    // `scenarioTrace`. Checking it here as well would report every gap twice.
    if (requirement.scenarios.length > 0) continue;
    const carriers = covering.get(requirement.id) ?? [];
    // A test that is not evidence is still read for everything else below,
    // its title and its tags, so skipping it cannot hide a mismatch. It only
    // stops counting. See `NotEvidence` in `tags.ts`.
    const evidence = carriers.filter((test) => test.notEvidence === null);

    if (evidence.length === 0) {
      if (carriers.length === 0 && inLeftOut.has(requirement.id)) continue;
      problems.push({
        id: requirement.id,
        message: carriers.length === 0
          ? `is active but no acceptance test carries [${requirement.id}]`
          : `is active but every test carrying [${requirement.id}] is ${whyNone(carriers)}`,
      });
    }
  }

  problems.push(...scenarioTrace(catalogue, tests, inLeftOut));

  for (const [id, tests_] of covering) {
    const requirement = byId.get(id);
    const where = tests_[0]!.file;
    if (!requirement) {
      problems.push({ id, message: `tagged in ${where} but no such requirement exists` });
    } else if (requirement.status === 'withdrawn' || requirement.status === 'superseded') {
      problems.push({
        id,
        message: `tagged in ${where} but the requirement is ${requirement.status} — retire the evidence with it`,
      });
    }
  }

  return problems;
}

/**
 * Holds an acceptance criterion's scenarios and its tests to the same list.
 *
 * The scenarios say what the AC promises, and each test title says what that
 * test proves. The two must say the same thing: a scenario with no test is a
 * promise nobody checks, and a test that matches no scenario proves something
 * the AC never promised. Before this, the two drifted apart unnoticed. AC0005
 * was tested for listing the newest project first while saying nothing about
 * order.
 *
 * So the title must be the scenario's text, word for word. An id alone would
 * link them, but the wording at each end would still drift apart. Words are
 * compared and nothing else, by `sameWords`: case and punctuation are
 * ignored, and the group names a report puts in front may fall away.
 *
 * A test names one scenario. Two tags would ask one title to match two
 * different texts. A bare `[AC0009]` on an acceptance criterion names no
 * scenario, so nobody could check what it proves. Invariants keep bare tags,
 * because how an invariant is evidenced is still open.
 */
export function scenarioTrace(catalogue: Requirement[], tests: TaggedTest[], inLeftOut: Set<string> = new Set()): TraceProblem[] {
  const problems: TraceProblem[] = [];
  const byId = new Map(catalogue.map((r) => [r.id, r]));
  const scenarioById = new Map(catalogue.flatMap((r) => r.scenarios.map((s) => [s.id, s] as const)));

  for (const test of tests) {
    for (const id of test.bare) {
      if (byId.get(id)?.type === 'acceptance') {
        problems.push({ id, message: `tagged bare in ${test.file} ("${test.title}") — tag the scenario it proves, as [${id}.N]` });
      }
    }
    if (test.scenarios.length > 1) {
      problems.push({
        id: test.scenarios[0]!,
        message: `${test.file} ("${test.title}") names ${test.scenarios.length} scenarios — a test proves one, so its title can match one`,
      });
      continue;
    }
    const [scenarioId] = test.scenarios;
    if (!scenarioId) continue;
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) {
      // An unknown requirement is reported once, below, as it always was.
      if (byId.has(scenarioId.split('.')[0]!)) {
        problems.push({ id: scenarioId, message: `tagged in ${test.file} but no such scenario exists` });
      }
      continue;
    }
    if (!sameWords(test.title, scenario.text)) {
      problems.push({
        id: scenarioId,
        message: `test title in ${test.file} does not match its scenario\n      scenario: ${scenario.text}\n      test:     ${scenarioText(withoutTags(test.title))}`,
      });
    }
  }

  for (const requirement of catalogue) {
    if (requirement.status !== 'active') continue;
    for (const scenario of requirement.scenarios) {
      const carriers = tests.filter((t) => t.scenarios.includes(scenario.id));
      const evidence = carriers.filter((t) => t.notEvidence === null);
      if (carriers.length === 0) {
        if (inLeftOut.has(scenario.id)) continue;
        problems.push({ id: scenario.id, message: `is a scenario of an active requirement but no acceptance test carries [${scenario.id}]` });
      } else if (evidence.length === 0) {
        problems.push({ id: scenario.id, message: `is a scenario of an active requirement but every test carrying it is ${whyNone(carriers)}` });
      }
    }
  }

  return problems;
}

/**
 * What a failing trace prints, heading first, so its details do not sit under
 * the success line of the check `workflow verify` ran before it.
 */
export function failureReport(problems: TraceProblem[]): string[] {
  return [
    `req:trace — ${problems.length} problem(s)`,
    ...problems.map((p) => `  ${p.id}: ${p.message}`),
  ];
}

/**
 * The check as `workflow req trace` runs it, and as the referee verify runs it:
 * the catalogue against every tagged test the adapter lists. Prints what it
 * found, and returns whether it passed.
 */
export function runTrace(run = readTestRun()): boolean {
  const problems = trace(loadCatalogue(), taggedTests(run), run.leftOut);
  if (problems.length > 0) {
    for (const line of failureReport(problems)) console.error(line);
    return false;
  }
  console.log('req:trace — every active requirement has evidence');
  return true;
}

/**
 * A test file the report leaves out failed to load, or the run never reached
 * it. Every tag found in its text fails, each on its own line, because the
 * test that would have proved it did not run. Its tags are found by searching
 * the whole file, so a tag in a string that is no test's title fails too.
 * That is the strict reading, and a file that fails to load is a problem
 * whichever tag it holds.
 */
function leftOutProblems(leftOut: LeftOutFile[]): TraceProblem[] {
  return leftOut.flatMap((file) => [...new Set([...file.scenarios, ...file.bare])].map((id) => ({
    id,
    message: `tagged in ${file.file}, which the test report leaves out — the file failed to load, or the run never reached it`,
  })));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (!runTrace()) process.exit(1);
  } catch (error) {
    // The adapter failed, or is not configured. That is a refusal, said as
    // one, rather than a stack trace.
    if (!(error instanceof TargetError)) throw error;
    console.error(`req:trace: refused — ${error.message}`);
    process.exit(1);
  }
}
