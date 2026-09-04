# Golden BPMN fixtures

Known-good files checked into the repo, so a test can compare its output against a fixed reference instead of recomputing the expected result every run.

Most fixtures here come in pairs: a `.bpmnscript` source and the `.bpmn` the full pipeline produces from it, frozen.
A few stand alone as inputs for one direction only.

| Fixture                                | Covers                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| `invoice-approval-handwritten.bpmn`    | Import of a realistic modeler file                            |
| `invoice-approval-generated.bpmn`      | The full compile pipeline, frozen                             |
| `bad-service-task-no-binding.bpmn`     | The import refusal path                                       |
| `structured-control-flow.bpmnscript`   | Round-trip idempotence for `if`, `while`, and `parallel`      |
| `nested-subprocess.{bpmnscript,bpmn}`  | Embedded sub-process round trip                               |
| `event-handlers.{bpmnscript,bpmn}`     | The error and escalation layer                                |
| `event-triggers.{bpmnscript,bpmn}`     | The message, signal, timer, and conditional triggers          |
| `compensation.{bpmnscript,bpmn}`       | The compensation (undo-block) layer                           |
| `boundary-events.{bpmnscript,bpmn}`    | Host-attached handlers, every boundary trigger but `cancel`   |
| `intermediate-catch.{bpmnscript,bpmn}` | `await` across all four catchable triggers                    |
| `engine-attributes.{bpmnscript,bpmn}`  | The flat engine settings, on events, activities, and handlers |
| `input-output.{bpmnscript,bpmn}`       | `operaton:inputOutput` in all four value forms                |
| `listeners.{bpmnscript,bpmn}`          | The execution-listener and task-listener surface              |
| `event-positions.{bpmnscript,bpmn}`    | A message start, `emit`/`throw message`, and a terminate end  |
| `task-kinds.{bpmnscript,bpmn}`         | The generic, send, receive, and decision task kinds           |
| `repetition.{bpmnscript,bpmn}`         | Every form of the repeat clause                               |
| `transactions.{bpmnscript,bpmn}`       | A block of work that can be given up, and the cancel pair     |
| `unstructured-goto.bpmn`               | The `goto` degradation path on import                         |

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

Each pair has a round-trip test at `tests/<name>.round-trip.test.ts`, and `tests/helpers/round-trip-fixture.ts` registers what they share: reproduce the pipeline and compare byte-for-byte against the frozen `.bpmn`, round-trip the source through XML and back asserting IR equivalence through `tests/helpers/normalize-ir.ts`, re-parse and re-validate the restructured DSL, and open the authored fixture validator-clean.
Every pair but `intermediate-catch` also asserts that the frozen `.bpmn` imports without a single warning and re-desugars back to the IR the fixture compiled to.
The DI assertion is each suite's own, since what the layout has to get right differs: nested shapes inside their parent's bounds wherever a fixture nests (the `isExpanded` hint from `irToXml`, without which a disconnected event sub-process leaks into the root plane), and a boundary shape centered on its host's lower edge in `boundary-events`.
Per-fixture extras, such as which root elements must be shared or how strictly the restructured DSL is validated, live in the test file.

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

## `structured-control-flow.bpmnscript`

A BPMNscript source, not BPMN XML, exercising every structured control-flow construct in one process.
It's the input for the construct round-trip idempotence check (BPMNscript to IR to XML to IR to DSL to IR), where each construct desugars to a clean, restructurable gateway shape and survives the full trip:

- `if (priority > 5) { ... } else { ... }` becomes an exclusive-gateway split and join pair (`Gateway_structured-control-flow_2_split` and `..._2_join`).
- `while (retries < 3) { ... }` becomes an exclusive loop gateway (`Gateway_structured-control-flow_3_loop`) with a conditioned back-edge, never `standardLoopCharacteristics`.
- `parallel { { ... } { ... } }` becomes a parallel-gateway fork and join pair (`Gateway_structured-control-flow_4_fork` and `..._4_join`).

Every flow node carries an explicit id so the round trip can assert authored ids survive, and synthesized ids follow the frozen scheme (`Gateway_<coord>_split|join|loop|fork`, `Flow_<gateway>_default`).

## `nested-subprocess.{bpmnscript,bpmn}`

An order-fulfillment process grouping its stages into `subprocess` blocks: one with an implicit start and end wrapping an `if`/`else`, a labeled one with an explicit start and end wrapping a `while`, and a two-level nested one.
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

A trip-booking saga exercising the whole undo surface in one program: two sub-processes each owning an `on compensation` undo block (the flight reverses in one step, the hotel through an `if` reading a declared form variable, so the undo logic is more than a single step); an `error ... message` declaration and a process-level `on error` handler whose body raises a named `emit compensation Undo` and then continues to notify the traveler; a matching `emit escalation Overspend` in the main flow and a process-level `on escalation` handler that gives up, recording the abandonment and ending its path with a named `throw compensation CancelAll`, for the cross-kind interplay; and a `var compensation: number` read in a service expression, pinning that the compensation word coexists with a same-named variable.
The `if` variables `seats` and `budget` are declared on the start form so they survive an import-and-back round trip, and every throw and emit is explicitly named so its printed id re-parses cleanly.

Contract: the absence of any compensation root, the bare compensate definitions, the `triggeredByEvent` undo blocks with interrupting starts, each undo-block shape inside its host's bounds, and every authored id.

## `boundary-events.{bpmnscript,bpmn}`

A parcel-dispatch narrative exercising the whole attached-handler surface in one program: six of the seven boundary triggers, all but `cancel`, which attaches to an `attempt` block alone and is frozen in the `transactions` pair; interrupting and non-interrupting attachment wherever Operaton permits both; five host kinds, a `user` task, a `class`-bound and a `topic`-bound `service` task, a `script` task, a `subprocess` whose escalation is raised by an `emit escalation` one container down, and a `call`; two hosts carrying two boundaries each, so the layout library has to distribute the attachers along the host's lower edge; an escape chain that rejoins the main flow through `goto`; an escape chain containing an `if`; and a host-less signal handler coexisting with all of them in the same container.
The `if` and condition variables are declared on the start form so they survive an import-and-back round trip, the escalation is emitted under an explicit id so its printed id re-parses cleanly, and every label differs from the name humanized from its id.

Contract: every `attachedToRef`, `cancelActivity="false"` on each `alongside` boundary, the shared `signalRef` and `escalationRef`, each boundary shape centered on its host's bottom edge, and every authored id.

## `intermediate-catch.{bpmnscript,bpmn}`

A single main flow awaiting all four catchable triggers back to back, between a review task and a dispatch task, so the golden covers every payload shape (a message name, a timer duration, a signal name, and a rendered boolean expression) in one artifact:

```bpmnscript
await message "PaymentConfirmed"
await timer after "PT1H"
await signal "StockReplenished"
await condition (amount > 100)
```

Contract: the four event definitions, their order, and the absence of any `name` attribute on a catch.

## `engine-attributes.{bpmnscript,bpmn}`

A motor-claim settlement narrative carrying the flat engine settings, the ones whose value is a single scalar.
`versionTag` sits on the process header, and `asyncBefore`, `asyncAfter`, `exclusive`, `jobPriority`, and `retryCycle` are spread across a start, an end, a user task, a service task, a script task, a subprocess, a call, an `await`, an `emit`, and both handler forms.
Five of the seven keys a user task owns (`assignee`, `formKey`, `candidateGroups`, `candidateUsers`, `priority`) sit together on one task, and `resultVariable` on both a service and a script task.

Both handler forms are here so the placement rule is pinned in the artifact rather than only in prose.
A hosted `on ApprovePayout: timer` writes its settings on the boundary event it lowers to, and a host-less `on escalation` writes them on the event sub-process rather than on the trigger start event nested inside it.
That start event's own block belongs to the `start` statement written inside the handler body, and a synthesized start prints no statement at all, so a setting stored there could have nowhere to go.
A `while`, an `if`, and a `parallel` put five synthesized gateways in the same artifact, none of which carries a setting: a gateway id is a structural coordinate with no name an author writes, so a setting found on a gateway during import stays a reported drop.
Every named node carries an explicit id, and the frozen artifact imports without a single warning, which is what makes that drop report meaningful.

Contract: the `(node id, attribute, value)` table in `tests/engine-attributes.round-trip.test.ts`, the `3.1.0` version tag on the process, and the absence of any engine setting on a gateway and on the event sub-process's trigger start event.

## `input-output.{bpmnscript,bpmn}`

A process exercising the `operaton:inputOutput` block in all four value forms, a scalar, an inline script, a list, and a map, on a user task, a service task, a script task, a subprocess, a call, and an `on message` handler.
The scalar and the inline script each appear in both directions; as a parameter's own value the list is only ever an input and the map only ever an output, and each of the two structured forms nests inside the other.
The call carries its own `in`/`out` variable mappings beside its parameters, so one artifact pins the two mechanisms as distinct: a variable mapping crosses the process boundary into the callee, a parameter binds a value into the activity's own execution scope.

Contract: the parameter names and their declaration order per direction, each value's form, the `scriptFormat` on each inline script, and the call's variable mappings serialized beside the `operaton:inputOutput` block rather than inside it.

## `listeners.{bpmnscript,bpmn}`

A process registering execution listeners on a service task, a subprocess, an end event, and an `on message` handler, and all six task-listener events, `create`, `assign`, `complete`, `update`, `delete`, and `timeout`, on one user task.
The service task carries both execution events, `start` and `end`; the other three carry one of the two each.
All four bindings appear, a Java class, a JUEL expression, a delegate expression, and an inline fenced script, and the `timeout` listener carries the timer clause a caught timer event spells the same way.

Contract: the `operaton:executionListener` and `operaton:taskListener` children in their authored order, the event word on each, the single binding each carries, the `scriptFormat` on the inline script, and the timer child under the `timeout` listener.

## `event-positions.{bpmnscript,bpmn}`

An order-dispatch narrative carrying a trigger in the three positions outside a handler in one program: a `start OrderReceived ... message "OrderReceived"`, so the process is entered by a correlated message rather than by a caller while its start form still renders; an `emit message NotifyWarehouse "WarehouseNotified"` and a terminal `throw message OrderAcknowledged "OrderAcknowledged"`, the continuing and the terminal form of one verb pair; and an `end OrderAbandoned "Abandon every path" terminate` in one branch of an `if`, beside the message end the other branch falls through to.
The three message names are all distinct, so this artifact pins one derived root per name, where `event-triggers` pins the opposite case of several references collapsing onto one root.
The condition variable is declared on the start form so it survives an import-and-back round trip, and every throw and emit is explicitly named so its printed id re-parses cleanly.
A terminate ends its branch, so the restructured DSL prints that branch as a `goto` onto the named service task instead of as an `if`/`else`; the IR is the same either way, which is what the idempotence block asserts.

Contract: one `bpmn:Message` root per distinct name in first-appearance order (`OrderReceived`, `WarehouseNotified`, `OrderAcknowledged`), the `messageRef` on the start event beside its `operaton:formData`, the `messageRef` on `NotifyWarehouse` and `OrderAcknowledged` with no implementation attribute so Operaton parses them as a none throw and a none end and sends nothing until a send surface exists, the bare `bpmn:terminateEventDefinition` on `OrderAbandoned` with its `name` attribute kept, an import of the frozen artifact that reports no warning at all and so none about that end event's label, and every authored id.

## `task-kinds.{bpmnscript,bpmn}`

An order-settlement narrative carrying the four activity statements the engine routes through a tag of their own.
A `step` the engine records and passes straight through, a `send` bound to a Java class, a `receive` naming the message it waits for beside a second naming none, and three `decide` steps covering both bindings a decision step takes.
`RateRisk` pins a decision table with `binding = latest` and maps its result into a `resultVariable`, `ChooseCarrier` falls through to a code binding, and `PriceShipping` pins `version = 3`, so the two version forms and the result mapping sit in one artifact.
An `emit message` carrying a class sits mid-flow, so a message throw the path continues past is frozen beside the one that ends the path.
The closing `throw message` carries a class, so the message end names the code that publishes it instead of parsing as a none end.
That message end and the receive task name the same message, which is what makes the derived root one shared root rather than one per kind; the emit names a second and derives a root of its own.

Contract: a `bpmn:task`, a `bpmn:sendTask`, two `bpmn:receiveTask`, three `bpmn:businessRuleTask`, and one `bpmn:intermediateThrowEvent` element; two `bpmn:Message` roots, `PaymentSettled` ahead of `PickingSlotReady`, the first referenced by both the receive task's `messageRef` and the message end's, with no `messageRef` at all on the receive task that names no message; the four DMN attributes `operaton:decisionRef`, `operaton:decisionRefBinding`, `operaton:decisionRefVersion`, and `operaton:mapDecisionResult`; the `operaton:class` on the intermediate throw's and on the message end's `bpmn:messageEventDefinition`; and every authored id.

## `repetition.{bpmnscript,bpmn}`

An order-fulfilment narrative whose stages each run once per item they are handed, so one artifact carries every form of the repeat clause on seven of the ten activity tags that take one.
A user task repeats over a bound collection; a service task over a collection expression, sequentially, stopped early by an `until` condition; a second service task over a bare count; a step over a count and a collection together; a receive over a collection it binds no element of; a call over a bound collection; a script task whose clause is written ahead of both its settings block and its fenced body; and a sub-process that repeats sequentially, sets `asyncBefore`, and wraps one ordinary service task.
`asyncBefore` on a repeated statement makes one job for the repetition as a whole rather than one per run of it, which is the only async a clause can express.
Every collection variable is declared in the process header, and the decompiler writes a declaration back for each collection a clause names bare, since a bare `operaton:collection` is the name of a process variable the engine requires to exist.

Contract: one `bpmn:multiInstanceLoopCharacteristics` under each of `bpmn:userTask`, both `bpmn:serviceTask`, `bpmn:task`, `bpmn:receiveTask`, `bpmn:callActivity`, `bpmn:scriptTask`, and `bpmn:subProcess`, written ahead of the script body and of a sub-process's own children; `isSequential="true"` on the two statements that wrote `sequentially` and the attribute absent everywhere else, because the engine runs the instances at once unless told otherwise; one `bpmn:loopCardinality` carrying a count alone and one carrying a count beside a collection, which the engine accepts together; one `bpmn:completionCondition`; `operaton:elementVariable` absent on the one collection that binds no element; and `operaton:collection="${order.lines}"` keeping its `${}` where the author wrote an expression while `operaton:collection="approvers"` stays bare where the author named a variable, since Operaton reads a bare value as a variable name and only a `${...}` body as an expression.

## `transactions.{bpmnscript,bpmn}`

A seat-booking narrative whose holding and paying are one block of work that can be given up as a unit.
`attempt BookAndPay` holds the seats through an ordinary `subprocess` owning an `on compensation` undo block, charges the card, and issues the tickets; a guard on the declined charge ends that path with `end BookingAbandoned "Give up the booking" cancel`, and `on BookAndPay: cancel` catches it.
An `on BookAndPay: error` handler sits on the same block, so the artifact pins that a block taking a cancel handler still takes the handlers it always took.
A second `attempt` block repeats over the seat rows, sets `asyncBefore`, and mentions cancel nowhere, so a block nothing gives up is frozen beside the one that is; it sits inside an ordinary `subprocess`, which nests the two heads inside one another both ways round.
The guard variable is declared on the start form and the collection the repeat clause names bare is declared in the header, so both survive an import-and-back round trip.

The `attempt` head serializes to `bpmn:transaction` and `subprocess` to `bpmn:subProcess`.
Operaton runs a `bpmn:transaction` through the same behavior class it gives an ordinary embedded sub-process, so nothing about the block is atomic and nothing rolls back on its own; what the second tag buys is that the engine then accepts a cancel end directly inside the block and a cancel boundary on it, and refuses to deploy either anywhere else.
A cancel end runs the undo blocks of the finished steps of its own block first, in reverse order of completion, and only when that is done does the run appear at the block's cancel handler.

Contract: the `attempt` blocks on `bpmn:transaction` and the ordinary ones on `bpmn:subProcess`; the `bpmn:cancelEventDefinition` on an end event inside the transaction and on a boundary event whose `attachedToRef` names that transaction, both of them bare; the error boundary on the same host; the `triggeredByEvent` undo block nested inside the block a cancel end gives up; `bpmn:multiInstanceLoopCharacteristics` and `operaton:asyncBefore` written on the second transaction tag; every nested shape inside its parent's bounds with both boundary shapes centered on the host's lower edge; and every authored id.

## `unstructured-goto.bpmn`

A deliberately unstructured BPMN file.
Two exclusive gateways, `RouteA` and `RouteB`, cross-branch so that neither post-dominates the other and there is no single join where all branches reconverge: `RouteB` jumps into `Beta`, which is also a direct branch target of `RouteA`, so `Beta` has two predecessors from different gateway regions.
That's the classic irreducible shape no structured `if` or `while` can express, and it ends in two distinct end events, `Done` and `DoneBeta`.

This is the input for the goto-degradation import path.
`xmlToIr` must read it without throwing, since every element kind is supported and every sequence flow resolves, and the restructuring `irToDsl` must fall back to `goto` for the edges it cannot fold into a structured block.
The file is a realistic modeler artifact, with MIWG `<bpmn:incoming>` and `<bpmn:outgoing>` children, `operaton:` extensions, and a `<bpmndi:BPMNDiagram>` block with hand-picked coordinates; `xmlToIr` discards all DI data, so only the semantic graph reaches the IR.
