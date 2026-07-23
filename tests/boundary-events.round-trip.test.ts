/**
 * Whole-feature end-to-end: the attached (boundary) handler round-trip.
 *
 * This is the dedicated end-to-end proof that an `on <Host>: <trigger>` handler
 * survives the full pipeline as a *user* experiences it, over real
 * infrastructure — real Langium parse and validation, real `bpmn-moddle` (via
 * `irToXml`/`xmlToIr`), and real `bpmn-auto-layout` (invoked inside `irToXml`).
 * There is NO Docker and NO engine here; the "real infrastructure" is the
 * unmocked transform chain and the on-disk golden pair.
 *
 * It complements the host-less event-handler suites by driving one
 * parcel-dispatch narrative that exercises, in a single program: all six
 * boundary-capable triggers (`error`, `escalation`, `message`, `signal`,
 * `timer`, `condition`); interrupting and non-interrupting (`alongside`)
 * attachment wherever Operaton permits both; a boundary on a `subprocess` host
 * and one on a `call` host; two boundaries sharing one host (so the layout
 * library has to distribute the attachers along its lower edge); an escape
 * chain that rejoins the main flow through `goto`; an escape chain containing
 * an `if`/`else` (structured restructuring inside a handler body); and two
 * host-less handlers coexisting with all of them in the same container.
 *
 * The fixture is `golden/boundary-events.bpmnscript`; the frozen pipeline
 * output is `golden/boundary-events.bpmn`. Normalization comes from the shared
 * `helpers/normalize-ir.ts`, which re-keys each boundary event's host-derived
 * id to a structural signature drawn from its host, trigger, payload, and
 * interrupting flag.
 *
 * Six cases:
 *
 *   1. Golden generation — the pipeline output equals the frozen `.bpmn`
 *      byte-for-byte (the frozen artifact is the diff tripwire; any drift is a
 *      real defect, not a regeneration trigger).
 *   2. Idempotence — `normalizeIr(IR₁)` equals `normalizeIr(IR₃)`; DSL′
 *      re-parses with zero parser errors and places every handler block where
 *      the surface rule demands; the authored ids survive at their correct
 *      container depth; each boundary's `attachedToRef` and `cancelActivity`
 *      survive at every hop; the `goto` rejoin stays a real edge and the
 *      `if`/`else` inside an escape chain comes back structured.
 *   3. Import path — `xmlToIr(frozen)` warns nothing, and the imported IR
 *      restructured back to DSL and re-desugared is normalized-equal to IR₁.
 *   4. DI tripwire — every boundary shape sits centred on its host's bottom
 *      edge, half-overlapping it; a host carrying two boundaries has them
 *      distributed along that edge; the boundary on the sub-process host is
 *      placed against the expanded sub-process shape rather than a task-sized
 *      box; and there is exactly one `bpmndi:BPMNDiagram`.
 *   5. Root sharing — the signal caught by a boundary event and the signal
 *      caught by a host-less handler reference the SAME `bpmn:Signal`, and the
 *      escalation thrown inside the sub-process and the one caught on its
 *      boundary reference the same `bpmn:Escalation`.
 *   6. Import-first direction — an inline handwritten `.bpmn` with canonical
 *      namespaces and **hand-named** boundary ids (none of which match the
 *      host-derived id template) imports warning-free, prints, and re-desugars
 *      to an IR normalized-equal to the first import. Two of its boundaries
 *      share a host and a trigger kind and differ only in the caught code, so
 *      the re-synthesised ids collide and one of them takes the positional
 *      `_2` suffix — which the structural re-key has to see through.
 *
 * One health assertion covers the requirement that the fixture opens
 * validator-clean in the IDE (no diagnostics at all).
 *
 * A note on DSL′ and validation (case 2). DSL′ re-parses cleanly, but it is not
 * asserted to be validator-clean, and cannot be: an escape chain's implicit end
 * event is named after the boundary event that starts the chain
 * (`EndEvent_<boundaryId>`), the printer always prints a terminal end event
 * under its id, and `EndEvent_` is a reserved synthesised-id prefix, so DSL′
 * carries one reserved-name diagnostic per terminating escape chain. That is a
 * property of printing a generated id back out, not a round-trip defect — the
 * ids are regenerated identically by `astToIr`, so IR₃ is topologically
 * correct. What DSL′ *is* asserted to be free of is a handler-placement
 * diagnostic: a handler block printed anywhere but at the end of its body
 * produces source the validator rejects, which would make the decompiler's
 * output un-reopenable. The meaningful validation guarantee — the authored
 * program is clean — is the fixture check below.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors event-handlers.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The attached-handler DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/boundary-events.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/boundary-events.bpmn');

/**
 * The diagnostic the validator raises when a handler block is not the last
 * thing in its body. The decompiler prints every handler in a trailing group,
 * so its output must never produce this message — source that does is source
 * the author cannot re-open.
 */
const HANDLER_PLACEMENT_DIAGNOSTIC =
  'Event handlers read like catch blocks: move it after the last step of this body.';

// ---------------------------------------------------------------------------
// Langium services — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the source
 * has any parser error — a round-tripped source that does not re-parse is itself
 * a round-trip failure, so it must abort the test, never be swallowed.
 */
async function parseToAst(source: string) {
  const document = await parse(source);
  const errors = document.parseResult.parserErrors;
  if (errors.length > 0) {
    throw new Error(
      'Parser errors in round-tripped DSL:\n' +
        errors.map((e) => e.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

// ---------------------------------------------------------------------------
// Container helpers.
// ---------------------------------------------------------------------------

/** The `kind` of the flow element with the given id in a container, or `undefined`. */
function kindOf(container: FlowContainer, id: string): string | undefined {
  return container.flowElements.find((fe) => fe.id === id)?.kind;
}

/** Find the sub-process element with the given id in a container's own array. */
function subProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(
      `expected a sub-process '${id}' in container '${container.id}'`,
    );
  }
  return el;
}

type BoundaryEvent = Extract<FlowElement, { kind: 'boundaryEvent' }>;

/** Every boundary event directly inside a container, in document order. */
function boundaryEvents(container: FlowContainer): BoundaryEvent[] {
  return container.flowElements.filter(
    (fe): fe is BoundaryEvent => fe.kind === 'boundaryEvent',
  );
}

/**
 * A boundary event rendered as everything about it that is NOT its id: the
 * host it attaches to, the trigger kind, the caught payload, and whether it
 * cancels its host. Comparing these across hops asserts the load-bearing
 * attachment data survives the round-trip while deliberately staying blind to
 * the id, whose positional suffix is not a structural fact.
 */
function attachmentSignature(boundary: BoundaryEvent): string {
  const def = boundary.eventDefinition;
  const payload =
    def.kind === 'error'
      ? (def.errorCode ?? '<catch-all>')
      : def.kind === 'escalation'
        ? (def.escalationCode ?? '<catch-all>')
        : def.kind === 'message'
          ? def.messageName
          : def.kind === 'signal'
            ? def.signalName
            : def.kind === 'timer'
              ? `${def.timerKind} ${def.expression}`
              : def.kind === 'conditional'
                ? def.condition
                : '<none>';
  const cancels =
    boundary.cancelActivity === false ? 'alongside' : 'interrupting';
  return `${boundary.attachedToRef} ${def.kind} ${payload} ${cancels}`;
}

/** Every boundary event's attachment signature in a container, sorted. */
function attachmentSignatures(container: FlowContainer): string[] {
  return boundaryEvents(container).map(attachmentSignature).sort();
}

/**
 * The six boundary events the fixture authors, as attachment signatures. Frozen
 * here so a hop that silently drops a host, flips `cancelActivity`, or loses a
 * trigger payload fails with a readable diff rather than a deep-equality dump.
 */
const EXPECTED_ATTACHMENTS = [
  'BookCarrier signal CarrierStrike interrupting',
  'CheckAddress message AddressVerified interrupting',
  'CheckAddress timer duration PT4H alongside',
  'HandOverParcel conditional ${weight > 30} alongside',
  'PackGoods error ADDRESS_REJECTED interrupting',
  'PackGoods escalation OVERSIZED_PARCEL alongside',
].sort();

// ---------------------------------------------------------------------------
// DI bounds parsing (case 4). The frozen `.bpmn` is a fixed artifact, so its
// `bpmndi:BPMNShape`/`dc:Bounds` pairs are extracted with a scoped regex rather
// than pulling in a moddle dependency the tests workspace does not declare.
// (Mirrors event-handlers.round-trip.test.ts.)
// ---------------------------------------------------------------------------

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Map every `bpmnElement` id to the bounds of its `bpmndi:BPMNShape`. */
function parseShapeBounds(xml: string): Map<string, Bounds> {
  const shape =
    /<bpmndi:BPMNShape\b[^>]*\bbpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  const bounds = new Map<string, Bounds>();
  for (let m = shape.exec(xml); m !== null; m = shape.exec(xml)) {
    bounds.set(m[1]!, {
      x: Number(m[2]),
      y: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
    });
  }
  return bounds;
}

/** The bounds of a shape that must exist, or a failing lookup. */
function boundsOf(bounds: Map<string, Bounds>, id: string): Bounds {
  const found = bounds.get(id);
  expect(found, `missing BPMNShape for ${id}`).toBeDefined();
  return found!;
}

/**
 * Assert every attacher of one host sits on that host's bottom edge, centred
 * vertically on it (so the shape half-overlaps the host) and distributed evenly
 * along it: `n` attachers land at `x + width · i/(n+1)` for `i` in `1…n`, which
 * for a single attacher is the host's horizontal centre. This is the placement
 * `bpmn-auto-layout` computes for `attachedToRef` children, and it is asserted
 * against the host's own bounds so the case cannot pass by merely finding a
 * shape somewhere on the canvas.
 */
function assertAttachedToHost(
  bounds: Map<string, Bounds>,
  hostId: string,
  boundaryIds: readonly string[],
): void {
  const host = boundsOf(bounds, hostId);
  const attachers = boundaryIds
    .map((id) => ({ id, box: boundsOf(bounds, id) }))
    .sort((a, b) => a.box.x - b.box.x);

  attachers.forEach(({ id, box }, index) => {
    expect(
      box.y + box.height / 2,
      `${id} is not centred on the bottom edge of ${hostId}`,
    ).toBeCloseTo(host.y + host.height, 3);
    expect(
      box.x + box.width / 2,
      `${id} is not distributed along the bottom edge of ${hostId}`,
    ).toBeCloseTo(
      host.x + (host.width * (index + 1)) / (attachers.length + 1),
      3,
    );
  });
}

/**
 * The `<kind>Ref` attribute on the single event definition inside the named
 * boundary/start event of the frozen XML. Scopes to the element block so two
 * catch sites are read independently.
 */
function definitionRefOf(
  xml: string,
  element: 'boundaryEvent' | 'startEvent' | 'intermediateThrowEvent',
  elementId: string,
  definition: 'signal' | 'escalation',
): string | undefined {
  const block = new RegExp(
    `<bpmn:${element} id="${elementId}"[^>]*>([\\s\\S]*?)</bpmn:${element}>`,
  ).exec(xml);
  if (block === null) return undefined;
  return new RegExp(
    `<bpmn:${definition}EventDefinition\\b[^>]*\\b${definition}Ref="([^"]+)"`,
  ).exec(block[1]!)?.[1];
}

// ---------------------------------------------------------------------------
// The import-first handwritten fixture (case 6). Canonical namespaces,
// `Flow_`-prefixed flow ids, MIWG `<bpmn:incoming>`/`<bpmn:outgoing>` children,
// and three **hand-named** boundary events (`BoxTorn`, `ItemMissing`,
// `CrateOverdue`) whose ids match nothing the host-derived id template would
// produce. Two of them share the host `InspectCrate` and the trigger kind
// `error` and differ only in the code they catch, so re-synthesising their ids
// necessarily collides and hands one of them the positional `_2` suffix; each
// escape chain terminates in its own end event rather than rejoining, so every
// chain also re-synthesises a terminal. It imports warning-free and, printed
// and re-desugared, is normalized-equal to the first import.
// ---------------------------------------------------------------------------

const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_crate_handover" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:error id="Error_Torn" name="TORN_BOX" errorCode="TORN_BOX" />
  <bpmn:error id="Error_Missing" name="MISSING_ITEM" errorCode="MISSING_ITEM" />
  <bpmn:process id="crate-handover" name="Crate Handover" isExecutable="true">
    <bpmn:startEvent id="CrateArrived">
      <bpmn:outgoing>Flow_CrateArrived_InspectCrate</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="InspectCrate" name="Inspect the crate" operaton:assignee="demo">
      <bpmn:incoming>Flow_CrateArrived_InspectCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_InspectCrate_StoreCrate</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:serviceTask id="StoreCrate" name="Store the crate" operaton:class="com.example.dispatch.StoreDelegate">
      <bpmn:incoming>Flow_InspectCrate_StoreCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_StoreCrate_CrateAccepted</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="CrateAccepted">
      <bpmn:incoming>Flow_StoreCrate_CrateAccepted</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="BoxTorn" attachedToRef="InspectCrate">
      <bpmn:outgoing>Flow_BoxTorn_RepackCrate</bpmn:outgoing>
      <bpmn:errorEventDefinition id="ErrDef_Torn" errorRef="Error_Torn" />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="RepackCrate" name="Repack the crate" operaton:class="com.example.dispatch.RepackDelegate">
      <bpmn:incoming>Flow_BoxTorn_RepackCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_RepackCrate_CrateRepacked</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="CrateRepacked">
      <bpmn:incoming>Flow_RepackCrate_CrateRepacked</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="ItemMissing" attachedToRef="InspectCrate">
      <bpmn:outgoing>Flow_ItemMissing_ReorderItem</bpmn:outgoing>
      <bpmn:errorEventDefinition id="ErrDef_Missing" errorRef="Error_Missing" />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="ReorderItem" name="Reorder the missing item" operaton:class="com.example.dispatch.ReorderDelegate">
      <bpmn:incoming>Flow_ItemMissing_ReorderItem</bpmn:incoming>
      <bpmn:outgoing>Flow_ReorderItem_ItemReordered</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="ItemReordered">
      <bpmn:incoming>Flow_ReorderItem_ItemReordered</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="CrateOverdue" cancelActivity="false" attachedToRef="StoreCrate">
      <bpmn:outgoing>Flow_CrateOverdue_ChaseStorage</bpmn:outgoing>
      <bpmn:timerEventDefinition id="TimerDef_1">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="ChaseStorage" name="Chase the storage team" operaton:class="com.example.dispatch.ChaseDelegate">
      <bpmn:incoming>Flow_CrateOverdue_ChaseStorage</bpmn:incoming>
      <bpmn:outgoing>Flow_ChaseStorage_StorageChased</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="StorageChased">
      <bpmn:incoming>Flow_ChaseStorage_StorageChased</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_CrateArrived_InspectCrate" sourceRef="CrateArrived" targetRef="InspectCrate" />
    <bpmn:sequenceFlow id="Flow_InspectCrate_StoreCrate" sourceRef="InspectCrate" targetRef="StoreCrate" />
    <bpmn:sequenceFlow id="Flow_StoreCrate_CrateAccepted" sourceRef="StoreCrate" targetRef="CrateAccepted" />
    <bpmn:sequenceFlow id="Flow_BoxTorn_RepackCrate" sourceRef="BoxTorn" targetRef="RepackCrate" />
    <bpmn:sequenceFlow id="Flow_RepackCrate_CrateRepacked" sourceRef="RepackCrate" targetRef="CrateRepacked" />
    <bpmn:sequenceFlow id="Flow_ItemMissing_ReorderItem" sourceRef="ItemMissing" targetRef="ReorderItem" />
    <bpmn:sequenceFlow id="Flow_ReorderItem_ItemReordered" sourceRef="ReorderItem" targetRef="ItemReordered" />
    <bpmn:sequenceFlow id="Flow_CrateOverdue_ChaseStorage" sourceRef="CrateOverdue" targetRef="ChaseStorage" />
    <bpmn:sequenceFlow id="Flow_ChaseStorage_StorageChased" sourceRef="ChaseStorage" targetRef="StorageChased" />
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// Pipeline — run once in beforeAll; each test makes focused assertions.
// ---------------------------------------------------------------------------

let fixtureSrc: string;
let frozenXml: string;
let generatedXml: string; // irToXml(astToIr(parse(fixture)))
let ir1: BpmnProcess; // astToIr(parse(fixture))
let ir2: BpmnProcess; // xmlToIr(generatedXml) — the imported IR
let ir3: BpmnProcess; // re-desugared after DSL → XML → DSL′
let dslPrime: string; // restructured DSL after one XML round-trip
let importWarnings: string[];
let irFromImport: BpmnProcess; // xmlToIr(frozen).ir → re-desugared

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);

  fixtureSrc = readFileSync(FIXTURE_PATH, 'utf-8');
  frozenXml = readFileSync(FROZEN_BPMN_PATH, 'utf-8');

  ir1 = astToIr(await parseToAst(fixtureSrc));

  generatedXml = await irToXml(ir1);

  ({ ir: ir2 } = await xmlToIr(generatedXml));
  dslPrime = irToDsl(ir2);
  ir3 = astToIr(await parseToAst(dslPrime));

  const imported = await xmlToIr(frozenXml);
  importWarnings = imported.warnings;
  irFromImport = astToIr(await parseToAst(irToDsl(imported.ir)));
});

// ===========================================================================
// 1. Golden generation.
// ===========================================================================

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('irToXml(astToIr(parse(fixture))) equals the frozen artifact byte-for-byte', () => {
    expect(generatedXml).toBe(frozenXml);
  });
});

// ===========================================================================
// 2. Idempotence.
// ===========================================================================

describe('idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃', () => {
  it('normalizeIr(IR₁) equals normalizeIr(IR₃)', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('the restructured DSL′ re-parses with zero parser errors', async () => {
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('every handler block in DSL′ trails the body it guards', async () => {
    // A boundary handler is walked early (its escape chain has to be claimed
    // before the orphan sweep can mistake it for a detached fragment) but must
    // be *printed* in the trailing handler group. Printing it in place emits
    // source the validator rejects, so the decompiler's own output would no
    // longer re-open — this assertion is what catches that.
    const { diagnostics } = await validate(dslPrime);
    expect(
      diagnostics.filter((d) => d.message === HANDLER_PLACEMENT_DIAGNOSTIC),
    ).toEqual([]);
  });

  it('the authored ids survive verbatim at their correct container depth', () => {
    expect(kindOf(ir3, 'CheckAddress')).toBe('userTask');
    expect(kindOf(ir3, 'PackGoods')).toBe('subProcess');
    expect(kindOf(ir3, 'BookCarrier')).toBe('callActivity');
    expect(kindOf(ir3, 'HandOverParcel')).toBe('userTask');
    // The escalation is emitted one container down, inside the sub-process the
    // escalation boundary is attached to.
    expect(kindOf(subProcess(ir3, 'PackGoods'), 'Oversized')).toBe(
      'intermediateThrowEvent',
    );
  });

  it("each boundary's host, trigger, payload, and cancelActivity survive at every hop", () => {
    for (const [label, ir] of [
      ['IR₁', ir1],
      ['IR₂', ir2],
      ['IR₃', ir3],
    ] as const) {
      expect(
        attachmentSignatures(ir),
        `attachments differ in ${label}`,
      ).toEqual(EXPECTED_ATTACHMENTS);
    }
  });

  it('the escape chain that rejoins the main flow keeps a real edge into its target', () => {
    // `goto PackGoods` inside the message handler's body is a sequence flow
    // from the escape chain's last step into the sub-process, not a decorative
    // statement — the handler body and the main flow share one container, which
    // is the whole reason the jump is expressible.
    const rejoin = ir3.sequenceFlows.find(
      (sf) => sf.sourceRef === 'MarkAddressVerified',
    );
    expect(rejoin?.targetRef).toBe('PackGoods');
  });

  it('the if/else inside an escape chain comes back as an if/else, not as gotos', () => {
    // The boundary event is wired to the CFG's virtual entry, so its escape
    // chain is reachable and the split inside it has an immediate dominator;
    // without that the restructurer could only degrade the branch into jumps.
    expect(dslPrime).toContain('if (parcelValue > 500) {');
    expect(dslPrime).toContain('} else {');
  });
});

// ===========================================================================
// 3. Import path.
// ===========================================================================

describe('import path: the frozen artifact imports cleanly and round-trips', () => {
  it('xmlToIr(frozen) produces no warnings', () => {
    expect(importWarnings).toEqual([]);
  });

  it('imported → DSL → re-desugared IR is normalized-equal to IR₁', () => {
    expect(normalizeIr(irFromImport)).toEqual(normalizeIr(ir1));
  });
});

// ===========================================================================
// 4. DI tripwire on the generated .bpmn.
// ===========================================================================

describe('DI attachment on the generated .bpmn', () => {
  it('exactly one bpmndi:BPMNDiagram is emitted', () => {
    expect(generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  });

  it('every boundary shape sits centred and half-overlapping on its host edge', () => {
    // Checked against the freshly generated XML (case 1 pins it to the frozen
    // artifact byte-for-byte). Each assertion is made against the host's own
    // bounds, so a boundary shape that exists but drifts off its host fails.
    const bounds = parseShapeBounds(generatedXml);

    assertAttachedToHost(bounds, 'CheckAddress', [
      'Boundary_CheckAddress_message',
      'Boundary_CheckAddress_timer',
    ]);
    assertAttachedToHost(bounds, 'PackGoods', [
      'Boundary_PackGoods_error',
      'Boundary_PackGoods_escalation',
    ]);
    assertAttachedToHost(bounds, 'BookCarrier', [
      'Boundary_BookCarrier_signal',
    ]);
    assertAttachedToHost(bounds, 'HandOverParcel', [
      'Boundary_HandOverParcel_condition',
    ]);
  });

  it('the sub-process host carries its boundaries on the expanded box, not a task-sized one', () => {
    // The riskiest layout case: the host is an expanded container whose bounds
    // are computed from its children, so its lower edge only exists once the
    // sub-process body has been laid out. Its attachers must land on THAT edge.
    const bounds = parseShapeBounds(generatedXml);
    const host = boundsOf(bounds, 'PackGoods');
    const child = boundsOf(bounds, 'PickItems');

    expect(host.width).toBeGreaterThan(child.width);
    expect(host.height).toBeGreaterThan(child.height);
    expect(generatedXml).toContain('bpmnElement="PackGoods" isExpanded="true"');
    for (const id of [
      'Boundary_PackGoods_error',
      'Boundary_PackGoods_escalation',
    ]) {
      expect(boundsOf(bounds, id).y + 18).toBeCloseTo(host.y + host.height, 3);
    }
  });
});

// ===========================================================================
// 5. Root sharing.
// ===========================================================================

describe('root sharing on the frozen .bpmn', () => {
  it('the boundary signal and the host-less handler signal share one bpmn:Signal', () => {
    const roots = [...frozenXml.matchAll(/<bpmn:signal id="([^"]+)"/g)];
    expect(roots).toHaveLength(1);
    const rootId = roots[0]![1];

    // The boundary attached to the call activity and the trigger start of the
    // process-level handler catch the same broadcast, so both must point at the
    // one root the serializer synthesised from that name.
    expect(
      definitionRefOf(
        frozenXml,
        'boundaryEvent',
        'Boundary_BookCarrier_signal',
        'signal',
      ),
    ).toBe(rootId);
    expect(
      definitionRefOf(frozenXml, 'startEvent', 'StrikeNoted', 'signal'),
    ).toBe(rootId);
  });

  it('the escalation thrown inside the sub-process and the one caught on its boundary share one bpmn:Escalation', () => {
    const roots = [...frozenXml.matchAll(/<bpmn:escalation id="([^"]+)"/g)];
    expect(roots).toHaveLength(1);
    const rootId = roots[0]![1];

    expect(
      definitionRefOf(
        frozenXml,
        'intermediateThrowEvent',
        'Oversized',
        'escalation',
      ),
    ).toBe(rootId);
    expect(
      definitionRefOf(
        frozenXml,
        'boundaryEvent',
        'Boundary_PackGoods_escalation',
        'escalation',
      ),
    ).toBe(rootId);
  });
});

// ===========================================================================
// 6. Import-first direction (hand-named boundary ids).
// ===========================================================================

describe('import-first: a handwritten .bpmn with hand-named boundary ids round-trips', () => {
  let firstImport: BpmnProcess;
  let firstWarnings: string[];
  let reDesugared: BpmnProcess;
  let importDsl: string;

  beforeAll(async () => {
    const imported = await xmlToIr(IMPORT_FIRST_BPMN);
    firstImport = imported.ir;
    firstWarnings = imported.warnings;
    importDsl = irToDsl(firstImport);
    reDesugared = astToIr(await parseToAst(importDsl));
  });

  it('imports warning-free', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('prints each boundary as an attached handler naming its host', () => {
    expect(importDsl).toContain('on InspectCrate: error "TORN_BOX" {');
    expect(importDsl).toContain('on InspectCrate: error "MISSING_ITEM" {');
    expect(importDsl).toContain(
      'on StoreCrate: timer after "PT1H" alongside {',
    );
  });

  it('re-synthesises the host-derived ids, suffixing the second of the colliding pair', () => {
    // The imported ids are hand-named and carry no host in them at all; the
    // re-desugared ids are derived from the host and the trigger word, so the
    // two error boundaries on `InspectCrate` collide and the second one printed
    // takes the positional `_2`. Which of the two owns that suffix is a
    // consequence of print order, not of anything either boundary carries —
    // which is exactly why the comparison below cannot key on the id.
    expect(boundaryEvents(firstImport).map((b) => b.id)).toEqual([
      'BoxTorn',
      'ItemMissing',
      'CrateOverdue',
    ]);
    expect(boundaryEvents(reDesugared).map((b) => b.id)).toEqual([
      'Boundary_InspectCrate_error',
      'Boundary_InspectCrate_error_2',
      'Boundary_StoreCrate_timer',
    ]);
  });

  it('keeps every host, trigger payload, and cancelActivity paired correctly', () => {
    const expected = [
      'InspectCrate error MISSING_ITEM interrupting',
      'InspectCrate error TORN_BOX interrupting',
      'StoreCrate timer duration PT1H alongside',
    ];
    expect(attachmentSignatures(firstImport)).toEqual(expected);
    expect(attachmentSignatures(reDesugared)).toEqual(expected);
  });

  it('the hand-named boundaries are re-keyed so the re-desugared IR matches the import', () => {
    // The structural re-key in normalizeIr collapses the hand-named ids and the
    // re-synthesised host-derived ones onto one signature per boundary, so the
    // two halves compare equal despite sharing no boundary id at all.
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(firstImport));
  });
});

// ===========================================================================
// Authored-program health: the fixture opens validator-clean.
// ===========================================================================

describe('the authored program opens validator-clean', () => {
  it('the fixture produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(fixtureSrc);
    expect(diagnostics).toEqual([]);
  });
});
