# Golden BPMN fixtures

Golden fixtures are known-good files checked into the repo so a test can compare
its output against a fixed reference instead of recomputing the expected result
every run. The three invoice-approval files here all describe the same process —
start → review → gateway (amount > 1000?) → senior approval or auto-approve → end —
but they come from different sources and drive the tests in different directions.
Two additional construct fixtures (`structured-control-flow.bpmnscript` and
`unstructured-goto.bpmn`) exercise the round-trip and goto-degradation paths.

## `invoice-approval-handwritten.bpmn`

A BPMN file written by hand to look like real Operaton Modeler output. It uses the
`operaton:` namespace (`http://operaton.org/schema/1.0/bpmn`) for extension
attributes, carries `<bpmn:incoming>` and `<bpmn:outgoing>` children on every flow
node (the MIWG style Operaton expects), sets `operaton:historyTimeToLive="P30D"` on
the process, and includes a `<bpmndi:BPMNDiagram>` block with hand-picked
coordinates.

This is the **input** for the XML → IR direction. The `xmlToIr` test
(`packages/transform/test/xml-to-ir.test.ts`) parses it and asserts the resulting
IR matches the expected invoice-approval IR — proving the importer reads a
realistic file correctly and drops the diagram data.

## `invoice-approval-generated.bpmn`

The **frozen output of the full pipeline**, checked in. It is
`irToXml(astToIr(parse(examples/spring-boot/processes/invoice-approval.bpmnscript)))`
— the example parsed, desugared, and serialised end-to-end. The
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

## `bad-service-task-expression.bpmn`

A minimal one-process file whose single `<bpmn:serviceTask>` uses
`operaton:expression="${someExpr}"` instead of the supported `operaton:class`. It
is the negative-path fixture: `xmlToIr` must reject it with
`UnsupportedServiceTaskFormError`, and the `bpmns parse` CLI must exit non-zero.
Used purely as a "this must be rejected" input — the file itself is not meant to
be deployed.

## `structured-control-flow.bpmnscript`

A BPMNscript **source** (not BPMN XML) that exercises every structured
control-flow construct in one process: `if`/`else`, `while`, and `parallel`.
It is the **input** for the construct round-trip idempotence check
(BPMNscript → IR → XML → IR → DSL → IR), proving each construct desugars to a
clean, restructurable gateway shape and survives a full round-trip:

- `if (priority > 5) { … } else { … }` → an exclusive-gateway split/join pair
  (`Gateway_structured-control-flow_2_split` / `…_2_join`).
- `while (retries < 3) { … }` → an exclusive loop gateway
  (`Gateway_structured-control-flow_3_loop`) with a conditioned back-edge,
  never `standardLoopCharacteristics`.
- `parallel { … } and { … }` → a parallel-gateway fork/join pair
  (`Gateway_structured-control-flow_4_fork` / `…_4_join`).

Every flow node carries an explicit id so the round-trip can assert authored ids
survive; synthesized gateway/flow ids follow the frozen deterministic scheme
(`Gateway_<coord>_split|join|loop|fork`, `Flow_<gateway>_default`).

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
