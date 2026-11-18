/** Run one Codex turn end per worktree at a time. SQLite's OS lock goes
 * away when the process exits, even if it was killed. The empty database
 * holds no workflow state. Leave it in place so waiters lock the same file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCommand } from './referee.mjs';

const started = Date.now();
const input = JSON.parse(readFileSync(0, 'utf8'));
const key = createHash('sha256').update(realpathSync(process.cwd())).digest('hex');
// CLI and desktop processes can have different temporary directories.
const dir = join(homedir(), '.cache', 'workflow-codex-stop');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dir, key));
try {
  // Reserve a second to return a diagnostic if another hook uses the budget.
  const wait = Math.max(0, Math.floor(((input.secondsLeft ?? 1) - 1) * 1000));
  db.exec(`PRAGMA busy_timeout = ${wait}`);
  db.exec('BEGIN IMMEDIATE');
  input.secondsLeft -= (Date.now() - started) / 1000;
  const run = runCommand(process.argv.slice(2), input, 'inherit');
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  db.close();
}
