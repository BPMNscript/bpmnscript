# Golden BPMN fixtures

Golden fixtures are known-good files checked into the repo so a test can compare
its output against a fixed reference instead of recomputing the expected result
every run. The three invoice-approval files here all describe the same process —
start → review → gateway (amount > 1000?) → senior approval or auto-approve → end —
but they come from different sources and drive the tests in different directions.
Two additional construct fixtures (`structured-control-flow.bpmnscript` and
`unstructured-goto.bpmn`) exercise the round-trip and goto-degradation paths, the
`nested-subprocess.{bpmnscript,bpmn}` pair exercises the embedded sub-process
round-trip, the `event-handlers.{bpmnscript,bpmn}` pair exercises the error and
escalation event layer, the `event-triggers.{bpmnscript,bpmn}` pair exercises
the message, signal, timer, and conditional triggers, and
`bad-service-task-no-binding.bpmn` is the negative-path fixture for the import
refusal path.

## `invoice-approval-handwritten.bpmn`

A BPMN file written by hand to look like real Operaton Modeler output. It uses the
`operaton:` namespace (`http://operaton.org/schema/1.0/bpmn`) for extension
attributes, carries `<bpmn:incoming>` and `<bpmn:outgoing>` children on every flow
node (the MIWG style Operaton expects), sets `operaton:historyTimeToLive="P30D"` on
the process, and includes a `<bpmndi:BPMNDiagram>` block with hand-picked
coordinates.

This is the **input** for the XML → IR direction. The `xmlToIr` test
(`packages/transform/test/xml-to-ir.test.ts`) parses it and asserts the resulting
IR matches the expected invoice-approval IR — covering the import of a
realistic file and the dropping of the diagram data.

## `invoice-approval-generated.bpmn`

The **frozen output of the full pipeline**, checked in. It is
`irToXml(astToIr(parse(examples/spring-boot/processes/invoice-approval.bpmnscript)))`
— the example parsed, desugared, and serialized end-to-end. The
`irToXml` test (`packages/transform/test/ir-to-xml.test.ts`, describe block
"irToXml — full-pipeline golden diff") reproduces that pipeline and compares the
result against this file byte-for-byte, so any accidental change to the parser,
the desugarer, or the serializer shows up as a failed diff. This is the same XML
the spring-boot engine E2E deploys.

Because it is the desugared output, the `if`/`else` in the example becomes a
**paired exclusive split + join** with synthesized ids from the deterministic
id scheme: the gateways are `Gateway_invoice-approval_2_split` and
`Gateway_invoice-approval_2_join`, and the `else` branch is the gateway's
default flow `Flow_Gateway_invoice-approval_2_split_default`. (This is a
different topology and id scheme from `invoice-approval-handwritten.bpmn`, which
has a single hand-named gateway `AmountCheck` and lets both branches converge
directly on the end event — see the `irToXml`-isolation fixture `importShapedIr`
in the same test file, which mirrors the handwritten import and keeps those ids.)

If you change the parser, the desugarer, or `irToXml` in a way that _should_
alter the output (new attribute, different formatting, layout-library upgrade,
id-scheme change), regenerate this file:

1. Parse the example and run the full pipeline:
   `irToXml(astToIr(parse(examples/spring-boot/processes/invoice-approval.bpmnscript)))`,
   wiring the Langium services exactly as `tests/round-trip.test.ts` does
   (`createBpmnScriptServices(EmptyFileSystem)` + `parseHelper`).
2. Write the returned string to this file.
3. Inspect the diff to confirm every change is intended — the engine contract
   (process id `invoice-approval`, userTask ids `ReviewInvoice`/`SeniorApproval`,
   `operaton:class="com.example.invoice.AutoApproveDelegate"`,
   `operaton:assignee` demo/manager, condition `${amount > 1000}`) must stay
   unchanged; only gateway/default/synthesized-flow ids may move.

## `bad-service-task-no-binding.bpmn`

A minimal one-process file whose single `<bpmn:serviceTask>` carries no execution
binding at all — no `operaton:class`, `operaton:expression`,
`operaton:delegateExpression`, nor an external `operaton:type`/`operaton:topic`
pair. A service task with no execution form cannot be represented, so it is the
negative-path fixture: `xmlToIr` must reject it with
`UnsupportedServiceTaskFormError`, and the `bpmns parse` CLI must exit non-zero.
Used purely as a "this must be rejected" input — the file itself is not meant to
be deployed.

## `structured-control-flow.bpmnscript`

A BPMNscript **source** (not BPMN XML) that exercises every structured
control-flow construct in one process: `if`/`else`, `while`, and `parallel`.
It is the **input** for the construct round-trip idempotence check
(BPMNscript → IR → XML → IR → DSL → IR); each construct desugars to a clean,
restructurable gateway shape and survives a full round-trip:

- `if (priority > 5) { … } else { … }` → an exclusive-gateway split/join pair
  (`Gateway_structured-control-flow_2_split` / `…_2_join`).
- `while (retries < 3) { … }` → an exclusive loop gateway
  (`Gateway_structured-control-flow_3_loop`) with a conditioned back-edge,
  never `standardLoopCharacteristics`.
- `parallel { { … } { … } }` → a parallel-gateway fork/join pair
  (`Gateway_structured-control-flow_4_fork` / `…_4_join`).

Every flow node carries an explicit id so the round-trip can assert authored ids
survive; synthesized gateway/flow ids follow the frozen deterministic scheme
(`Gateway_<coord>_split|join|loop|fork`, `Flow_<gateway>_default`).

## `nested-subprocess.bpmnscript` and `nested-subprocess.bpmn`

A golden **pair** for the embedded sub-process feature: a BPMNscript source and
the frozen BPMN XML the full pipeline produces from it. The source is an
order-fulfillment process that groups its stages into `subprocess` blocks —
one sub-process with an implicit start/end wrapping an `if`/`else`, a labelled
sub-process with an explicit start/end wrapping a `while`, and a two-level
nested sub-process — with an explicit id on every named node so the round-trip
can assert authored ids survive at their correct container depth.

`nested-subprocess.bpmnscript` is the **input**, and `nested-subprocess.bpmn` is
the **frozen output of the full pipeline** (`irToXml(astToIr(parse(source)))`,
services wired exactly as `tests/round-trip.test.ts` does). The round-trip test
`tests/nested-subprocess.round-trip.test.ts` drives the pair both directions:
it reproduces the pipeline and compares byte-for-byte against the frozen `.bpmn`,
round-trips the source through XML and back asserting IR equivalence (through the
recursive `normalizeIr`), imports the frozen `.bpmn` warning-free, and asserts
every nested child shape's DI bounds fall strictly inside its parent
sub-process's bounds (the `isExpanded` layout hint from `irToXml`).

Because it is the desugared output, each sub-process carries synthesized
positional gateway ids (`Gateway_order-fulfillment_2_0_split`/`…_join`,
`Gateway_order-fulfillment_3_1_loop`) and name-seeded implicit events
(`StartEvent_Payment`, `EndEvent_Payment`, …), while every authored id
(`Payment`, `Fulfillment`, `Shipping`, the tasks, the explicit events) survives
verbatim.

If you change the parser, the desugarer, or `irToXml` in a way that _should_
alter the output (new attribute, different formatting, layout-library upgrade,
id-scheme change), regenerate this file:

1. Run the full pipeline on the source:
   `irToXml(astToIr(parse(nested-subprocess.bpmnscript)))`, wiring the Langium
   services exactly as `tests/round-trip.test.ts` does
   (`createBpmnScriptServices(EmptyFileSystem)` + `parseHelper`).
2. Write the returned string to `nested-subprocess.bpmn`.
3. Inspect the diff to confirm every change is intended — the containment
   contract (each sub-process `isExpanded="true"`; nested children inside their
   parent's bounds; authored ids unchanged) must stay intact; only synthesized
   gateway/flow ids and layout coordinates may move.

## `event-handlers.bpmnscript` and `event-handlers.bpmn`

A golden **pair** for the error and escalation event layer: a BPMNscript source
and the frozen BPMN XML the full pipeline produces from it. The source is an
order-processing narrative that exercises the whole try/catch surface in one
program — an `error … message` declaration, a payment `subprocess` that throws
(`throw error` inside an `if`) and escalates mid-chain (`emit escalation`) and
owns an interrupting `on error` handler with both catch bindings, a process-level
non-interrupting `on escalation … alongside` handler, a catch-all `on error`
handler, a terminal `throw escalation`, explicit ids on a throw and an emit with a
`goto` targeting the named emit, and a process variable named `message` used in a
condition (so the contextual event words `error`/`escalation`/`code`/`message`
coexist with same-named variables). The condition variables are declared on the
start form so they survive an import-and-back round-trip, and each handler opens
with an explicit trigger `start` and closes with an explicit `end`.

`event-handlers.bpmnscript` is the **input**, and `event-handlers.bpmn` is the
**frozen output of the full pipeline** (`irToXml(astToIr(parse(source)))`,
services wired exactly as `tests/round-trip.test.ts` does). The round-trip test
`tests/event-handlers.round-trip.test.ts` drives the pair both directions: it
reproduces the pipeline and compares byte-for-byte against the frozen `.bpmn`,
round-trips the source through XML and back asserting IR equivalence (through the
recursive `normalizeIr`, which re-keys each event-handler sub-process id to a
structural trigger signature), imports the frozen `.bpmn` warning-free, checks
that the `throw error` end event and the `on error` handler share one
`bpmn:Error` carrying the declared `operaton:errorMessage`, and asserts every
handler shape's DI bounds fall strictly inside its parent container's bounds (the
`isExpanded` expansion hint from `irToXml`, without which a disconnected event
sub-process and its children leak into the root plane).

Because it is the desugared output, the three root elements are synthesised from
usage and deduped by code (`Error_PAYMENT_DECLINED` carrying the declared message,
`Escalation_MANUAL_REVIEW` shared by both escalation sites, and
`Escalation_ORDER_ABANDONED`), each handler is a `triggeredByEvent` sub-process,
and the non-interrupting handler carries `isInterrupting="false"`, while every
authored id (the tasks, the explicit events, the named `throw`/`emit`) survives
verbatim.

If you change the parser, the desugarer, or `irToXml` in a way that _should_
alter the output (new attribute, different formatting, layout-library upgrade,
id-scheme change), regenerate this file:

1. Run the full pipeline on the source:
   `irToXml(astToIr(parse(event-handlers.bpmnscript)))`, wiring the Langium
   services exactly as `tests/round-trip.test.ts` does
   (`createBpmnScriptServices(EmptyFileSystem)` + `parseHelper`).
2. Write the returned string to `event-handlers.bpmn`.
3. Inspect the diff to confirm every change is intended — the deduped root
   elements (one per code, the error root carrying its message), the shared
   `errorRef`/`escalationRef`, `isInterrupting="false"` on the `alongside`
   handler, each handler shape inside its parent's bounds, and every authored id
   must stay intact; only synthesised gateway/flow/handler ids and layout
   coordinates may move.

## `event-triggers.bpmnscript` and `event-triggers.bpmn`

A golden **pair** for the message, signal, timer, and conditional event triggers:
a BPMNscript source and the frozen BPMN XML the full pipeline produces from it.
The source is an order-fulfilment narrative that exercises the remaining trigger
set in one program — a process-level `on message "OrderCancelled"` handler; a
`subprocess` owning a non-interrupting reminder `on timer after "PT2H" alongside`
handler and a non-interrupting `on condition (stockLevel < 5) alongside` watchdog
whose condition reads a declared form variable; an `on signal "OrderFulfilled"
alongside` handler together with an `emit signal Notify "OrderFulfilled"`
(continuing broadcast) and a terminal `throw signal Announce "OrderFulfilled"`
of the same signal name; an `at` timer on a second sub-process; an
`on error "STOCK_UNAVAILABLE" (code c, message m)` handler with both catch
bindings (cross-kind interplay); and a `var timer: string` read in a service
expression, pinning that the timer particle words coexist with same-named
variables. The condition variable is declared on the start form so it survives
an import-and-back round-trip, and every throw/emit is explicitly named so its
printed id re-parses cleanly.

`event-triggers.bpmnscript` is the **input**, and `event-triggers.bpmn` is the
**frozen output of the full pipeline** (`irToXml(astToIr(parse(source)))`,
services wired exactly as `tests/round-trip.test.ts` does). The round-trip test
`tests/event-triggers.round-trip.test.ts` drives the pair both directions: it
reproduces the pipeline and compares byte-for-byte against the frozen `.bpmn`,
round-trips the source through XML and back asserting IR equivalence (through the
recursive `normalizeIr`, whose handler re-keying now folds the trigger definition
payload — message/signal name, timer kind + expression, condition text — into the
structural signature so two same-kind handlers of the new kinds stay distinct),
imports the frozen `.bpmn` warning-free, checks that the `on signal` handler, the
`emit signal`, and the `throw signal` share one `bpmn:Signal`, and asserts every
handler shape's DI bounds fall strictly inside its parent container's bounds.
Unlike the error/escalation pair, the restructured DSL′ here is asserted
validator-clean: the fixture avoids the early-exit-inside-`if` shape that degrades
a jump onto an unnamed synthesised join, and its named throws/emits print their
authored ids.

Because it is the desugared output, the three root elements are synthesised from
usage and deduped by name (`Error_STOCK_UNAVAILABLE` carrying the declared
message, `Message_OrderCancelled`, and `Signal_OrderFulfilled` shared by the
handler, the emit, and the throw), in the `rootElements` order
`[process, …errors, …escalations, …messages, …signals]`; each timer carries a
single `bpmn:timeDuration`/`bpmn:timeDate` child, the conditional a `bpmn:condition`
child; each handler is a `triggeredByEvent` sub-process, and the non-interrupting
handlers carry `isInterrupting="false"`, while every authored id (the tasks, the
explicit events, the named `throw`/`emit`) survives verbatim.

If you change the parser, the desugarer, or `irToXml` in a way that _should_
alter the output (new attribute, different formatting, layout-library upgrade,
id-scheme change), regenerate this file:

1. Run the full pipeline on the source:
   `irToXml(astToIr(parse(event-triggers.bpmnscript)))`, wiring the Langium
   services exactly as `tests/round-trip.test.ts` does
   (`createBpmnScriptServices(EmptyFileSystem)` + `parseHelper`).
2. Write the returned string to `event-triggers.bpmn`.
3. Inspect the diff to confirm every change is intended — the deduped
   name-keyed roots and their order, the shared `signalRef`,
   `isInterrupting="false"` on the `alongside` handlers, the single time-child
   per timer, each handler shape inside its parent's bounds, and every authored
   id must stay intact; only synthesised gateway/flow/handler ids and layout
   coordinates may move.

## `unstructured-goto.bpmn`

A deliberately **unstructured** BPMN file: two exclusive gateways (`RouteA`,
`RouteB`) cross-branch so that neither post-dominates the other and there is no
single join where all branches reconverge — `RouteB` jumps into `Beta`, which is
also a direct branch target of `RouteA`, so `Beta` has two predecessors from
different gateway regions (the classic irreducible shape no structured `if`/`while`
can express; it ends in two distinct end events `Done`/`DoneBeta`).

This is the **input** for the goto-degradation import path. `xmlToIr` must read it
**without throwing** (every element kind is supported and every sequence flow
resolves), and the restructuring `irToDsl` must fall back to `goto` for the edges
it cannot fold into a structured block. The file is a realistic modeler artefact
(MIWG `<bpmn:incoming>`/`<bpmn:outgoing>` children, `operaton:` extensions, a
`<bpmndi:BPMNDiagram>` block with hand-picked coordinates); `xmlToIr` discards all
DI data, so only the semantic graph reaches the IR.
