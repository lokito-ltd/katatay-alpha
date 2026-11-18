/**
 * `askAppServer`, against stand-ins for `codex app-server` that answer,
 * crash, answer with an error, print something else, or never answer. The
 * real server was asked by hand on 2026-10-29, and its answers are the
 * fixtures `setup.test.mjs` reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askAppServer } from './app-server.mjs';

let dir;

/**
 * A stand-in server. It reads one JSON-RPC message per line and hands each to
 * `reply`, a function body that sees `message` and `send`.
 */
const server = (reply) => {
  const path = join(dir, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  ${reply}
});
`);
  return { program: process.execPath, args: [path] };
};

/** One that answers like Codex: the handshake, then each method with its params echoed. */
const ANSWERS = `
  if (message.method === 'initialize') { send({ method: 'some/notification' }); send({ id: message.id, result: { userAgent: 'stub' } }); }
  else if (message.method === 'initialized') process.stderr.write('initialized\\n');
  else send({ id: message.id, result: { method: message.method, params: message.params } });
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-server-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const requests = [{ method: 'hooks/list', params: { cwds: ['/repo'] } }, { method: 'config/read', params: { cwd: '/repo' } }];

describe('asking Codex\'s app server', () => {
  it('opens with the handshake, then gives one answer per request, in order', async () => {
    expect(await askAppServer(requests, { cwd: dir, ...server(ANSWERS) })).toEqual({
      answers: [{ method: 'hooks/list', params: { cwds: ['/repo'] } }, { method: 'config/read', params: { cwd: '/repo' } }],
    });
  });

  it('gives no answers for no requests, once the handshake is done', async () => {
    expect(await askAppServer([], { cwd: dir, ...server(ANSWERS) })).toEqual({ answers: [] });
  });

  it('says why when the program cannot be started', async () => {
    const asked = await askAppServer(requests, { cwd: dir, program: join(dir, 'no-such-codex') });
    expect(asked.problem).toMatch(/could not be started/);
  });

  it('says why when the server exits before it answers', async () => {
    const asked = await askAppServer(requests, { cwd: dir, ...server('process.exit(3);') });
    expect(asked.problem).toMatch(/exited with 3 before it answered/);
  });

  // Nothing else says why `codex app-server` exited, as it did on 2026-11-04.
  it('names the last lines the server wrote to stderr when it exits', async () => {
    const asked = await askAppServer(requests, {
      cwd: dir,
      ...server(`process.stderr.write('one\\ntwo\\n\\nthree\\nfour: bad config\\n', () => process.exit(3));`),
    });
    expect(asked.problem).toMatch(/exited with 3 before it answered\. It wrote:\ntwo\nthree\nfour: bad config$/);
  });

  it('says only that it exited when the server wrote nothing to stderr', async () => {
    const stub = server('process.exit(3);');
    const asked = await askAppServer(requests, { cwd: dir, ...stub });
    expect(asked.problem).toBe(`\`${stub.program} ${stub.args.join(' ')}\` exited with 3 before it answered`);
  });

  it('names a single stderr line as it was written, with the spaces around it trimmed', async () => {
    const asked = await askAppServer(requests, {
      cwd: dir,
      ...server(`process.stderr.write('  only line  \\n', () => process.exit(3));`),
    });
    expect(asked.problem).toMatch(/before it answered\. It wrote:\nonly line$/);
  });

  // A server that writes a great deal before exiting is kept to its last 2,000 characters.
  it('keeps only the last 2,000 characters of stderr', async () => {
    const asked = await askAppServer(requests, {
      cwd: dir,
      ...server(`process.stderr.write('y'.repeat(500) + 'x'.repeat(2500), () => process.exit(3));`),
    });
    expect(asked.problem.split('\n').at(-1)).toBe('x'.repeat(2000));
  });

  it('names every argument it started the server with, separated by spaces', async () => {
    const stub = server('process.exit(3);');
    const asked = await askAppServer(requests, { cwd: dir, program: stub.program, args: [...stub.args, 'app-server'] });
    expect(asked.problem.startsWith(`\`${stub.program} ${stub.args[0]} app-server\` exited with 3`)).toBe(true);
  });

  it('says why when the server answers a request with an error', async () => {
    const asked = await askAppServer(requests, {
      cwd: dir,
      ...server(`if (message.method === 'initialize') send({ id: message.id, result: {} }); else if (message.id) send({ id: message.id, error: { code: -32601, message: 'no such method' } });`),
    });
    expect(asked).toEqual({ problem: 'Codex answered `hooks/list` with an error: no such method' });
  });

  it('says why when the server prints a line that is not JSON', async () => {
    const asked = await askAppServer(requests, { cwd: dir, ...server(`process.stdout.write('hello\\n');`) });
    expect(asked.problem).toMatch(/printed a line that is not JSON/);
  });

  it('gives up when the server does not answer in time', async () => {
    const asked = await askAppServer(requests, { cwd: dir, timeoutMs: 300, ...server('') });
    expect(asked.problem).toMatch(/did not answer within 0.3 seconds/);
  });
});

describe('reading what the app server prints', () => {
  it('sends Codex who is asking, and no capabilities', async () => {
    const asked = await askAppServer([{ method: 'echo', params: {} }], {
      cwd: dir,
      ...server(`if (message.method === 'initialize') { globalThis.init = message.params; send({ id: message.id, result: {} }); }
        else if (message.id) send({ id: message.id, result: globalThis.init });`),
    });
    expect(asked.answers[0]).toEqual({ clientInfo: { name: 'workflow-check', title: null, version: '1' }, capabilities: null });
  });

  // Codex writes one JSON object per line, but a pipe may cut a line anywhere.
  it('reads lines split across writes, blank lines, and notifications with no id', async () => {
    const asked = await askAppServer([{ method: 'one', params: {} }], {
      cwd: dir,
      ...server(`if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.id) { const text = JSON.stringify({ id: message.id, result: 'answer' }); process.stdout.write('\\n  \\n{"method":"note"}\\n' + text.slice(0, 5)); setTimeout(() => process.stdout.write(text.slice(5) + '\\n'), 20); }`),
    });
    expect(asked).toEqual({ answers: ['answer'] });
  });

  it('ignores an answer to a request it is not waiting for', async () => {
    const asked = await askAppServer([{ method: 'one', params: {} }], {
      cwd: dir,
      ...server(`if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.id) { send({ id: 9, result: 'stray' }); send({ id: message.id, result: 'answer' }); }`),
    });
    expect(asked).toEqual({ answers: ['answer'] });
  });

  it('names the request an error answers, and an error with no message by its JSON', async () => {
    const asked = await askAppServer(requests, {
      cwd: dir,
      ...server(`if (message.method === 'initialize') send({ id: message.id, result: {} }); else if (message.id === 2) send({ id: 2, error: { code: 1 } }); else if (message.id) send({ id: message.id, result: {} });`),
    });
    expect(asked).toEqual({ problem: 'Codex answered `config/read` with an error: {"code":1}' });
  });

  it('names initialize when the handshake itself fails', async () => {
    const asked = await askAppServer(requests, { cwd: dir, ...server(`send({ id: message.id, error: { message: 'not now' } });`) });
    expect(asked).toEqual({ problem: 'Codex answered `initialize` with an error: not now' });
  });

  it('names the program and its arguments when it gives up', async () => {
    const stub = server('');
    const asked = await askAppServer(requests, { cwd: dir, timeoutMs: 200, ...stub });
    expect(asked.problem).toBe(`\`${stub.program} ${stub.args.join(' ')}\` did not answer within 0.2 seconds`);
  });
});
