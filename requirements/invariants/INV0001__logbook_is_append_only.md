---
status: active
---

The logbook is append-only: each event is a new numbered file, and Katatay never rewrites or removes an event file.

## Scenarios

- [INV0001.1] Appending over an existing event file is refused.
- [INV0001.2] A reset is recorded by appending, and leaves every earlier event in place.
- [INV0001.3] Reading an old event never rewrites its bytes.
- [INV0001.4] A committed event renamed out of the chain is caught.
- [INV0001.5] A write, by an editing tool or the shell, into .katatay/state/ is denied.

## Why

Events are committed and never rewritten. Readers ignore unknown fields rather
than migrate, because dropping a field would otherwise break every old logbook.

A rewritten first event is caught only by git, not by the hash chain. That
limit is accepted on purpose: the logbook is committed so git can witness it.
