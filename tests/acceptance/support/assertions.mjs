import { expect } from 'vitest';
import { thenHookReplies } from './ktty.mjs';
import { exists, whenEventsAreRead, whenFileIsRead, whenGitRuns, whenJsonIsRead } from './project.mjs';

export function thenValueIs(actual, expected, detail) {
  expect(actual, detail).toBe(expected);
}

export function thenValuesEqual(actual, expected, detail) {
  expect(actual, detail).toEqual(expected);
}

export function thenTextMatches(actual, expected, detail) {
  expect(actual, detail).toMatch(expected);
}

export function thenContains(actual, expected, detail) {
  expect(actual, detail).toContain(expected);
}

export function thenLengthIs(actual, expected, detail) {
  expect(actual, detail).toHaveLength(expected);
}

export function thenObjectIncludes(actual, expected, detail) {
  expect(actual, detail).toMatchObject(expected);
}

export function thenContainsEntry(actual, expected, detail) {
  expect(actual, detail).toContainEqual(expected);
}

export function thenValueDiffers(actual, expected, detail) {
  expect(actual, detail).not.toBe(expected);
}

export function thenTextDoesNotMatch(actual, expected, detail) {
  expect(actual, detail).not.toMatch(expected);
}

export function thenOmits(actual, expected, detail) {
  expect(actual, detail).not.toContain(expected);
}

export function thenStdoutContains(run, text) {
  expect(run.stdout).toContain(text);
}

export function thenStderrContains(run, text) {
  expect(run.stderr).toContain(text);
}

export function thenEventsEqual(folder, expected, branch) {
  expect(whenEventsAreRead(folder, branch)).toEqual(expected);
}

export function thenEventNamesEqual(folder, expected) {
  const events = whenEventsAreRead(folder);
  expect(events.map((event) => event.event)).toEqual(expected);
}

export function thenPathsExist(folder, paths, expected) {
  for (const path of paths) expect(exists(folder, path), path).toBe(expected);
}

export function thenFileContains(folder, path, expected) {
  expect(whenFileIsRead(folder, path), path).toBe(expected);
}

export function thenJsonIncludes(folder, path, expected) {
  expect(whenJsonIsRead(folder, path), path).toMatchObject(expected);
}

export function thenGitPrints(folder, args, expected) {
  expect(whenGitRuns(folder, ...args)).toBe(expected);
}

export function thenHookAnswers(run, expected) {
  const answer = thenHookReplies(run, 0);
  expect(answer).toMatchObject(expected);
  return answer;
}

export function thenStateShowsPhase(run, phase) {
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toMatch(new RegExp('^phase\\s+' + phase + '$', 'm'));
}
