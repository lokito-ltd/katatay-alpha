/**
 * Asking Codex itself about its setup, through its app server.
 *
 * `codex app-server` speaks JSON-RPC, one JSON object per line, on stdin and
 * stdout. A client opens with `initialize`, waits for the answer, sends the
 * `initialized` notification, and then asks. Codex's TUI asks `hooks/list` the
 * same way to draw its `/hooks` screen. Measured on 2026-10-29, a fresh
 * server answered in 0.1 to 0.25 seconds, cheap enough to ask on every prompt.
 *
 * Each call starts a server of its own and stops it after the last answer.
 * Nothing is left running between prompts, and no daemon is relied on.
 */
import { spawn } from 'node:child_process';

/** The client's name as Codex logs it. */
const CLIENT = { name: 'workflow-check', title: null, version: '1' };

/** How much of the server's stderr is kept, from the end. */
const STDERR_KEPT = 2000;

/**
 * The problem, followed by the last three lines the server wrote to stderr,
 * when it wrote any. Nothing else says why `codex app-server` exited.
 */
export function withLastLines(problem, stderr) {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-3);
  return lines.length === 0 ? problem : `${problem}. It wrote:\n${lines.join('\n')}`;
}

/**
 * Asks each `{ method, params }` in turn, from one server.
 *
 * Returns `{ answers }`, one `result` per request in the same order, or
 * `{ problem }` with a sentence saying why there are none: the program could
 * not start, it exited, it answered a request with an error, it printed a
 * line that is not JSON, or it took longer than `timeoutMs` in all. A problem
 * is never read as an answer.
 *
 * `program` and `args` are what to start, parameters so a test can point them
 * at a stub. They are never read from the environment: a variable a session
 * could set would let it point the check at a stand-in that reports nothing
 * wrong.
 *
 * @param {{ method: string, params: object }[]} requests
 * @param {{ cwd: string, program?: string, args?: string[], timeoutMs?: number }} options
 * @returns {Promise<{ answers: object[] } | { problem: string }>}
 */
export function askAppServer(requests, { cwd, program = 'codex', args = ['app-server'], timeoutMs = 10_000 }) {
  return new Promise((done) => {
    let settled = false;
    let child;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      done(outcome);
    };
    const timer = setTimeout(() => finish({ problem: `\`${program} ${args.join(' ')}\` did not answer within ${timeoutMs / 1000} seconds` }), timeoutMs);

    try {
      child = spawn(program, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ problem: `\`${program}\` could not be started: ${error.message}` });
      return;
    }
    // Kept so an exit can say why. Only the end is kept, and it is read even
    // when unused, so a talkative server never stalls on a full pipe.
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-STDERR_KEPT); });
    child.on('error', (error) => finish({ problem: `\`${program}\` could not be started: ${error.message}` }));
    // `close` rather than `exit`: `exit` can come before the last of stderr,
    // and `close` comes once the process has exited and its pipes are shut.
    child.on('close', (code, signal) => finish({
      problem: withLastLines(`\`${program} ${args.join(' ')}\` exited with ${code ?? signal} before it answered`, errors),
    }));
    child.stdin.on('error', () => {});

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const answers = [];
    // Request ids: 0 is `initialize`, then 1, 2, … for the requests.
    const next = () => {
      const index = answers.length;
      if (index === requests.length) {
        finish({ answers });
        return;
      }
      send({ id: index + 1, method: requests[index].method, params: requests[index].params });
    };

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ problem: `\`${program} ${args.join(' ')}\` printed a line that is not JSON` });
          return;
        }
        // Notifications carry no id, and nothing here waits for one.
        if (typeof message?.id !== 'number') continue;
        const asked = message.id === 0 ? 'initialize' : requests[message.id - 1]?.method;
        if (message.error !== undefined) {
          finish({ problem: `Codex answered \`${asked}\` with an error: ${message.error?.message ?? JSON.stringify(message.error)}` });
          return;
        }
        if (message.id === 0) {
          send({ method: 'initialized' });
          next();
        } else if (message.id === answers.length + 1) {
          answers.push(message.result);
          next();
        }
      }
    });

    send({ id: 0, method: 'initialize', params: { clientInfo: CLIENT, capabilities: null } });
  });
}
