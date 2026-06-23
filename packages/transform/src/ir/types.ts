/**
 * Engine-agnostic Intermediate Representation (IR) for BPMNscript.
 *
 * Per ADR 0006 the IR is the single hinge between all transforms. Every
 * transform either produces or consumes these types. Vendor-specific
 * concerns (e.g. `operaton:historyTimeToLive`) are not fields here; they
 * are attached at serialization time by the IR → XML transform.
 */

/**
 * The root IR node. Represents a single executable BPMN process.
 *
 * `isExecutable` is always `true` — the DSL targets Operaton, which
 * requires executable processes.
 *
 * `operaton:historyTimeToLive` is emitted as `"P30D"` at serialization
 * and is therefore intentionally absent from the IR.
 */
export interface BpmnProcess {
  /** The BPMN `id` attribute. Must be unique within the definitions. */
  id: string;
  /** The human-readable process name (`name` attribute). */
  name?: string;
  /** Always `true`. */
  isExecutable: true;
  /** All flow nodes (start events, end events, tasks, gateways). */
  flowElements: FlowElement[];
  /** All sequence flows connecting the flow elements. */
  sequenceFlows: SequenceFlow[];
}

/**
 * Discriminated union of all supported flow-element kinds.
 *
 * The `kind` discriminant is the single source of truth for narrowing
 * the union in switch/if chains across the codebase.
 */
export type FlowElement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTaskJavaClass
  | ExclusiveGateway
  | ParallelGateway;

/** A BPMN `startEvent` node. */
export interface StartEvent {
  kind: 'startEvent';
  id: string;
  name?: string;
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
 */
export interface UserTask {
  kind: 'userTask';
  id: string;
  name?: string;
  /** `operaton:assignee` — the user or group responsible for this task. */
  assignee?: string;
  /** `operaton:formKey` — the embedded form key. */
  formKey?: string;
}

/**
 * A BPMN `serviceTask` implemented via a Java class delegate.
 *
 * Only the Java-class pattern (`operaton:class`) is supported. Tasks using
 * `operaton:expression` or `operaton:delegateExpression` are refused on
 * import with an `UnsupportedServiceTaskFormError`.
 */
export interface ServiceTaskJavaClass {
  kind: 'serviceTask';
  id: string;
  name?: string;
  /** Fully-qualified Java class name (`operaton:class`). */
  javaClass: string;
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
 * (synchronize all incoming branches). Parallel gateways do not carry
 * conditions on outgoing flows — Operaton executes every outgoing path
 * unconditionally.
 *
 * There is no `default` field: parallel gateways take all outgoing flows
 * simultaneously; the concept of a "default path" does not apply.
 */
export interface ParallelGateway {
  kind: 'parallelGateway';
  id: string;
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
