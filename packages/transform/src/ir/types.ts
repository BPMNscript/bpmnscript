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
  /**
   * Declared thrown-message texts, keyed by error code, in declaration order.
   *
   * This is the one piece of document-level root-element data that is not
   * derivable from usage. Everything else about the `bpmn:Error` /
   * `bpmn:Escalation` root elements — which codes exist, their ids, their refs —
   * is synthesized from where codes are thrown and caught (see {@link
   * EventDefinition}). But the message an error of a given code carries when
   * thrown is authorial intent that no throw site records: two throws of one
   * code share a single root element, so the text cannot live on the throw.
   * It is declared once per code and stamped onto the synthesized
   * `bpmn:Error` (as `operaton:errorMessage`) at export. Escalations have no
   * message concept, so only error codes appear here. A declared code emits its
   * root element even when otherwise unused.
   */
  errorMessages?: { code: string; message: string }[];
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
  | SubProcess
  | CallActivity
  | IntermediateThrowEvent;

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
 * An error or escalation event definition — the DSL's try/catch payload.
 *
 * The same shape describes both sides of the analogy:
 *   - On a **catch** (the trigger start event of an `on` handler): the code
 *     selects which thrown code this handler catches; a **missing** code means
 *     catch-all (it catches any error/escalation, and export emits no
 *     `errorRef`/`escalationRef`). The `codeVariable`/`messageVariable`
 *     bindings name the process variables the caught code and message text
 *     fill — the `e` in `catch (Exception e)`.
 *   - On a **throw** (a typed `endEvent`, or an {@link IntermediateThrowEvent}):
 *     the code identifies what is thrown; the bindings do not apply and the
 *     engine ignores them there.
 *
 * The type stays permissive on purpose — it mirrors what BPMN can represent,
 * not the rulebook for where each field is meaningful. The validator and the
 * import contract enforce that bindings appear only on catch definitions and
 * that a throw resolves to a non-empty code; the types do not.
 *
 * Escalations carry a code but no message text (BPMN/Operaton has no escalation
 * message), so the escalation variant has only `codeVariable`.
 *
 * The remaining four variants are trigger-only (they have no throw-side bindings):
 *   - **message** — the process's inbox. A handler runs when the engine delivers
 *     a message with this name; delivery is the engine's correlation API, so
 *     nothing about it is modeled here beyond the name.
 *   - **signal** — a broadcast channel. `emit signal` notifies every listener
 *     everywhere and keeps going; `throw signal` broadcasts and ends this path
 *     (unlike an escalation, which only travels up its own scope).
 *   - **timer** — a deadline relative to scope activation. `after` is a duration
 *     ("if this scope is still running after an hour"), `at` a point in time,
 *     `every` a repeating schedule; the clock starts when the surrounding scope
 *     starts.
 *   - **conditional** — a data watchdog. The condition is checked when the scope
 *     starts and re-checked whenever a variable changes; the parens read exactly
 *     like `if`.
 *
 * `messageName` and `signalName` are the identity of the message/signal: the
 * engine subscribes by name, so a nameless handler is meaningless, and the
 * document-level `bpmn:Message`/`bpmn:Signal` root elements are derived by
 * deduplicating on this name (every use of one name — a handler, an `emit`, a
 * `throw` — shares one root). `timerKind` maps 1:1 to the BPMN
 * `timeDuration`/`timeDate`/`timeCycle` forms and `expression` is the verbatim
 * time text (EL such as `${dueDate}` passes through unaltered for the engine to
 * evaluate). `condition` is the raw `${…}` body, exactly the
 * {@link SequenceFlow.conditionExpression} convention.
 */
export type EventDefinition =
  | {
      kind: 'error';
      /** The caught/thrown error code; absent on a catch means catch-all. */
      errorCode?: string;
      /** `operaton:errorCodeVariable` — process variable the code fills. */
      codeVariable?: string;
      /** `operaton:errorMessageVariable` — process variable the message fills. */
      messageVariable?: string;
    }
  | {
      kind: 'escalation';
      /** The caught/thrown escalation code; absent on a catch means catch-all. */
      escalationCode?: string;
      /** `operaton:escalationCodeVariable` — process variable the code fills. */
      codeVariable?: string;
    }
  | {
      kind: 'message';
      /** The message name — the correlation identity and root-element dedupe key. */
      messageName: string;
    }
  | {
      kind: 'signal';
      /** The signal name — the broadcast identity and root-element dedupe key. */
      signalName: string;
    }
  | {
      kind: 'timer';
      /** Maps 1:1 to the `timeDuration`/`timeDate`/`timeCycle` BPMN forms. */
      timerKind: 'duration' | 'date' | 'cycle';
      /** The verbatim time text (ISO-8601 or EL such as `${dueDate}`). */
      expression: string;
    }
  | {
      kind: 'conditional';
      /** The raw `${…}` condition body (the `conditionExpression` convention). */
      condition: string;
    };

/**
 * A BPMN `startEvent` node.
 *
 * `formFields`, when present, become an `operaton:formData` block so Tasklist
 * renders a start form.
 *
 * Inside an event sub-process (a `triggeredByEvent` {@link SubProcess}) the
 * start event is the handler's trigger: `eventDefinition` carries the caught
 * error/escalation and its catch bindings, and `isInterrupting` is stored only
 * when non-default. BPMN's default is interrupting (`true`), and the serializer
 * drops the default, so the IR keeps only the non-default `false` — true or
 * absent are the same thing, which keeps IR deep-equality trivial. A definition
 * on a start event outside an event sub-process is malformed hand-built IR.
 */
export interface StartEvent {
  kind: 'startEvent';
  id: string;
  name?: string;
  formFields?: FormField[];
  /** The caught trigger, when this start opens an event sub-process. */
  eventDefinition?: EventDefinition;
  /** Stored only for a non-interrupting (`alongside`) handler start. */
  isInterrupting?: false;
}

/**
 * A BPMN `endEvent` node.
 *
 * When `eventDefinition` is present the end event is a typed throw — `throw
 * error`/`throw escalation` — that ends the path while raising the code. A
 * plain end (no definition) is the ordinary process/branch terminator.
 */
export interface EndEvent {
  kind: 'endEvent';
  id: string;
  name?: string;
  /** The thrown error/escalation, when this end is a typed throw. */
  eventDefinition?: EventDefinition;
}

/**
 * A BPMN `intermediateThrowEvent` node — the DSL's `emit` verb.
 *
 * Unlike a typed {@link EndEvent} throw, an intermediate throw fires the event
 * and lets flow continue (it is a plain fall-through node in the graph). Only
 * an escalation is emittable this way: BPMN has no intermediate error throw, so
 * `emit error` is refused and the author is taught `throw error` instead. The
 * `eventDefinition` is therefore **required** — a none intermediate throw is
 * inexpressible and refused on import — and there is no `name` field, because
 * the `emit` surface carries no label slot.
 */
export interface IntermediateThrowEvent {
  kind: 'intermediateThrowEvent';
  id: string;
  eventDefinition: EventDefinition;
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
 *
 * `triggeredByEvent` marks an **event sub-process** — the container an `on`
 * handler lowers to. Such a sub-process is not wired into its parent's flow
 * (it has no incoming/outgoing sequence flows); it is triggered by the
 * error/escalation its single start event catches. The field is only ever
 * `true`; absent means a plain, flow-connected sub-process.
 */
export interface SubProcess extends FlowContainer {
  kind: 'subProcess';
  name?: string;
  /** `true` for an event sub-process (an `on` handler); absent otherwise. */
  triggeredByEvent?: true;
}

/**
 * How a {@link CallActivity} resolves the version of the process it calls.
 *
 * `latest` and `deployment` bind by strategy; `version` pins one concrete
 * version. Tagging the union on `kind` makes `version` without a version
 * string — and a version string without an explicit binding — unrepresentable
 * at the type level, mirroring the {@link ServiceTaskBinding} precedent, so no
 * consumer has to guard a "version set but binding absent" combination at
 * runtime.
 */
export type CalledElementBinding =
  | { kind: 'latest' }
  | { kind: 'deployment' }
  | { kind: 'version'; version: string };

/**
 * One data mapping between the caller and the called process — the argument
 * and return-value passing of the function-call analogy (see
 * {@link CallActivity}).
 *
 * The receiver always names the left-hand side: for an in-mapping `target` is
 * the variable created in the callee; for an out-mapping `target` is the
 * variable created back in the caller. Tagging the union on `kind` makes the
 * three source forms mutually exclusive — `all` copies every variable,
 * `variable` copies one source variable by name, `expression` evaluates an
 * expression — so a mapping carrying both a plain `source` and a
 * `sourceExpression` is unrepresentable, again mirroring
 * {@link ServiceTaskBinding}.
 *
 * `local` restricts the mapping to the activity's local scope when set; it is
 * only ever `true` (an absent `local` is the default, non-local behavior).
 */
export type CallVariableMapping =
  | { kind: 'all'; local?: true }
  | { kind: 'variable'; source: string; target: string; local?: true }
  | {
      kind: 'expression';
      sourceExpression: string;
      target: string;
      local?: true;
    };

/**
 * A BPMN `callActivity` node — an activity that invokes another process by id,
 * the DSL's process-call construct.
 *
 * The construct reads as a function call: the called `process` is the function,
 * the `inMappings` are its arguments (values passed from caller into callee),
 * and the `outMappings` are its return values (values passed from callee back
 * to caller). It is a LEAF, not a {@link FlowContainer}: the callee's body
 * lives in its own definition, so a call activity carries no nested
 * `flowElements`/`sequenceFlows`.
 *
 * The Operaton extension attributes and children serialize in one canonical
 * order so the round-trip is stable: `calledElement` and the
 * `calledElementBinding`/`calledElementVersion` attributes on the element, then
 * inside `extensionElements` a single `operaton:in` for `businessKey` (when
 * set), then one `operaton:in` per {@link inMappings} entry in order, then one
 * `operaton:out` per {@link outMappings} entry in order.
 */
export interface CallActivity {
  kind: 'callActivity';
  id: string;
  name?: string;
  /** `bpmn:calledElement` — the id of the process this activity invokes. */
  calledElement: string;
  /** Version-resolution strategy; absent means the engine default (latest). */
  binding?: CalledElementBinding;
  /** `operaton:in businessKey` — the business key propagated to the callee. */
  businessKey?: string;
  /** Argument mappings passed from caller into callee, in emission order. */
  inMappings?: CallVariableMapping[];
  /** Return-value mappings passed from callee back to caller, in emission order. */
  outMappings?: CallVariableMapping[];
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
