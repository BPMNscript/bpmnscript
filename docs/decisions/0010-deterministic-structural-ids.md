---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Use Deterministic Structural Ids for Synthesized BPMN Elements

## Context and Problem Statement

The `astToIr` desugarer synthesizes BPMN elements that have no explicit id in the
DSL source: the exclusive gateway pair enclosing an `if`/`else`, the loop-head
gateway for `while`/`do…while`, the AND fork/join pair for `parallel`, and implicit
start/end events. The `irToDsl` restructurer also synthesizes flow ids when emitting
the DSL.

How should these synthesized ids be generated? Options are: random/UUID, sequential
counter, or a deterministic function of the element's structural position in the
source.

## Decision Drivers

- Re-compiling the same source must produce the same BPMN XML — non-deterministic
  ids would make the output non-reproducible and break byte-comparison golden tests
- The round-trip normalizer (`tests/helpers/normalize-ir.ts`) must be able to
  recognize and re-key synthesized ids; this is only practical if the id scheme
  is stable and documented
- Sequential counters depend on traversal order, making ids sensitive to unrelated
  source changes
- Ids derived from structural position are self-documenting and survive refactoring
  of unrelated parts of the process

## Considered Options

- UUIDs (random, non-deterministic)
- Sequential counter (deterministic but traversal-order-sensitive)
- Structural coordinate: id derived from the enclosing element's position in the
  process body

## Decision Outcome

Chosen option: "Structural coordinate". Deriving each id from the element's
position in the source makes recompilation reproducible, keeps golden tests
stable, and lets a reader trace a synthesized id back to the statement that
produced it.

The frozen id templates (from `packages/transform/src/synthesize-ids.ts`):

| Template                   | Produced by          | Example                                               |
| -------------------------- | -------------------- | ----------------------------------------------------- |
| `Gateway_<X>_split`        | `makeGatewaySplitId` | `Gateway_invoice-approval_2_split`                    |
| `Gateway_<X>_join`         | `makeGatewayJoinId`  | `Gateway_invoice-approval_2_join`                     |
| `Gateway_<X>_fork`         | `makeGatewayForkId`  | `Gateway_invoice-approval_4_fork`                     |
| `Gateway_<X>_loop`         | `makeGatewayLoopId`  | `Gateway_invoice-approval_3_loop`                     |
| `Flow_<gatewayId>_default` | `makeDefaultFlowId`  | `Flow_Gateway_invoice-approval_2_split_default`       |
| `Flow_<src>_<tgt>`         | `makeSequenceFlowId` | `Flow_ReviewInvoice_Gateway_invoice-approval_2_split` |
| `StartEvent_<processId>`   | `makeStartEventId`   | `StartEvent_invoice-approval`                         |
| `EndEvent_<processId>`     | `makeEndEventId`     | `EndEvent_invoice-approval`                           |

The structural coordinate `<X>` for a compound statement at body index `i` inside
a process with id `P` is `P_i`. For nested compounds the parent coordinate is
prepended (`P_i_j`). Branch segments distinguish sibling blocks within a compound:
`_t` for the if-then block, `_e<i>` (0-based) for else-if branches, `_e` for the
else block, `_b<i>` for parallel branches. Loop bodies carry no segment (single block).

Collision resolution: if a base id is already in the taken set, append `_2`, `_3`, …
until a free slot is found.

**Validator-side reservation:** gateway ids skip the `taken`/`resolveCollision`
guard — the position-path scheme never generates the same id twice, so the only
possible collision is with an author-chosen statement name that matches a
synthesized-id pattern. The `checkReservedNames` validator in
`packages/language/src/bpmn-script-validator.ts` rejects such names at
validation time: `Gateway_*_(split|join|fork|loop)`, `StartEvent_*`,
`EndEvent_*`, and the two-segment `Flow_*_*` form (`/^Flow_.+_.+$/`).
Single-segment names like `Flow_Control` stay legal: synthesized flow ids
occupy only `SequenceFlow.id`, never node names, so they cannot collide.

### Consequences

- Good, because re-compiling the same source always produces the same BPMN ids
- Good, because golden files remain stable across unrelated source changes
- Good, because the id scheme is self-documenting — reading a gateway id reveals its
  position in the source
- Good, because `synthesize-ids.ts` is a pure, dependency-free module with its own
  test suite
- Neutral, because the structural coordinate is longer than a UUID, making gateway
  ids verbose in deep nesting (mitigated by the fact that deeply nested processes
  are rare in the current scope)
- Bad, because renaming a process id or reordering top-level statements changes all
  synthesized ids in that process, which breaks deployed BPMN definitions (a concern
  for production use; acceptable for a DSL-authoring workflow where recompile is
  expected to replace the definition)

### Confirmation

The `synthesize-ids.test.ts` suite verifies every template and collision-resolution
rule. The round-trip normalizer (`tests/helpers/normalize-ir.ts`) uses the id
patterns to re-key synthesized ids before comparing IR snapshots.

## More Information

The id templates are **frozen** — they are consumed by `astToIr`, `irToDsl`, and the
round-trip normalizer. Any change requires updating all three consumers and
regenerating the `invoice-approval-generated.bpmn` golden file. The frozen contract
is documented in the header of `packages/transform/src/synthesize-ids.ts`.
