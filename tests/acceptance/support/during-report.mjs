import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Pause the report's Git size query after record selected its receipt. Only the
// record subprocess gets this shim. Git in the rest of the fixture runs normally.
export function givenAReportBarrier(folder) {
  const bin = join(folder.env.PATH.split(delimiter)[0], 'report-only');
  mkdirSync(bin);
  const git = join(bin, 'git');
  const ready = join(bin, 'gathering');
  const release = join(bin, 'continue');
  writeFileSync(git, [
    '#!/bin/sh',
    'if test "$1" = diff && test "$2" = --numstat && test -n "$REPORT_READY"; then',
    '  : > "$REPORT_READY"',
    '  tries=0',
    '  until test -f "$REPORT_RELEASE"; do',
    '    tries=$((tries+1)); test "$tries" -lt 400 || exit 124',
    '    sleep 0.05',
    '  done',
    'fi',
    'PATH="$ORIGINAL_PATH" exec git "$@"', '',
  ].join('\n'));
  chmodSync(git, 0o755);
  return { bin, ready, release };
}

// Start record, wait for the ready marker, perform the supplied fixture edit,
// then let the report finish. The deadline also catches a binary that never
// reaches the synchronization point.
export async function whenRecordingDuring(folder, barrier, change) {
  const env = { ...folder.env, PATH: barrier.bin + delimiter + folder.env.PATH, ORIGINAL_PATH: folder.env.PATH,
    REPORT_READY: barrier.ready, REPORT_RELEASE: barrier.release };
  const finished = new Promise(resolve => {
    const child = execFile('ktty', ['on', 'prompt'], { cwd: folder.cwd, env, timeout: 25000 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ version: 1, prompt: 'record' }));
  });
  try {
    const deadline = Date.now() + 18000;
    while (!existsSync(barrier.ready)) {
      if (Date.now() >= deadline) throw new Error('record never reached the Git report query');
      await delay(20);
    }
    change();
  } finally {
    writeFileSync(barrier.release, '');
    await finished;
  }
  return finished;
}
