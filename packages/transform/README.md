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

This package is the transformation layer of BPMNscript. It defines the engine-agnostic Intermediate Representation (IR) that all transforms share, and implements the four functions that convert between IR, BPMN 2.0 XML, and DSL text (see [ADR-0006](../../docs/decisions/0006-engine-agnostic-intermediate-representation.md)).

## IR shape

The IR represents a single executable BPMN process. All types are in `src/ir/types.ts` and re-exported from the package root.

```ts
interface BpmnProcess {
  id: string;
  name?: string;
  isExecutable: true; // always true (executable process)
  flowElements: FlowElement[];
  sequenceFlows: SequenceFlow[];
}

type FlowElement =
  | StartEvent // kind: 'startEvent'
  | EndEvent // kind: 'endEvent'
  | UserTask // kind: 'userTask'  (+assignee?, +formKey?)
  | ServiceTaskJavaClass // kind: 'serviceTask' (+javaClass required)
  | ExclusiveGateway; // kind: 'exclusiveGateway' (+defaultFlowId?)

interface SequenceFlow {
  id: string;
  sourceRef: string; // id of source FlowElement
  targetRef: string; // id of target FlowElement
  conditionExpression?: string; // e.g. "${amount > 1000}"
}
```

Operaton-specific values (`operaton:historyTimeToLive = "P30D"`) are applied as constants at XML serialization time and are absent from the IR.

## Public API

```ts
// IR types (re-exported)
import type { BpmnProcess, FlowElement, SequenceFlow, ... } from '@bpmn-script/transform';

// Langium AST → IR  (synchronous)
import { astToIr } from '@bpmn-script/transform';
const ir: BpmnProcess = astToIr(langiumAstModel);

// IR → BPMN 2.0 XML string with bpmndi: layout data  (async)
import { irToXml } from '@bpmn-script/transform';
const xml: string = await irToXml(ir);

// BPMN 2.0 XML string → IR  (async, DI discarded on import)
import { xmlToIr } from '@bpmn-script/transform';
const ir: BpmnProcess = await xmlToIr(xmlString);

// IR → .bpmnscript DSL string  (synchronous)
import { irToDsl } from '@bpmn-script/transform';
const dsl: string = irToDsl(ir);

// Error classes
import { UnsupportedElementError, UnsupportedServiceTaskFormError } from '@bpmn-script/transform';
```

### Error classes

| Class                             | Thrown by | Reason                                                                                                               |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedElementError`         | `xmlToIr` | Input XML contains a BPMN element type outside the supported subset (e.g. `bpmn:ParallelGateway`)                    |
| `UnsupportedServiceTaskFormError` | `xmlToIr` | A service task uses `operaton:expression` or `operaton:delegateExpression` instead of the supported `operaton:class` |

## Build and test

```bash
# From repo root
npm run build --workspace packages/transform
npm test --workspace packages/transform

# From this directory
npm run build
npm test
```

## Key implementation notes

- `irToXml` uses `bpmn-moddle@^10` and `bpmn-auto-layout@^1.2.0`. The layout library injects `<bpmndi:BPMNDiagram>` data automatically; the IR has no coordinate fields.
- The Operaton namespace is applied via `src/operaton-moddle.json`, a trimmed fork of the camunda-bpmn-moddle descriptor. See [ADR-0007](../../docs/decisions/0007-operaton-moddle-extension-fork.md).
- `bpmn-auto-layout@1.x` exposes `layoutProcess(xml)` as a flat named export. The `new BpmnAutoLayout()` constructor pattern belongs to the 0.x series and is not used here.

## Dependencies on other packages

- `@bpmn-script/language` (workspace) — provides the Langium-generated AST types consumed by `astToIr`.
