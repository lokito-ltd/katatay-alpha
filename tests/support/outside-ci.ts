/**
 * Runs in every test file of the `fast` project, before the file loads: the
 * tests run as if outside CI, whatever the runner sets.
 *
 * The workflow's checks act differently in CI. `req:guard` and `state:verify`
 * fetch the target from the server first, and fail when it does not answer.
 * Many tests run those checks for real, in fixture repositories whose remote
 * does not exist, and start them as child processes, which inherit this
 * worker's environment. With `CI` set by the runner, as GitLab sets it on
 * every job, 11 of them failed on 2026-10-20 while passing on a laptop. A
 * test's result must not depend on where it runs.
 *
 * Removed here, once, rather than at each place a test starts a process: 19
 * test files start one, and the next one written would repeat the leak. A test
 * that wants CI behaviour says so, by passing `{ CI: 'true' }` as the
 * environment it gives a check.
 *
 * `CI` only, because it is the one variable the tools read.
 */
delete process.env.CI;
