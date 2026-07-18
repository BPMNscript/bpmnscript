# @bpmn-script/transform

IR type definitions and the four bidirectional transforms that form the core of the BPMNscript pipeline.

## In plain terms

This is the conversion layer — the part that actually moves a process between formats. It's the bulk of the project's original code (the `language` package is mostly generated; this package is hand-written).

Everything pivots on the **IR** (intermediate representation): a small set of plain TypeScript objects, defined in `src/ir/types.ts`, that describe a process without committing to any one file format. Four transforms each convert between the IR and one neighbouring format:

```mermaid
flowchart LR
    DSL[".bpmnscript text"]
    AST["AST"]
    IR{{"IR"}}
    XML["BPMN 2.0 XML"]

    DSL -. "Langium parse" .-> AST
    AST -- astToIr --> IR
    IR -- irToDsl --> DSL
    IR -- irToXml --> XML
    XML -- xmlToIr --> IR
```

The four solid arrows are this package's transforms; the dotted one (text → AST) is the parser from `@bpmn-script/language`. Routing everything through the IR means each transform only has to understand one conversion, not every pairing. `astToIr` turns the parsed DSL (from the `language` package) into IR; `irToXml` writes deployable BPMN XML and runs auto-layout to add the diagram coordinates; `xmlToIr` reads an existing BPMN file back into IR; `irToDsl` prints IR as `.bpmnscript` text. Compiling is `astToIr` then `irToXml`; decompiling is `xmlToIr` then `irToDsl`.

The IR itself carries no Operaton-specific fields. Engine quirks (the `operaton:` attributes, the 30-day history setting) are attached only inside `irToXml`, so the data model in the middle stays clean.

## Purpose

This package is the transformation layer of BPMNscript. It defines the shared Intermediate Representation (IR) that all transforms use, and implements the four functions that convert between IR, BPMN 2.0 XML, and DSL text (see [ADR-0006](../../docs/decisions/0006-engine-agnostic-intermediate-representation.md)).

## IR shape

The IR represents a single executable BPMN process. All types are in `src/ir/types.ts` and re-exported from the package root.

```ts
interface BpmnProcess {
  id: string;
  name?: string;
  isExecutable: true; // always true (executable process)
  flowElements: FlowElement[];
  sequenceFlows: SequenceFlow[];
  errorMessages?: { code: string; message: string }[]; // declared thrown-error message texts, keyed by code
}

type FlowElement =
  | StartEvent // kind: 'startEvent'  (+eventDefinition? on an event-handler start)
  | EndEvent // kind: 'endEvent'  (+eventDefinition? for a typed throw end)
  | UserTask // kind: 'userTask'  (+assignee?, +formKey?)
  | ServiceTask // kind: 'serviceTask' (+binding: class | expression | delegateExpression | external)
  | ScriptTask // kind: 'scriptTask' (+format, +code)
  | ExclusiveGateway // kind: 'exclusiveGateway' (+defaultFlowId?)
  | ParallelGateway // kind: 'parallelGateway'
  | SubProcess // kind: 'subProcess'  (a nested FlowContainer; may host an on-compensation undo block)
  | CallActivity // kind: 'callActivity'  (starts another process; in/out mappings, binding, businessKey)
  | IntermediateThrowEvent; // kind: 'intermediateThrowEvent'  (an emit: escalation | signal | compensation)

interface SequenceFlow {
  id: string;
  sourceRef: string; // id of source FlowElement
  targetRef: string; // id of target FlowElement
  conditionExpression?: string; // e.g. "${amount > 1000}"
}
```

A `ServiceTask` binds to exactly one execution form, tagged by `binding.kind`: `class` (a Java delegate class, `operaton:class`), `expression` (`operaton:expression`), `delegateExpression` (`operaton:delegateExpression` — the DSL surface alias is `delegate`), or `external` (`operaton:type="external"` + `operaton:topic`). The tagged union makes "more than one binding" unrepresentable at the type level and keeps every consumer's `switch (binding.kind)` exhaustive.

`SubProcess` is itself a `FlowContainer`, so the IR is recursive: a sub-process nests its own `flowElements`/`sequenceFlows` at any depth, and sequence flows never cross a container boundary. Event-layer semantics ride on an `eventDefinition` field (optional on a start or end event, required on an intermediate throw): a handler's `StartEvent`, a typed `EndEvent`, and an `IntermediateThrowEvent` each carry an `EventDefinition` (error, escalation, message, signal, timer, conditional, or the payload-less compensation). The document-level `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/`bpmn:Signal` root elements are derived from usage rather than modeled — see [ADR-0016](../../docs/decisions/0016-derived-event-root-elements.md) and [ADR-0017](../../docs/decisions/0017-event-trigger-payload-surfaces.md).

Operaton-specific values (`operaton:historyTimeToLive = "P30D"`) are applied as constants at XML serialization time and are absent from the IR.

## Public API

```ts
// IR types (re-exported)
import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow,
  StartEvent,
  EndEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  ExclusiveGateway,
  ParallelGateway,
} from '@bpmn-script/transform';

// Langium AST → IR  (synchronous)
import { astToIr } from '@bpmn-script/transform';
const ir: BpmnProcess = astToIr(langiumAstModel);

// IR → BPMN 2.0 XML string with bpmndi: layout data  (async)
import { irToXml } from '@bpmn-script/transform';
const xml: string = await irToXml(ir);

// BPMN 2.0 XML string → IR  (async; discards DI on import, refuses BPMN
// content the IR cannot express, and warns about non-semantic drops)
import { xmlToIr } from '@bpmn-script/transform';
const { ir, warnings } = await xmlToIr(xmlString);

// IR → .bpmnscript DSL string  (synchronous)
import { irToDsl } from '@bpmn-script/transform';
const dsl: string = irToDsl(ir);

// Deterministic id helpers
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  resolveCollision,
} from '@bpmn-script/transform';

// JUEL expression parser and serializer (import / decompile path)
import { parseJuel, renderRawFallback } from '@bpmn-script/transform';
import type {
  JuelNode,
  Accessor,
  BinaryOp,
  ExprResult,
} from '@bpmn-script/transform';

// Error classes
import {
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedServiceTaskFormError,
  UnsupportedFormFieldTypeError,
  UnsupportedCallActivityError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedCollaborationError,
} from '@bpmn-script/transform';

// Import-warnings type (non-fatal, non-semantic drops)
import type {
  ImportWarning,
  ImportWarningCategory,
} from '@bpmn-script/transform';
```

### The import contract: refuse or warn, never drop silently

See [ADR-0014](../../docs/decisions/0014-honest-bpmn-import-contract.md) for the rationale.
`xmlToIr` never silently discards content it cannot represent. Content splits into two buckets:

- **Refused** — content the IR cannot express at all. `xmlToIr` throws a subclass of `UnsupportedConstructError` before producing any IR, so there is no partial output.
- **Dropped with a warning** — content the IR does not carry but whose absence causes no semantic loss (an extra Operaton extension attribute, a lane). `xmlToIr` returns it via the `warnings` array instead of throwing.

### Error classes (refusals)

| Class                                 | Thrown by | Reason                                                                                                                                                                                                             |
| ------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedConstructError`           | —         | Abstract base of every refusal below. Catch it to classify any refusal as "unsupported construct" without enumerating subclasses.                                                                                 |
| `UnsupportedElementError`             | `xmlToIr` | Input XML contains a BPMN element *kind* outside the supported subset (e.g. `bpmn:intermediateCatchEvent`, `bpmn:transaction`, `bpmn:adHocSubProcess`) — embedded sub-processes and call activities are supported |
| `UnsupportedServiceTaskFormError`     | `xmlToIr` | A service task carries no supported execution binding — none of `operaton:class`, `operaton:expression`, `operaton:delegateExpression`, or `operaton:type="external"` with a usable `operaton:topic`               |
| `UnsupportedFormFieldTypeError`       | `xmlToIr` | An `operaton:formField` uses a `type` outside `string`/`long`/`boolean`/`date` (e.g. `double`, `enum`, a custom type); refused so the field's input semantics are not silently narrowed                            |
| `UnsupportedCallActivityError`        | `xmlToIr` | A `bpmn:callActivity` the engine could not resolve or execute — no `calledElement`, a `version` binding with no `calledElementVersion`, an unrecognized binding value, or an `operaton:in`/`operaton:out` mapping shape the IR cannot represent |
| `UnsupportedEventDefinitionError`     | `xmlToIr` | An event carries the *wrong kind* of definition for its position — any definition on a plain start event; anything but error/escalation/message/signal/timer/conditional/compensation on a handler start; anything but error/escalation/signal/compensation on an end event or intermediate throw (terminate, link, …) |
| `UnsupportedEventFeatureError`        | `xmlToIr` | An event construct of the *right kind* but a *shape* the surface cannot express — a non-interrupting error or compensation handler, a throw/emit resolving to no code, a boundary compensation event, an `activityRef`- or `waitForCompletion="false"`-carrying compensate throw, an `isForCompensation` activity, a mis-hosted compensation event sub-process, or a handler with the wrong start-event/definition count |
| `UnsupportedLoopCharacteristicsError` | `xmlToIr` | A task or sub-process carries loop characteristics (multi-instance or standard loop); the IR models elements that run exactly once                                                                                 |
| `UnsupportedCollaborationError`       | `xmlToIr` | The document contains a `bpmn:Collaboration` (pools and/or message flows); the IR models a single standalone process                                                                                              |

### Import warnings (non-semantic drops)

`xmlToIr` returns `{ ir, warnings }`. Each `ImportWarning` names a construct that was dropped but did not change what the process executes:

```ts
interface ImportWarning {
  elementId: string; // BPMN id of the element the dropped content was attached to
  category: 'extensionAttribute' | 'lane' | 'label' | 'unreferencedRoot';
  message: string; // names the concrete dropped construct
}
```

- `extensionAttribute` — an Operaton/camunda extension attribute or extension element beyond the supported `assignee`/`formKey`/`class` (e.g. `operaton:asyncBefore`, an `operaton:inputOutput` block, or `itemRef`/`structureRef` on a referenced message/signal root). Attribution is exact when moddle ties the content to its owning element; the handful of undeclared `operaton:` elements moddle cannot pin to a specific step are reported once against the process id instead — still never silent, only coarser.
- `lane` — a `bpmn:Lane`; the flat IR has no lane concept, so every step lands in a single process and the lane assignment is dropped.
- `label` — a distinct `name` on an event handler, throw, or emit; these read from their trigger and code, so a label that differs has nowhere to render and is dropped.
- `unreferencedRoot` — a `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/`bpmn:Signal` root element no event definition references; with nothing pointing at it, it adds nothing to the imported process.

`warnings` is `[]` for input that round-trips cleanly.

## Build and test

```bash
# From repo root
npm run build --workspace packages/transform
npm test --workspace packages/transform

# From this directory
npm run build
npm test
```

## Source layout

| Path                       | Purpose                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ir/types.ts`          | IR type definitions (`BpmnProcess`, `FlowElement`, `SequenceFlow`, …)                                                                                                                                                                  |
| `src/synthesize-ids.ts`    | Deterministic structural id generators (frozen contract; see [ADR-0010](../../docs/decisions/0010-deterministic-structural-ids.md))                                                                                                    |
| `src/ast-to-ir.ts`         | `astToIr`: desugar structured AST → flat IR (gateway synthesis, implicit start/end)                                                                                                                                                    |
| `src/ir-to-xml.ts`         | `irToXml`: IR → BPMN 2.0 XML with Operaton extensions and auto-layout                                                                                                                                                                  |
| `src/xml-to-ir.ts`         | `xmlToIr`: BPMN 2.0 XML → `{ ir, warnings }` (DI discarded, refuses constructs the IR cannot express, warns about non-semantic drops)                                                                                                  |
| `src/cfg-analysis.ts`      | `analyzeCfg`: dominator/post-dominator/back-edge analysis for `irToDsl`                                                                                                                                                                |
| `src/ir-to-dsl.ts`         | `irToDsl`: restructure flat IR → structured DSL text; degrades to `goto` (see [ADR-0009](../../docs/decisions/0009-dominator-based-restructuring.md))                                                                                  |
| `src/juel.ts`              | `parseJuel`, `renderRawFallback`: JUEL-subset parser and serializer for the import/decompile path                                                                                                                                      |
| `src/errors.ts`            | `UnsupportedConstructError` (base) and its refusal subclasses: `UnsupportedElementError`, `UnsupportedServiceTaskFormError`, `UnsupportedFormFieldTypeError`, `UnsupportedCallActivityError`, `UnsupportedEventDefinitionError`, `UnsupportedEventFeatureError`, `UnsupportedLoopCharacteristicsError`, `UnsupportedCollaborationError` |
| `src/index.ts`             | Package barrel export                                                                                                                                                                                                                  |
| `src/operaton-moddle.json` | Trimmed Operaton moddle extension descriptor (see [ADR-0007](../../docs/decisions/0007-operaton-moddle-extension-fork.md))                                                                                                             |

## Key implementation notes

- `irToXml` uses `bpmn-moddle@^10` and `bpmn-auto-layout@^1.2.0`. The layout library injects `<bpmndi:BPMNDiagram>` data automatically; the IR has no coordinate fields.
- The Operaton namespace is applied via `src/operaton-moddle.json`, a trimmed fork of the camunda-bpmn-moddle descriptor. See [ADR-0007](../../docs/decisions/0007-operaton-moddle-extension-fork.md).
- `bpmn-auto-layout@1.x` exposes `layoutProcess(xml)` as a flat named export. The `new BpmnAutoLayout()` constructor pattern belongs to the 0.x series and is not used here.
- `irToDsl` uses dominator/post-dominator analysis from `cfg-analysis.ts` to recognize structured patterns; unmatched edges become `goto`. See [ADR-0009](../../docs/decisions/0009-dominator-based-restructuring.md).
- All synthesized gateway and flow ids come from `synthesize-ids.ts`. The id templates are frozen — changes require updating the round-trip normalizer and regenerating `tests/golden/invoice-approval-generated.bpmn`. See [ADR-0010](../../docs/decisions/0010-deterministic-structural-ids.md).
- `juel.ts` is a hand-rolled recursive-descent parser that mirrors the Langium expression sub-grammar in `bpmn-script.langium`. It is used on the import path (`xmlToIr` reads raw `${…}` bodies; `irToDsl` decides whether to emit native syntax or the quoted fallback).
- `xml-to-ir.ts` refuses (throws) BPMN content the IR cannot express — an event definition of the wrong kind for its position, an event feature the surface does not model, an unsupported element kind, an unresolvable call activity, loop characteristics, collaborations — before producing any IR, and warns (via the returned `warnings` array) about non-semantic drops such as extra Operaton extension attributes and lanes. See the file's own docstring and "Import warnings" above for the exact contract.

## Dependencies on other packages

- `@bpmn-script/language` (workspace) — provides the Langium-generated AST types consumed by `astToIr` and the `renderExpression` helper.
