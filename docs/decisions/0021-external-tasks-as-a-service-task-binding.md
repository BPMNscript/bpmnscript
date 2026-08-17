---
status: accepted
date: 2026-08-16
decision-makers: Marlon Kranz
---

# External Tasks as a Service Task Binding, Not a Separate Keyword

## Context and Problem Statement

The grammar has two statement keywords that both compile to a `bpmn:serviceTask`: `service`, carrying a `class`, `expression`, or `delegate` binding, and `external`, carrying a `topic`.
Both keywords take the same attribute-block shape and produce the identical BPMN element; only the DSL surface distinguishes them.
The intermediate representation already models this as one type.
`ServiceTaskBinding` in `packages/transform/src/ir/types.ts` is a tagged union of `class` | `expression` | `delegateExpression` | `external`, and ADR-0006 already describes a service task as bound to "a Java class, a JUEL expression, a delegate expression, or an external topic" in one sentence, not as two separate constructs.

Does the DSL surface need its own keyword for a binding the IR, the validator's discriminator check, and the emitted XML already treat as one of four variants on the same element, or can `external` fold into `service` as that fourth binding?

## Decision Drivers

- ADR-0006 committed the IR to modeling every service-task execution form, including the external-worker form, as one tagged union rather than as separate node kinds.
  A grammar carrying a second keyword for a case the IR already unifies is an asymmetry with no consumer that benefits from it.
- ADR-0013 commits the language to minimizing required syntax and to naming constructs by what the user means rather than by BPMN vocabulary.
  Two keywords for the same element ask an author to remember an extra word for a distinction the runtime output does not make.
- A reserved keyword is a name an author can never choose for a variable or a step, so every keyword this language adds is a name it permanently takes away from process authors.
  `external` is an ordinary English word a real process is fairly likely to want for a variable or a step name.

## Considered Options

- Keep `external` as its own statement keyword
- Fold `external` into `service` as a fourth binding attribute

## Decision Outcome

Chosen option: "Fold `external` into `service` as a fourth binding attribute", because all four service-task execution forms already produce exactly one BPMN element, the IR already unifies them under `ServiceTaskBinding`, and ADR-0013 already commits this language to the smaller keyword surface.

The service task's attribute block gains `topic` as a fourth legal key alongside `class`, `expression`, and `delegate`.
The validator's exactly-one-binding check now requires exactly one of the four, naming all four in its error message, and the printer emits `service X { topic = "..." }` for the binding the same way it already emits `service X { delegate = "..." }` for a delegate expression.
The emitted BPMN XML is unchanged: `operaton:type="external"` alongside `operaton:topic` is exactly what the `external` keyword produced before, since the IR and the XML generator never referenced the DSL keyword in the first place.
`external` stops being reserved and parses as an ordinary identifier, freeing it for a variable or step name the way any other non-keyword does.

### Consequences

- Good, because there is one keyword surface to teach: an author reads "a service task can call a class, an expression, a delegate expression, or an external worker" as four attributes of the same statement, instead of two statements that happen to compile to the same element.
- Good, because boundary-event host enumerations, the reserved-step-name check, and every other place the grammar or validator listed the two task kinds side by side collapse to naming `service` once, removing a class of enumeration that had to be kept in sync across the grammar, the validator, and the docs.
- Good, because `external` is no longer reserved, so a process that wants a variable or step literally named `external` can have one.
- Bad, because a diagram viewer or a reader skimming XML sees `operaton:type="external"` as a distinguishing marker that the DSL source no longer surfaces as a distinguishing keyword; the binding is still visible, just as an attribute value inside a `service` block rather than as the statement's own word.

## Pros and Cons of the Options

### Keep `external` as its own statement keyword

An external task is, operationally, a different kind of thing from the other three bindings.
Deploying it means running a separate worker process that polls the engine for work on a topic, rather than shipping code the engine invokes directly inside its own JVM.
A dedicated keyword would flag that operational fork at the point an author writes the step, the same way the language already uses a dedicated keyword to distinguish a `user` task's human actor from a `service` task's automated one.

- Good, because the keyword itself documents an operational difference, a separately deployed worker, that an attribute value inside a shared block does not surface as prominently.
- Neutral, because Operaton itself does not model `external` as a distinct element either; the engine's own `bpmn:serviceTask` with `operaton:type="external"` is exactly the asymmetry this option would preserve on the DSL surface only.
- Bad, because it reserves a second keyword, and therefore a second English word an author can never use as an identifier, for a distinction that produces no distinct BPMN element and that the IR, the validator, and the printer already collapse into one type.

### Fold `external` into `service` as a fourth binding attribute

`topic` becomes a fourth legal key in the `service` attribute block, validated by the same exactly-one-of-four check the other three bindings already share.

- Good, because it matches the IR ADR-0006 already committed to: one `ServiceTaskBinding` union, one emitted element, one DSL statement.
- Good, because it follows ADR-0013's rule directly: the grammar drops a keyword instead of keeping one that carries no information the runtime output does not already carry elsewhere.
- Good, because `external` is freed as an ordinary identifier.
- Bad, because the operational-fork argument above is real: nothing in the `service Ship { topic = "..." }` surface tells a reader, without already knowing what `topic` means, that this step runs in a separately deployed process instead of inside the engine.

## More Information

The validator's zero-binding and more-than-one-binding messages name all four keys (`class`, `expression`, `delegate`, `topic`), so the fourth binding is discoverable from the error text alone.
Related decisions: ADR-0006 (engine-agnostic intermediate representation) already modeled `external` as a `ServiceTaskBinding` variant rather than its own IR node; this decision brings the DSL surface in line with that model.
ADR-0013 (target users without BPMN knowledge and minimize boilerplate) is the standing rule this decision applies.
