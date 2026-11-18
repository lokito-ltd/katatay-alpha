#!/usr/bin/env node
/** Check a presented plan without approving it or running any phase work. */
import { checkPresentedPlan } from '../presented-plan.mjs';
import { answer } from './messages.mjs';
import { serve, versionShape } from './io.mjs';

export const SHAPE = { version: versionShape, planFile: 'nonempty string' };

export function onPlanPresented({ planFile }, where) {
  const { needsCorrection, messages } = checkPresentedPlan(planFile, where);
  return answer({ needsCorrection }, messages);
}

await serve(import.meta.url, 'plan-presented', SHAPE, onPlanPresented);
