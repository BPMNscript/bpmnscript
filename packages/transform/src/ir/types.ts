/**
 * Intermediate Representation (IR) for BPMNscript: a small, statically typed
 * graph of flow elements and sequence flows.
 *
 * Per ADR 0006 the IR is the single hinge between all transforms. The compile
 * (`astToIr`, `irToXml`) and decompile (`xmlToIr`, `irToDsl`) directions both
 * meet here, so the round-trip is one shared model rather than two independent
 * converters. Sitting between Langium's block-structured AST and moddle's
 * serialization-bound object model, it gives gateway synthesis and structural
 * recovery a clean graph to operate on.
 *
 * The project targets Operaton, so the IR carries the semantics Operaton
 * executes under field names that carry no vendor prefix. Vendor-specific
 * concerns that vary only at serialization (e.g. `operaton:historyTimeToLive`)
 * are not fields here; they are attached by the IR → XML transform.
 */

/**
 * A structural container of flow: a set of {@link FlowElement} nodes plus the
 * {@link SequenceFlow} edges connecting them, addressed by a document-unique
 * `id`. Both the root {@link BpmnProcess} and an embedded {@link SubProcess}
 * are containers, so every per-container transform pass — CFG analysis,
 * incoming/outgoing wiring, gateway defaults, restructuring — operates on this
 * shape rather than on the process alone.
 *
 * Sequence flows never cross a container boundary: an edge's `sourceRef` and
 * `targetRef` always name elements of the same container, which is why a
 * parent can treat a nested container as one opaque activity node.
 */
export interface FlowContainer {
  /** The BPMN `id` attribute. Document-unique across the definitions (an XML ID). */
  id: string;
  /** All flow nodes (start/end events, tasks, gateways, sub-processes). */
  flowElements: FlowElement[];
  /** All sequence flows connecting this container's flow elements. */
  sequenceFlows: SequenceFlow[];
}

/**
 * The root IR node. Represents a single executable BPMN process, and is the
 * top-level {@link FlowContainer}.
 *
 * `isExecutable` is always `true` — the DSL targets Operaton, which
 * requires executable processes.
 *
 * `operaton:historyTimeToLive` is emitted as `"P30D"` at serialization
 * and is therefore intentionally absent from the IR.
 */
export interface BpmnProcess extends FlowContainer {
  /** The human-readable process name (`name` attribute). */
  name?: string;
  /** Always `true`. */
  isExecutable: true;
}

/**
 * Discriminated union of all supported flow-element kinds.
 *
 * The `kind` discriminant is the single source of truth for narrowing
 * the union in switch/if chains across the codebase.
 *
 * The union is recursive: a {@link SubProcess} is itself a
 * {@link FlowContainer}, so a flow element can nest a whole body of flow
 * elements and sequence flows.
 */
export type FlowElement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | ExclusiveGateway
  | ParallelGateway
  | SubProcess;

/**
 * The type of a {@link FormField}, in DSL-level (vendor-neutral) spelling.
 * Mapped to the Operaton `operaton:formField` `type` at serialization
 * (`number` becomes `long`) and back again on import.
 */
export type FormFieldType = 'string' | 'number' | 'boolean' | 'date';

/**
 * A form field rendered by Operaton Tasklist, serialized as an
 * `<operaton:formField>` inside the owning element's `<operaton:formData>`
 * extension element.
 *
 * `id` is both the field id and the process variable the field binds, so a
 * form field doubles as the declaration of where that variable comes from.
 */
export interface FormField {
  /** `operaton:formField id` — also the bound process-variable name. */
  id: string;
  /** DSL-level field type; mapped to the Operaton `type` at serialization. */
  type: FormFieldType;
  /** `operaton:formField label` — the human-readable label. */
  label?: string;
  /** `operaton:formField defaultValue` — optional default, carried as text. */
  defaultValue?: string;
}

/**
 * A BPMN `startEvent` node.
 *
 * `formFields`, when present, become an `operaton:formData` block so Tasklist
 * renders a start form.
 */
export interface StartEvent {
  kind: 'startEvent';
  id: string;
  name?: string;
  formFields?: FormField[];
}

/** A BPMN `endEvent` node. */
export interface EndEvent {
  kind: 'endEvent';
  id: string;
  name?: string;
}

/**
 * A BPMN `userTask` node.
 *
 * Optional Operaton extensions:
 * - `assignee` maps to `operaton:assignee`.
 * - `formKey` maps to `operaton:formKey`.
 * - `formFields` map to an `operaton:formData` block.
 */
export interface UserTask {
  kind: 'userTask';
  id: string;
  name?: string;
  /** `operaton:assignee` — the user or group responsible for this task. */
  assignee?: string;
  /** `operaton:formKey` — the embedded form key. */
  formKey?: string;
  /** `operaton:formData` fields Tasklist renders for this task. */
  formFields?: FormField[];
}

/**
 * The four ways a {@link ServiceTask} is bound to executable behavior.
 *
 * Exactly one binding applies per service task. Tagging the union on
 * `kind` makes "more than one binding" unrepresentable at the type level,
 * rather than pushing the invariant into a runtime check across several
 * optional fields, and keeps every consumer's `switch (binding.kind)`
 * exhaustive when a new binding is added.
 */
export type ServiceTaskBinding =
  | {
      kind: 'class';
      /** Fully-qualified Java class name (`operaton:class`). */
      className: string;
    }
  | {
      kind: 'expression';
      /** Raw JUEL expression text, verbatim (`operaton:expression`). */
      expression: string;
    }
  | {
      kind: 'delegateExpression';
      /** Raw JUEL expression text, verbatim (`operaton:delegateExpression`). */
      expression: string;
    }
  | {
      kind: 'external';
      /** External task topic name (`operaton:topic`, with `operaton:type="external"`). */
      topic: string;
    };

/**
 * A BPMN `serviceTask` node.
 *
 * `binding` carries exactly one of the four execution forms Operaton
 * supports: a Java class delegate, a JUEL expression, a delegate
 * expression, or an external task topic.
 */
export interface ServiceTask {
  kind: 'serviceTask';
  id: string;
  name?: string;
  /** The execution form and its associated value. */
  binding: ServiceTaskBinding;
}

/**
 * A BPMN `scriptTask` node.
 *
 * `format` is the canonical Operaton `scriptFormat` value (e.g.
 * `"javascript"`, `"groovy"`); `code` is the raw script body as it
 * appears inside the `<bpmn:script>` element, verbatim.
 */
export interface ScriptTask {
  kind: 'scriptTask';
  id: string;
  name?: string;
  /** Canonical Operaton `scriptFormat` (e.g. `"javascript"`, `"groovy"`). */
  format: string;
  /** Raw script body, verbatim. */
  code: string;
}

/**
 * A BPMN `exclusiveGateway` (XOR gateway).
 *
 * `defaultFlowId` is the `id` of the {@link SequenceFlow} that is taken
 * when no other condition matches. Corresponds to the BPMN `default`
 * attribute on the gateway element.
 */
export interface ExclusiveGateway {
  kind: 'exclusiveGateway';
  id: string;
  name?: string;
  /**
   * The `id` of the default {@link SequenceFlow}.
   * When absent, the gateway has no explicit default path.
   */
  defaultFlowId?: string;
}

/**
 * A BPMN `parallelGateway` (AND gateway).
 *
 * Used as both a fork (split into concurrent branches) and a join
 * (synchronize all incoming branches). Every outgoing flow is taken
 * unconditionally, so outgoing flows carry no conditions and there is
 * no `default` field.
 */
export interface ParallelGateway {
  kind: 'parallelGateway';
  id: string;
  name?: string;
}

/**
 * A BPMN `subProcess` (embedded) node — an activity that is itself a
 * {@link FlowContainer}.
 *
 * Its `flowElements` and `sequenceFlows` describe the nested body. Those
 * sequence flows never cross the container boundary, so the parent container
 * treats the whole sub-process as one opaque activity node: a parent-level
 * flow into the sub-process targets it by `id`, and a fall-through flow leaves
 * it by `id`.
 *
 * `name`, when present, is the human-readable label viewers render on the
 * expanded box.
 */
export interface SubProcess extends FlowContainer {
  kind: 'subProcess';
  name?: string;
}

/**
 * A BPMN `sequenceFlow` connecting two flow elements.
 *
 * `sourceRef` and `targetRef` hold the **ids** of the connected elements,
 * not object references, to keep the IR serializable and acyclic.
 *
 * `conditionExpression` carries the raw expression body as it will appear
 * inside a `<bpmn:formalExpression>` element (e.g. `${amount > 1000}`).
 */
export interface SequenceFlow {
  id: string;
  /** Id of the source {@link FlowElement}. */
  sourceRef: string;
  /** Id of the target {@link FlowElement}. */
  targetRef: string;
  /**
   * Raw expression body for conditional flows.
   * Example: `"${amount > 1000}"`.
   */
  conditionExpression?: string;
}
