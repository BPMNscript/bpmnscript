# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An `on` handler can now name a host activity — `on <Host>: <trigger> … { }` —
  attaching directly to that one step as a `bpmn:boundaryEvent` instead of guarding
  its whole enclosing process or subprocess. Message, timer, signal, and
  conditional boundaries may interrupt their host or, with `alongside`, run beside
  it; error boundaries always interrupt; escalation boundaries may only attach to a
  subprocess, a call, or a user task. A hosted handler's body is self-contained —
  it ends on its own unless an explicit `goto` rejoins the main flow. Compensation
  has no attached form; it remains only the subprocess's own undo block.
  Importing an existing `bpmn:BoundaryEvent` is supported for the same six
  triggers; a compensation boundary event and any shape Operaton itself would
  reject are refused with a diagnostic naming the problem, never silently dropped.
