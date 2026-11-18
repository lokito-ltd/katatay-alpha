/**
 * Which tests a plan predicted would fail, and which of those passed.
 *
 * The plan lists them under `predicted-failures:` in its closing `workflow`
 * block, and the
 * approval keeps the list in the logbook (`parsePrediction` in
 * `src/workflow/plan.mjs` reads each entry). Every test the list does not
 * name is expected to pass. The triage then measures the plan: a failure the
 * list did not name is a surprise, and a named test that passed is an
 * over-prediction. See "The triage measures the plan" in `src/VISION.md`.
 *
 * Everything is counted in tests, not entries. A file entry names every test
 * in the file, which is what a file that fails to load does. When the file
 * loads and some of its tests pass, each of those is an over-prediction. An
 * entry that matches no test at all counts as one over-prediction of its own,
 * so a misspelt path is seen rather than predicting nothing in silence.
 */
import { parsePrediction } from '../workflow/plan.mjs';
import { sameWords } from './tags.js';
import { TEST_RUN } from './test-run.js';

/** What a prediction is matched against: one test's outcome, or one that
 *  stands for a whole file. */
export interface Predictable {
  file: string;
  title: string;
  scenarios?: string[];
  failed: boolean;
  wholeFile?: boolean;
}

type Entry = Exclude<ReturnType<typeof parsePrediction>, { problem: string }>;

/**
 * Whether one entry names one outcome.
 *
 * A whole-file outcome, a file that failed to load or does not compile with
 * no test of its own to blame, is named by any entry for that file, by any
 * test in it, and by any scenario its text holds. Any of its tests could be
 * the one the plan meant, and none of them ran to say otherwise.
 *
 * A test's name is compared as a scenario's text is (`sameWords`): by words,
 * with the group names in front allowed to fall away.
 */
export function names(entry: Entry, outcome: Predictable): boolean {
  if (outcome.file === TEST_RUN) return false;
  if (entry.kind === 'scenario') return (outcome.scenarios ?? []).includes(entry.id);
  if (outcome.file !== entry.file) return false;
  if (entry.kind === 'file' || outcome.wholeFile) return true;
  return sameWords(outcome.title, entry.name);
}

export interface Prediction<T extends Predictable> {
  /** Whether the plan named this outcome. */
  isPredicted: (outcome: T) => boolean;
  /** How many tests the plan predicted would fail: every outcome some entry
   *  names, and one for each entry that names none. The risk level measures
   *  surprises and over-predictions against this. */
  count: number;
  /** Each predicted test that passed, as `file — title`, then each entry that
   *  named no test, as `entry — matched no test`. */
  overPredicted: string[];
}

/**
 * The plan's prediction, applied to a run.
 *
 * An entry the logbook holds and `parsePrediction` cannot read was not written
 * by the approval, which checks every entry. It is counted as matching no
 * test, so it is said rather than dropped.
 */
export function applyPrediction<T extends Predictable>(entries: readonly string[], outcomes: readonly T[]): Prediction<T> {
  const predicted = new Set<T>();
  const unmatched: string[] = [];
  for (const text of entries) {
    const entry = parsePrediction(text);
    const hits = 'problem' in entry ? [] : outcomes.filter((outcome) => names(entry, outcome));
    if (hits.length === 0) unmatched.push(`${text} — matched no test`);
    for (const hit of hits) predicted.add(hit);
  }
  const passed = outcomes.filter((outcome) => predicted.has(outcome) && !outcome.failed);
  return {
    isPredicted: (outcome) => predicted.has(outcome),
    count: predicted.size + unmatched.length,
    overPredicted: [...passed.map((outcome) => `${outcome.file} — ${outcome.title}`), ...unmatched],
  };
}
