import { describe, expect, it } from 'vitest';
import { answerAndExit } from './stryker-answer.mjs';

/**
 * A stand-in process that records what happens, in order. Its streams and its
 * IPC channel call back only when the test says so, so each case decides when
 * the answer is sent and when each stream has emptied.
 */
const standIn = () => {
  const events = [];
  const pending = {};
  const stream = (name) => ({
    write: (chunk, done) => { events.push(`${name} write ${JSON.stringify(chunk)}`); pending[name] = done; },
  });
  return {
    events,
    finish: async (name) => { pending[name](); await new Promise((resolve) => setImmediate(resolve)); },
    proc: {
      send: (message, done) => { events.push(`send ${JSON.stringify(message)}`); pending.send = done; },
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      exit: (code) => { events.push(`exit ${code}`); },
    },
  };
};

describe('the child ends its run', () => {
  it('sends the answer, and waits for it to leave before anything else', async () => {
    const { events, finish, proc } = standIn();
    answerAndExit({ results: [] }, proc);
    expect(events).toEqual(['send {"results":[]}']);
    await finish('send');
    expect(events).toEqual(['send {"results":[]}', 'stdout write ""', 'stderr write ""']);
  });

  it('exits only once stdout and stderr have both emptied', async () => {
    const { events, finish, proc } = standIn();
    answerAndExit({ results: [] }, proc);
    await finish('send');
    await finish('stderr');
    expect(events).not.toContain('exit 0');
    await finish('stdout');
    expect(events.at(-1)).toBe('exit 0');
  });

  it('exits 0 with results and 1 with an error', async () => {
    const run = async (answer) => {
      const { events, finish, proc } = standIn();
      answerAndExit(answer, proc);
      await finish('send');
      await finish('stdout');
      await finish('stderr');
      return events.filter((event) => event.startsWith('exit'));
    };
    expect(await run({ results: [] })).toEqual(['exit 0']);
    expect(await run({ error: 'boom' })).toEqual(['exit 1']);
  });
});
