---
status: active
---

The risk level is HIGH, MEDIUM or LOW and measures only the plan's missed predictions and test regressions, with the highest level found winning.

## Scenarios

- [AC0028.1] A failing invariant test makes the level HIGH, even when it was predicted.
- [AC0028.2] An unpredicted test file that never ran makes it HIGH, while a predicted one raises nothing but is still named.
- [AC0028.3] Surprises at 20% or more of the predicted tests make it HIGH, and one below that makes it MEDIUM.
- [AC0028.4] Over-predictions at 20% or more of the predicted tests make it HIGH, and one below that makes it MEDIUM.
- [AC0028.5] Any surprise when nothing was predicted makes it HIGH.
- [AC0028.6] Every predicted test failing and nothing else failing is LOW, with no reasons.
- [AC0028.7] Each reason starts with the level it raises the report to, in the order shown.

## Why

A surprise counts twice over: the plan missed an effect, and a test that should
still pass broke. An over-prediction shows the plan did not know what the
change would do, and it is also what padding looks like, a plan listing every
test to hide its surprises.

Shares are measured against the size of the prediction, because a share of the
whole suite gets weaker with every test the project adds.

Changes in high-risk files used to raise the level, but that said nothing about
either measure and made most triages HIGH. Those files now appear only under
"Must look". A failing invariant is never an acceptable place to stop, and
predicting it does not excuse it. An unpredicted file that never ran is HIGH
because on 2026-10-04 a test server failed to start, nothing ran, and triage
recorded LOW. A predicted file that never ran raises nothing, as the operator
decided on 2026-11-01.
