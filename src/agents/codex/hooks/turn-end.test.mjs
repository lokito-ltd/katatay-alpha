/** The hook's wiring, with a clock and referee we can inspect directly.
 * journey.test.mjs also starts the real hook and referee as processes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  input: vi.fn(), leave: vi.fn(), capture: vi.fn(), ask: vi.fn(), read: vi.fn(),
}));
vi.mock('node:fs', () => ({
  readFileSync: doubles.read, writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: vi.fn(),
}));
vi.mock('./io.mjs', () => ({
  input: doubles.input, leave: doubles.leave, enterRepository: () => '/fixture',
  joined: (...texts) => texts.filter(Boolean).join('\n\n') || undefined,
}));
vi.mock('../plans.mjs', () => ({ capturePlan: doubles.capture }));
vi.mock('./referee.mjs', () => ({ ask: doubles.ask }));
vi.mock('./drift.mjs', () => ({ expectFields: vi.fn() }));
vi.mock('./runaway.mjs', () => ({ runaway: () => null }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  doubles.input.mockResolvedValue({ cwd: '/fixture', transcript_path: '/transcript', turn_id: 'turn',
    last_assistant_message: null, stop_hook_active: false });
  doubles.read.mockReturnValue(JSON.stringify({ hooks: { Stop: [{ hooks: [{
    command: 'node src/agents/codex/hooks/turn-end.mjs', timeout: 900,
  }] }] } }));
  doubles.ask.mockReturnValue({ answer: { version: 1, keepWorking: false, messages: [] } });
});
afterEach(() => vi.restoreAllMocks());

describe('the Codex Stop wiring', () => {
  it('passes the exact message hint and charges capture time against the Stop timeout', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.spyOn(Atomics, 'wait').mockImplementation(() => { now += 1500; return 'timed-out'; });
    doubles.capture.mockImplementation((request, world) => {
      expect(request).toMatchObject({ lastAssistantMessage: null, turnId: 'turn', transcriptPath: '/transcript' });
      world.wait(1500);
      return { planFile: '/plan.md' };
    });
    await import('./turn-end.mjs');
    expect(sleep).toHaveBeenCalledOnce();
    expect(doubles.ask).toHaveBeenCalledWith('turn-end', {
      version: 1, stopRefusedBefore: false, secondsLeft: 898.5, planFile: '/plan.md',
    });
  });

  it.each([false, true])('includes the capture warning in the verification relay (already refused: %s)', async (stop_hook_active) => {
    doubles.input.mockResolvedValue({ cwd: '/fixture', stop_hook_active });
    doubles.capture.mockReturnValue({ problem: 'Capture failed.' });
    doubles.ask.mockReturnValue({ answer: { version: 1, keepWorking: false,
      messages: [{ code: 'verified', for: 'operator', text: 'Verification passed.' }] } });
    await import('./turn-end.mjs');
    expect(doubles.ask).toHaveBeenCalledWith('turn-end', expect.objectContaining({ planFile: null, stopRefusedBefore: stop_hook_active }));
    expect(doubles.leave).toHaveBeenCalledWith({
      decision: 'block', reason: expect.stringMatching(/verbatim[\s\S]*\n\nVerification passed\.\n\nCapture failed\.$/),
    });
  });

  it('keeps the referee refusal alongside the capture warning', async () => {
    doubles.capture.mockReturnValue({ problem: 'Capture failed.' });
    doubles.ask.mockReturnValue({ answer: { version: 1, keepWorking: true,
      messages: [{ code: 'verify_failed', for: 'agent', text: 'Fix the failed test.' }] } });
    await import('./turn-end.mjs');
    expect(doubles.leave).toHaveBeenCalledWith({ decision: 'block', reason: 'Fix the failed test.', systemMessage: 'Capture failed.' });
  });

  it('still asks the referee and warns when the Stop payload is null', async () => {
    doubles.input.mockResolvedValue(null);
    doubles.capture.mockReturnValue({ problem: 'No capture identifiers.' });
    await import('./turn-end.mjs');
    expect(doubles.capture).toHaveBeenCalledWith({ root: '/fixture', transcriptPath: undefined,
      turnId: undefined, lastAssistantMessage: undefined }, expect.any(Object));
    expect(doubles.ask).toHaveBeenCalledWith('turn-end', expect.objectContaining({ planFile: null }));
    expect(doubles.leave).toHaveBeenCalledWith({ systemMessage: 'No capture identifiers.' });
  });
});
