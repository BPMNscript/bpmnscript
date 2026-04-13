---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use Apache 2.0 License

## Context and Problem Statement

Which open-source license should BPMNscript use?

## Decision Drivers

* Compatibility with Langium (MIT) and bpmn-moddle (MIT)
* Compatibility with Operaton (Apache 2.0)
* Patent protection for contributors
* Permissive enough for academic and commercial use

## Considered Options

* Apache 2.0
* MIT
* EPL-2.0

## Decision Outcome

Chosen option: "Apache 2.0", because it provides an explicit patent grant (unlike MIT) and aligns with Operaton's license. It is compatible with both MIT and EPL-2.0 dependencies.

### Consequences

* Good, because Apache 2.0 includes an explicit patent grant, protecting contributors and users
* Good, because it is compatible with the licenses of all key dependencies
* Neutral, because Apache 2.0 requires a NOTICE file for derivative works, adding slight administrative overhead
