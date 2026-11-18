---
status: active
---

Each entry in `predicted-failures` names a set of tests; a failing test no entry names is a surprise, and a named test that passed is an over-prediction.

## Scenarios

- [AC0027.1] A scenario id predicts every acceptance test tagged with it.
- [AC0027.2] A file path predicts every test in that file.
- [AC0027.3] A path::name entry predicts one test, with or without its group names, ignoring case and punctuation.
- [AC0027.4] A file that failed to load is matched by its path, by any path::name in it, or by a scenario its text holds.
- [AC0027.5] An entry that matches no test counts as an over-prediction and is shown as matching no test.
- [AC0027.6] Predictions are read from the approved snapshot, not from the working plan file.
- [AC0027.7] Predicted failures are counted but not named, and each surprise is named by file and title without its message.

## Why

A plan predicts every test the change reaches, including through another
process, and lists what it expects and no more. A file entry over-predicts every
passing test in it, so tests are named one by one when only some fail.

An over-prediction means the change did not do what the plan thought, or the
test does not test what it says. Recorded predictions change only with a new
approval.
