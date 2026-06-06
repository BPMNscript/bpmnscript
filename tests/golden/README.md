# Golden BPMN fixtures

Golden fixtures are known-good files checked into the repo so a test can compare
its output against a fixed reference instead of recomputing the expected result
every run. The three files here all describe the same invoice-approval process —
start → review → gateway (amount > 1000?) → senior approval or auto-approve → end —
but they come from different sources and drive the tests in different directions.

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

The **output** of the IR → XML direction, frozen once and checked in. The
`irToXml` test (`packages/transform/test/ir-to-xml.test.ts`) feeds a fixed IR to
`irToXml` and compares the result against this file byte-for-byte, so any
accidental change to the serializer's output shows up as a failed diff.

If you change `irToXml` in a way that _should_ alter its output (new attribute,
different formatting, layout-library upgrade), regenerate this file:

1. The reference IR is the `canonicalIr` constant in
   `packages/transform/test/ir-to-xml.test.ts`.
2. Run `irToXml(canonicalIr)` and write the returned string to this file.
3. Inspect the diff to confirm every change is intended, then commit the new file
   alongside the code change.

## `bad-service-task-expression.bpmn`

A minimal one-process file whose single `<bpmn:serviceTask>` uses
`operaton:expression="${someExpr}"` instead of the supported `operaton:class`. It
is the negative-path fixture: `xmlToIr` must reject it with
`UnsupportedServiceTaskFormError`, and the `bpmns parse` CLI must exit non-zero.
Used purely as a "this must be rejected" input — the file itself is not meant to
be deployed.
