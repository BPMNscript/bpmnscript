# Golden BPMN fixtures

Known-good files checked into the repo, so a test can compare its output against a fixed reference instead of recomputing the expected result every run.

Most fixtures here come in pairs: a `.bpmnscript` source and the `.bpmn` the full pipeline produces from it, frozen.
A few stand alone as inputs for one direction only.

| Fixture                                | Covers                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| `invoice-approval-handwritten.bpmn`    | Import of a realistic modeler file                                |
| `invoice-approval-generated.bpmn`      | The full compile pipeline, frozen                                 |
| `bad-service-task-no-binding.bpmn`     | The import refusal path                                           |
| `structured-control-flow.bpmnscript`   | Round-trip idempotence for `if`, `while`, and `parallel`          |
| `nested-subprocess.{bpmnscript,bpmn}`  | Embedded sub-process round trip                                   |
| `event-handlers.{bpmnscript,bpmn}`     | The error and escalation layer                                    |
| `event-triggers.{bpmnscript,bpmn}`     | The message, signal, timer, and conditional triggers              |
| `compensation.{bpmnscript,bpmn}`       | The compensation (undo-block) layer                               |
| `boundary-events.{bpmnscript,bpmn}`    | Handlers attached to a host activity, every trigger and host kind |
| `intermediate-catch.{bpmnscript,bpmn}` | `await` across all four catchable triggers                        |
| `unstructured-goto.bpmn`               | The `goto` degradation path on import                             |

The three invoice-approval files all describe the same process (review, then a gateway on `amount > 1000`, then senior approval or auto-approve) but come from different sources and pull the tests in different directions.

## Regenerating a frozen output

Change the parser, the desugarer, or `irToXml` in a way that should alter the output (a new attribute, different formatting, a layout-library upgrade, an id-scheme change) and the frozen `.bpmn` has to be regenerated:

1. Run the full pipeline on the source: `irToXml(astToIr(parse(source)))`, wiring the Langium services exactly as `tests/round-trip.test.ts` does, with `createBpmnScriptServices(EmptyFileSystem)` and `parseHelper`.
2. Write the returned string over the frozen `.bpmn`.
3. Read the diff and confirm every change is intended.

Step 3 is the one that matters.
Synthesized gateway, flow, handler, boundary, and catch ids may move, and so may layout coordinates.
Everything each section below calls a contract must stay exactly as it is.

## What the pair tests do

Each pair has a round-trip test at `tests/<name>.round-trip.test.ts`, and they all do the same four things: reproduce the pipeline and compare byte-for-byte against the frozen `.bpmn`, round-trip the source through XML and back asserting IR equivalence through `tests/helpers/normalize-ir.ts`, import the frozen `.bpmn` warning-free, and assert nested shapes' DI bounds fall inside their parent's (the `isExpanded` hint from `irToXml`, without which a disconnected event sub-process leaks into the root plane).
Per-fixture extras, such as which root elements must be shared or whether the restructured DSL is asserted validator-clean, live in the test file.

The sections below describe what each source exercises and what must not move when the frozen output is regenerated.

## `invoice-approval-handwritten.bpmn`

A BPMN file written by hand to look like real Operaton Modeler output.
It uses the `operaton:` namespace (`http://operaton.org/schema/1.0/bpmn`) for extension attributes, carries `<bpmn:incoming>` and `<bpmn:outgoing>` children on every flow node in the MIWG style Operaton expects, sets `operaton:historyTimeToLive="P30D"` on the process, and includes a `<bpmndi:BPMNDiagram>` block with hand-picked coordinates.

This is the input for the XML to IR direction.
`packages/transform/test/xml-to-ir.test.ts` parses it and asserts the resulting IR matches the expected invoice-approval IR, covering both the import of a realistic file and the discarding of its diagram data.

## `invoice-approval-generated.bpmn`

The frozen output of the full pipeline, checked in: `irToXml(astToIr(parse(examples/spring-boot/processes/invoice-approval.bpmnscript)))`.
The `irToXml` test (`packages/transform/test/ir-to-xml.test.ts`, describe block "irToXml, full-pipeline golden diff") reproduces that pipeline and compares byte-for-byte, so any accidental change to the parser, the desugarer, or the serializer shows up as a failed diff.
This is the same XML the spring-boot engine E2E deploys.

Contract: the process id `invoice-approval`, the userTask ids `ReviewInvoice` and `SeniorApproval`, `operaton:class="com.example.invoice.AutoApproveDelegate"`, the `demo` and `manager` assignees, and the condition `${amount > 1000}`.

## `bad-service-task-no-binding.bpmn`

A minimal one-process file whose single `<bpmn:serviceTask>` carries no execution binding: no `operaton:class`, `operaton:expression`, `operaton:delegateExpression`, and no external `operaton:type` and `operaton:topic` pair.
A service task with no execution form cannot be represented, so this is the negative-path fixture: `xmlToIr` must reject it with `UnsupportedServiceTaskFormError`, and `bpmns parse` must exit non-zero.
It's an input to be rejected, not a file meant to be deployed.

## `structured-control-flow.bpmnscript`

A BPMNscript source, not BPMN XML, exercising every structured control-flow construct in one process.
It's the input for the construct round-trip idempotence check (BPMNscript to IR to XML to IR to DSL to IR), where each construct desugars to a clean, restructurable gateway shape and survives the full trip:

- `if (priority > 5) { ... } else { ... }` becomes an exclusive-gateway split and join pair (`Gateway_structured-control-flow_2_split` and `..._2_join`).
- `while (retries < 3) { ... }` becomes an exclusive loop gateway (`Gateway_structured-control-flow_3_loop`) with a conditioned back-edge, never `standardLoopCharacteristics`.
- `parallel { { ... } { ... } }` becomes a parallel-gateway fork and join pair (`Gateway_structured-control-flow_4_fork` and `..._4_join`).

Every flow node carries an explicit id so the round trip can assert authored ids survive, and synthesized ids follow the frozen scheme (`Gateway_<coord>_split|join|loop|fork`, `Flow_<gateway>_default`).

## `nested-subprocess.{bpmnscript,bpmn}`

An order-fulfillment process grouping its stages into `subprocess` blocks: one with an implicit start and end wrapping an `if`/`else`, a labelled one with an explicit start and end wrapping a `while`, and a two-level nested one.
Every named node carries an explicit id so the round trip can assert authored ids survive at their correct container depth.

Contract: `isExpanded="true"` on each sub-process, nested children inside their parent's bounds, and the authored ids.

## `event-handlers.{bpmnscript,bpmn}`

An order-processing narrative exercising the whole try/catch surface in one program: an `error ... message` declaration; a payment `subprocess` that throws inside an `if`, escalates mid-chain with `emit escalation`, and owns an interrupting `on error` handler with both catch bindings; a process-level non-interrupting `on escalation ... alongside` handler; a catch-all `on error` handler; a terminal `throw escalation`; explicit ids on a throw and an emit with a `goto` targeting the named emit; and a process variable called `message` used in a condition, so the contextual event words coexist with same-named variables.
The condition variables are declared on the start form so they survive an import-and-back round trip, and each handler opens with an explicit trigger `start` and closes with an explicit `end`.

Contract: the deduped roots (one per code, the error root carrying its message), the shared `errorRef` and `escalationRef`, `isInterrupting="false"` on the `alongside` handler, each handler shape inside its parent's bounds, and every authored id.

## `event-triggers.{bpmnscript,bpmn}`

An order-fulfilment narrative exercising the remaining trigger set in one program: a process-level `on message "OrderCancelled"` handler; a `subprocess` owning a non-interrupting `on timer after "PT2H" alongside` reminder and a non-interrupting `on condition (stockLevel < 5) alongside` watchdog reading a declared form variable; an `on signal "OrderFulfilled" alongside` handler together with a continuing `emit signal Notify "OrderFulfilled"` and a terminal `throw signal Announce "OrderFulfilled"` of the same name; an `at` timer on the same sub-process, so one container carries three handlers; and a `var timer: string` read in a service expression, pinning that the timer particle words coexist with same-named variables.
The condition variable is declared on the start form so it survives an import-and-back round trip, and every throw and emit is explicitly named so its printed id re-parses cleanly.

Contract: the deduped name-keyed roots and their order, the shared `signalRef`, `isInterrupting="false"` on the `alongside` handlers, the single time-child per timer, each handler shape inside its parent's bounds, and every authored id.

## `compensation.{bpmnscript,bpmn}`

A trip-booking saga exercising the whole undo surface in one program: two sub-processes each owning an `on compensation` undo block (the flight reverses in one step, the hotel through an `if` reading a declared form variable, so the undo logic is more than a single step); an `error ... message` declaration and a process-level `on error` handler whose body raises a named `emit compensation Undo` and then continues to notify the traveller; a matching `emit escalation Overspend` in the main flow and a process-level `on escalation` handler that gives up, recording the abandonment and ending its path with a named `throw compensation CancelAll`, for the cross-kind interplay; and a `var compensation: number` read in a service expression, pinning that the compensation word coexists with a same-named variable.
The `if` variables `seats` and `budget` are declared on the start form so they survive an import-and-back round trip, and every throw and emit is explicitly named so its printed id re-parses cleanly.

Contract: the absence of any compensation root, the bare compensate definitions, the `triggeredByEvent` undo blocks with interrupting starts, each undo-block shape inside its host's bounds, and every authored id.

## `boundary-events.{bpmnscript,bpmn}`

A parcel-dispatch narrative exercising the whole attached-handler surface in one program: all six boundary-capable triggers; interrupting and non-interrupting attachment wherever Operaton permits both; every host kind a token can sit at, a `user` task, a `class`-bound and a `topic`-bound `service` task, a `script` task, a `subprocess` whose escalation is raised by an `emit escalation` one container down, and a `call`; two hosts carrying two boundaries each, so the layout library has to distribute the attachers along the host's lower edge; an escape chain that rejoins the main flow through `goto`; an escape chain containing an `if`; and a host-less signal handler coexisting with all of them in the same container.
The `if` and condition variables are declared on the start form so they survive an import-and-back round trip, the escalation is emitted under an explicit id so its printed id re-parses cleanly, and every label differs from the name humanised from its id.

Contract: every `attachedToRef`, `cancelActivity="false"` on each `alongside` boundary, the shared `signalRef` and `escalationRef`, each boundary shape centred on its host's bottom edge, and every authored id.

## `intermediate-catch.{bpmnscript,bpmn}`

A single main flow awaiting all four catchable triggers back to back, between a review task and a dispatch task, so the golden covers every payload shape (a message name, a timer duration, a signal name, and a rendered boolean expression) in one artifact:

```bpmnscript
await message "PaymentConfirmed"
await timer after "PT1H"
await signal "StockReplenished"
await condition (amount > 100)
```

Contract: the four event definitions, their order, and the absence of any `name` attribute on a catch.

## `unstructured-goto.bpmn`

A deliberately unstructured BPMN file.
Two exclusive gateways, `RouteA` and `RouteB`, cross-branch so that neither post-dominates the other and there is no single join where all branches reconverge: `RouteB` jumps into `Beta`, which is also a direct branch target of `RouteA`, so `Beta` has two predecessors from different gateway regions.
That's the classic irreducible shape no structured `if` or `while` can express, and it ends in two distinct end events, `Done` and `DoneBeta`.

This is the input for the goto-degradation import path.
`xmlToIr` must read it without throwing, since every element kind is supported and every sequence flow resolves, and the restructuring `irToDsl` must fall back to `goto` for the edges it cannot fold into a structured block.
The file is a realistic modeler artefact, with MIWG `<bpmn:incoming>` and `<bpmn:outgoing>` children, `operaton:` extensions, and a `<bpmndi:BPMNDiagram>` block with hand-picked coordinates; `xmlToIr` discards all DI data, so only the semantic graph reaches the IR.
