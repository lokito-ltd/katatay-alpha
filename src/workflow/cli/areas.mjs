#!/usr/bin/env node
/**
 * `workflow areas` — where a reviewer must look.
 *
 * The `commit-message` skill pastes this output into the commit body as it
 * stands. See `../areas.mjs` for what the list holds and why a tool writes it.
 *
 * `--staged` is the commit message's list. It takes the must-look files from
 * what is staged, so a commit message never names a file the commit does not
 * contain. New coverage ignore comments are read from what is staged too.
 *
 * Without `--staged`, the must-look files come from the change against its
 * baseline.
 *
 * Prints nothing when there is nothing to look at. The skill leaves the
 * section out then, rather than writing a heading with nothing under it.
 */
import { current } from '../state.mjs';
import { gitLines } from '../git.mjs';
import { addedFiles, reviewSuppressions, changedFiles } from '../frozen.mjs';
import { renderAreas, reviewAreas } from '../areas.mjs';
import { TargetError } from '../target.mjs';

let state;
try {
  state = current();
} catch (error) {
  if (!(error instanceof TargetError)) throw error;
  console.error(`review:areas: refused — ${error.message}`);
  process.exit(1);
}

const staged = process.argv.includes('--staged');
const changed = staged
  ? gitLines(['diff', '--cached', '--name-only'])
  : changedFiles(state.baseline);

const added = addedFiles(state.baseline, { staged });
const { ignores, suppressed } = reviewSuppressions({ base: state.baseline, added, staged });

const lines = renderAreas(reviewAreas({ changed, added, ignores, suppressed }));
if (lines.length > 0) console.log(lines.join('\n'));
