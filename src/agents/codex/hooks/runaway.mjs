/**
 * A hook spawned from inside a test run is never a real turn.
 *
 * A copy of the Claude adapter's guard, because each adapter ships on its own.
 * The story below happened to the Claude hooks, and the Codex turn end could
 * start the same loop.
 *
 * While the machine suite was being split, a harness bug left the fixture
 * repository unset on one code path, so `spawnSync` inherited this repository
 * instead. `turn-end.mjs` then ran against the real `.katatay/` logbook and the
 * real `workflow verify`, which runs the suite, which ran the hook again. Load
 * average reached 600 and the logbook on `main` grew by about 130 events that no
 * turn produced.
 *
 * The harness now refuses to spawn a hook with no fixture repository, which
 * closes that one path. This is the guard in the hook itself, so the failure is
 * unreachable from any future spawn the product suite grows.
 *
 * The obvious rule — refuse whenever `VITEST` or `TEST` is in the environment —
 * does not work, because the machine suite spawns these hooks as real processes
 * from inside vitest and those spawns are the contract under test. The
 * environment alone cannot tell a fixture run from a runaway.
 *
 * What tells them apart is which repository the hook is pointed at. The harness
 * sets `cwd` to a temporary fixture repository; the runaway inherited `cwd` and
 * got the repository the script file itself lives in. So the rule is both
 * halves together: under a test runner, and pointed at our own repository.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The repository these hooks belong to: `src/agents/codex/hooks` is four deep. */
export const OWN_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Set by vitest on everything it spawns, and by nothing in a real turn. Codex
 * sets neither.
 */
const TEST_RUNNER = ['VITEST', 'TEST'];

/**
 * The reason to refuse, or null to carry on.
 *
 * A message rather than a boolean, because whatever calls this has to say why
 * it stopped. A hook that exits quietly in the one case that matters looks
 * exactly like a hook that ran and found nothing wrong.
 *
 * Every input is a parameter so the decision can be tested without spawning
 * anything. Testing it for real would mean pointing `turn-end.mjs` at this
 * repository from inside the suite, which is the fork bomb if the guard is
 * wrong.
 */
export function runaway(cwd = process.cwd(), ownRepo = OWN_REPO, env = process.env) {
  const runner = TEST_RUNNER.find((name) => env[name]);
  if (!runner) return null;
  if (resolve(cwd) !== resolve(ownRepo)) return null;
  return `This hook was spawned from inside a test run (${runner} is set) and pointed at its own `
    + `repository, ${ownRepo}, rather than at a fixture. Nothing was read, recorded or run.\n\n`
    + 'A test that spawns a workflow hook must give it a repository of its own — see '
    + '`tests/support/machine/harness.mjs`. Left to run here, this hook would append to the real '
    + 'logbook and have the referee run the real verify, which starts the suite that spawned it.';
}
