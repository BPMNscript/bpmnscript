/**
 * Intermediate Representation for BPMNscript: a statically typed graph of flow
 * elements and sequence flows, shared by all four transforms. Field names carry
 * no vendor prefix; the IR -> XML transform applies `operaton:` and anything
 * that varies only at serialization.
 *
 * See ADR 0006, Use an Intermediate Representation between the AST and BPMN XML.
 */

import type {
  DECISION_RESULT_MAPPINGS,
  EXECUTION_LISTENER_EVENTS,
  FORM_FIELD_TYPES,
  TASK_LISTENER_EVENTS,
} from '@bpmn-script/language';

/**
 * Sequence flows never cross a container boundary, so a parent can treat a
 * nested container as one opaque activity node.
 */
export interface FlowContainer {
  /** Unique across the whole definitions document, as an XML ID must be. */
  id: string;
  flowElements: FlowElement[];
  sequenceFlows: SequenceFlow[];
}

export interface BpmnProcess extends FlowContainer {
  name?: string;
  /** Always `true`; Operaton runs only executable processes. */
  isExecutable: true;
  /** Distinct from the engine's deployment version. */
  versionTag?: string;
  /**
   * In declaration order. Stored rather than derived from usage because two
   * throws of one code share a root element, and a declared code emits its root
   * even when unused. See ADR 0016, Derive Event Root Elements From Usage.
   */
  errorMessages?: { code: string; message: string }[];
}

export type FlowElement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | Task
  | ReceiveTask
  | ExclusiveGateway
  | ParallelGateway
  | InclusiveGateway
  | EventBasedGateway
  | SubProcess
  | CallActivity
  | IntermediateThrowEvent
  | IntermediateCatchEvent
  | BoundaryEvent;

/** Every flow element of `container`, and of the sub-processes nested in it. */
export function* eachElement(container: FlowContainer): Generator<FlowElement> {
  for (const el of container.flowElements) {
    yield el;
    if (el.kind === 'subProcess') yield* eachElement(el);
  }
}

/**
 * Depth-first, in first-appearance order. Every position contributes equally,
 * so a message caught by an `await` and one caught by a handler share a root.
 */
function collectEventDefinitions(container: FlowContainer): EventDefinition[] {
  const defs: EventDefinition[] = [];
  for (const el of eachElement(container)) {
    switch (el.kind) {
      case 'startEvent':
      case 'endEvent':
        if (el.eventDefinition !== undefined) defs.push(el.eventDefinition);
        break;
      case 'intermediateThrowEvent':
      case 'intermediateCatchEvent':
      case 'boundaryEvent':
        defs.push(el.eventDefinition);
        break;
      case 'receiveTask':
        // A receive task names its message on the element itself, and shares
        // one root with every other use of that name.
        if (el.messageName !== undefined) {
          defs.push({ kind: 'message', messageName: el.messageName });
        }
        break;
      default:
        break;
    }
  }
  return defs;
}

/** The identities a document-level root element is derived from, or checked against. */
export interface EventIdentities {
  errorCodes: Set<string>;
  escalationCodes: Set<string>;
  messageNames: Set<string>;
  signalNames: Set<string>;
}

/**
 * The codes and names the IR references, in first-appearance order. Read by
 * both XML directions, so the roots one synthesizes are exactly the roots the
 * other counts as referenced. A catch-all (no code) contributes none.
 */
export function eventIdentities(container: FlowContainer): EventIdentities {
  const identities: EventIdentities = {
    errorCodes: new Set(),
    escalationCodes: new Set(),
    messageNames: new Set(),
    signalNames: new Set(),
  };
  for (const def of collectEventDefinitions(container)) {
    switch (def.kind) {
      case 'error':
        if (def.errorCode !== undefined) {
          identities.errorCodes.add(def.errorCode);
        }
        break;
      case 'escalation':
        if (def.escalationCode !== undefined) {
          identities.escalationCodes.add(def.escalationCode);
        }
        break;
      case 'message':
        identities.messageNames.add(def.messageName);
        break;
      case 'signal':
        identities.signalNames.add(def.signalName);
        break;
      default:
        // Compensation, timer, and conditional need no document-level element.
        break;
    }
  }
  return identities;
}

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** An `<operaton:formField>` inside the owning element's `<operaton:formData>`. */
export interface FormField {
  /** Also the process variable the field binds. */
  id: string;
  type: FormFieldType;
  label?: string;
  /** Carried as text whatever the field's type. */
  defaultValue?: string;
}

/**
 * The payload of a catch or a throw. On a catch the code selects what the
 * handler catches and the bindings name the process variables the caught code
 * and text fill; on a throw the code says what is thrown and the engine ignores
 * the bindings. The type mirrors what BPMN can represent, not where each field
 * is meaningful: the validator and the import contract enforce that bindings
 * appear only on a catch and that a throw resolves to a non-empty code.
 *
 * See ADR 0016, Derive Event Root Elements From Usage, and ADR 0017, Event
 * Trigger Payloads.
 */
export type EventDefinition =
  | {
      kind: 'error';
      /** Absent on a catch means catch-all. */
      errorCode?: string;
      /** `operaton:errorCodeVariable`. */
      codeVariable?: string;
      /** `operaton:errorMessageVariable`. */
      messageVariable?: string;
    }
  | {
      kind: 'escalation';
      /** Absent on a catch means catch-all. */
      escalationCode?: string;
      /** `operaton:escalationCodeVariable`. BPMN has no escalation message. */
      codeVariable?: string;
    }
  | {
      /**
       * Payload-less: BPMN compensation carries no code and no `activityRef`.
       * `waitForCompletion` stays unmodeled because the moddle schema defaults
       * it to `true` and the engine supports no other value.
       */
      kind: 'compensation';
    }
  | {
      /**
       * Payload-free. It ends every running path of its scope at once rather
       * than raising something, which is why the surface spells it on an `end`
       * statement instead of a `throw`.
       */
      kind: 'terminate';
    }
  | {
      /**
       * Payload-free. It gives up the block it ends rather than raising
       * something, which is why the surface spells it on an `end` statement and
       * catches it on the block.
       */
      kind: 'cancel';
    }
  | {
      kind: 'message';
      /** Correlation identity, and the dedupe key: one name, one root element. */
      messageName: string;
    }
  | {
      kind: 'signal';
      /** Broadcast identity and dedupe key, global unlike an escalation. */
      signalName: string;
    }
  | {
      kind: 'timer';
      /** Maps 1:1 to the `timeDuration`/`timeDate`/`timeCycle` BPMN forms. */
      timerKind: 'duration' | 'date' | 'cycle';
      /** ISO-8601 or EL, verbatim. The clock starts with the surrounding scope. */
      expression: string;
    }
  | {
      kind: 'conditional';
      /** Raw `${...}` body, re-checked whenever a variable changes. */
      condition: string;
    };

/**
 * Mixed into every event and activity kind but not the gateways, which
 * `if`/`while`/`parallel` synthesize, leaving nowhere on the DSL surface to
 * author one. Each field is stored only in the non-default direction, so
 * `asyncBefore="false"` and `exclusive="true"` reproduce by omission. See ADR
 * 0022, Carry Operaton Engine Attributes as Named IR Fields.
 */
export interface EngineAttributes {
  asyncBefore?: true;
  asyncAfter?: true;
  exclusive?: false;
  /** An integer or EL, verbatim. */
  jobPriority?: string;
  /** The `operaton:failedJobRetryTimeCycle` element body, verbatim. */
  retryCycle?: string;
  /** In emission order. */
  executionListeners?: ExecutionListener[];
}

export function engineAttributes(found: {
  asyncBefore: boolean | undefined;
  asyncAfter: boolean | undefined;
  exclusive: boolean | undefined;
  jobPriority: string | undefined;
  retryCycle: string | undefined;
  executionListeners: ExecutionListener[] | undefined;
}): EngineAttributes {
  return {
    ...(found.asyncBefore === true ? { asyncBefore: true } : {}),
    ...(found.asyncAfter === true ? { asyncAfter: true } : {}),
    ...(found.exclusive === false ? { exclusive: false } : {}),
    ...(found.jobPriority === undefined
      ? {}
      : { jobPriority: found.jobPriority }),
    ...(found.retryCycle === undefined ? {} : { retryCycle: found.retryCycle }),
    ...(found.executionListeners === undefined
      ? {}
      : { executionListeners: found.executionListeners }),
  };
}

/** An `operaton:inputOutput` block: read on entry, written on exit. */
export interface IoMapped {
  inputParameters?: IoParameter[];
  outputParameters?: IoParameter[];
}

/** An empty direction is left out, so no `operaton:inputOutput` block is emitted. */
export function ioMapped(
  inputParameters: IoParameter[],
  outputParameters: IoParameter[],
): IoMapped {
  return {
    ...(inputParameters.length > 0 ? { inputParameters } : {}),
    ...(outputParameters.length > 0 ? { outputParameters } : {}),
  };
}

/**
 * How many times an activity runs, and what each run sees. At least one of
 * `cardinality` and `collection` is present: with both, the count drives the
 * runs while each run still sees its element.
 */
export interface LoopCharacteristics {
  /** A literal count, or an expression that yields one. */
  cardinality?: string;
  /** A variable name, or an expression when it carries `${`. */
  collection?: string;
  /** The name each run sees its own element under. */
  elementVariable?: string;
  /** The remaining runs are dropped once this holds. */
  completionCondition?: string;
  /**
   * Serialized as `isSequential`. Absent means the runs happen at once, which
   * is the engine default.
   */
  sequential?: true;
}

/** Every activity may repeat; no event and no gateway may. */
export interface Repeatable {
  loop?: LoopCharacteristics;
}

/**
 * The invariant above, as a check both write-out directions read, so neither
 * can decide on its own what a loop with nothing to repeat over means.
 */
export function repeats(
  loop: LoopCharacteristics | undefined,
): loop is LoopCharacteristics {
  return loop?.cardinality !== undefined || loop?.collection !== undefined;
}

export type SettingsCarrier = EngineAttributes &
  IoMapped & { taskListeners?: TaskListener[] };

/** One `operaton:inputParameter` or `operaton:outputParameter`. */
export interface IoParameter {
  name: string;
  value: IoValue;
}

/**
 * The four forms Operaton's `operaton:inputOutput` schema allows. Tagging on
 * `kind` makes a value carrying two of them unrepresentable, which is the shape
 * {@link UnsupportedExtensionFormError} refuses on import.
 */
export type IoValue =
  | {
      kind: 'text';
      /** Verbatim body text of the parameter, `operaton:entry`, or `operaton:value`. */
      text: string;
    }
  | ScriptValue
  | {
      kind: 'list';
      /** `operaton:list` children, in document order. */
      items: IoValue[];
    }
  | {
      kind: 'map';
      /** One `operaton:entry` per element, `key` its attribute. */
      entries: { key: string; value: IoValue }[];
    };

/** An inline `operaton:script`, in both positions it appears in. */
export type ScriptValue = {
  kind: 'script';
  format: string;
  code: string;
};

export type CodeBinding =
  | {
      kind: 'class';
      /** Fully qualified. */
      className: string;
    }
  | {
      kind: 'expression';
      /** Raw JUEL text. */
      expression: string;
    }
  | {
      kind: 'delegateExpression';
      /** Raw JUEL text. */
      expression: string;
    };

/** A listener adds the inline script a service task has no form for. */
export type ListenerBinding = CodeBinding | ScriptValue;

/** An `operaton:executionListener`, fired on entering or leaving execution. */
export interface ExecutionListener {
  event: (typeof EXECUTION_LISTENER_EVENTS)[number];
  binding: ListenerBinding;
}

/** An `operaton:taskListener`, fired at a point in the task's human lifecycle. */
export interface TaskListener {
  event: (typeof TASK_LISTENER_EVENTS)[number];
  binding: ListenerBinding;
  /** Required when `event` is `'timeout'`, absent otherwise. */
  timer?: Extract<EventDefinition, { kind: 'timer' }>;
}

export interface StartEvent extends EngineAttributes {
  kind: 'startEvent';
  id: string;
  name?: string;
  /** `operaton:formData` fields, so Tasklist renders a start form. */
  formFields?: FormField[];
  /** The trigger this start waits on, whether the process's or a handler's. */
  eventDefinition?: EventDefinition;
  /** Stored only for a non-interrupting (`alongside`) start; BPMN defaults to on. */
  isInterrupting?: false;
}

export interface EndEvent extends EngineAttributes {
  kind: 'endEvent';
  id: string;
  name?: string;
  /** Present when this end is a typed throw or a terminate. */
  eventDefinition?: EventDefinition;
  /**
   * What the engine runs to really send a thrown message; without it the throw
   * records and ends. Only a message definition carries one, and it serializes
   * onto that definition rather than onto the event.
   */
  binding?: ServiceTaskBinding;
}

/**
 * The DSL's `emit`: fires and lets flow continue. An error has no emittable
 * form, since raising one always ends its path. `emit` has no label slot.
 */
export interface IntermediateThrowEvent extends EngineAttributes {
  kind: 'intermediateThrowEvent';
  id: string;
  eventDefinition: EventDefinition;
  /** The implementation {@link EndEvent.binding} describes, on the emitting side. */
  binding?: ServiceTaskBinding;
}

/**
 * The DSL's `await`: the token pauses until the trigger fires. Error,
 * escalation, and compensation are raised with `throw`/`emit` and never caught
 * inline, hence the narrowing. `await` has no label slot, so the id is always
 * synthesized.
 */
export interface IntermediateCatchEvent extends EngineAttributes {
  kind: 'intermediateCatchEvent';
  id: string;
  eventDefinition: Extract<
    EventDefinition,
    { kind: 'message' | 'signal' | 'timer' | 'conditional' }
  >;
}

export interface UserTask extends EngineAttributes, IoMapped, Repeatable {
  kind: 'userTask';
  id: string;
  name?: string;
  assignee?: string;
  formKey?: string;
  /** `operaton:formData` fields Tasklist renders. */
  formFields?: FormField[];
  /** Verbatim: comma-separated text or EL. */
  candidateGroups?: string;
  /** Verbatim: comma-separated text or EL. */
  candidateUsers?: string;
  /** Verbatim: ISO-8601 or EL. */
  dueDate?: string;
  /** Verbatim: ISO-8601 or EL. */
  followUpDate?: string;
  /** Verbatim: an integer or EL. */
  priority?: string;
  /** In emission order. */
  taskListeners?: TaskListener[];
}

export type DecisionResultMapping = (typeof DECISION_RESULT_MAPPINGS)[number];

/**
 * A service task adds the external topic a listener has no form for, and a
 * business rule task the deployed decision it evaluates.
 */
export type ServiceTaskBinding =
  | CodeBinding
  | {
      kind: 'external';
      /** Paired with `operaton:type="external"`. */
      topic: string;
    }
  | {
      kind: 'decision';
      /** The deployed decision's key. */
      decisionRef: string;
      /** `operaton:decisionRefBinding` and `operaton:decisionRefVersion`. */
      binding?: VersionBinding;
      /** What `resultVariable` ends up holding. */
      mapDecisionResult?: DecisionResultMapping;
    };

export interface ServiceTask extends EngineAttributes, IoMapped, Repeatable {
  kind: 'serviceTask';
  id: string;
  name?: string;
  binding: ServiceTaskBinding;
  /** Filled with the binding's return value. */
  resultVariable?: string;
  /**
   * Which tag this serializes to; absent is a service task. Operaton runs all
   * three through `parseServiceTaskLike` when the tag carries a class,
   * expression, delegate expression, or external topic binding, so they share
   * this node. A business rule task naming an `operaton:decisionRef` goes to
   * `parseDmnBusinessRuleTask` instead, and that binding is legal on that tag
   * alone.
   */
  element?: 'send' | 'businessRule';
}

export interface ScriptTask extends EngineAttributes, IoMapped, Repeatable {
  kind: 'scriptTask';
  id: string;
  name?: string;
  /** Canonical Operaton `scriptFormat`, e.g. `"javascript"`, `"groovy"`. */
  format: string;
  /** The `<bpmn:script>` body, verbatim. */
  code: string;
  /** Filled with the script's result. */
  resultVariable?: string;
}

/** A step the engine records and leaves at once; the work happens outside it. */
export interface Task extends EngineAttributes, IoMapped, Repeatable {
  kind: 'task';
  id: string;
  name?: string;
}

/**
 * A wait state. With no `messageName` the engine continues it through its own
 * API rather than a correlation.
 */
export interface ReceiveTask extends EngineAttributes, IoMapped, Repeatable {
  kind: 'receiveTask';
  id: string;
  name?: string;
  /** `messageRef`, and the dedupe key: one name, one root element. */
  messageName?: string;
}

/** Carries no {@link EngineAttributes}, for the reason that interface gives. */
export interface ExclusiveGateway {
  kind: 'exclusiveGateway';
  id: string;
  name?: string;
  /** The BPMN `default` attribute: the flow taken when no condition matches. */
  defaultFlowId?: string;
}

/**
 * Fork and join both. Every outgoing flow is taken, so there are no conditions
 * and no default. Carries no {@link EngineAttributes} either.
 */
export interface ParallelGateway {
  kind: 'parallelGateway';
  id: string;
  name?: string;
}

/**
 * A fork that takes every branch whose condition holds, and the merge that
 * waits for exactly those. Carries no {@link EngineAttributes} either.
 */
export interface InclusiveGateway {
  kind: 'inclusiveGateway';
  id: string;
  name?: string;
  /** The BPMN `default` attribute: the flow taken when no condition matches. */
  defaultFlowId?: string;
}

/**
 * A fork whose branches each begin with a wait; the first to resolve cancels
 * the rest. Every outgoing flow is unconditioned, so there is no default.
 */
export interface EventBasedGateway {
  kind: 'eventBasedGateway';
  id: string;
  name?: string;
}

/**
 * Routing rather than work: a fork, a merge or a loop head, never a step.
 *
 * Membership is the `Gateway` suffix on the kind, the only discriminator every
 * BPMN gateway spelling shares. A kind spelled without it would drop out of
 * this alias, out of the map below, and out of every site reading either, all
 * at once and without a compile error.
 */
export type Gateway = Extract<FlowElement, { kind: `${string}Gateway` }>;

/**
 * Every kind {@link Gateway} admits, so a new one stops the build here rather
 * than slipping past a site that spells the kinds by hand.
 */
const GATEWAY_KINDS: Record<Gateway['kind'], true> = {
  exclusiveGateway: true,
  parallelGateway: true,
  inclusiveGateway: true,
  eventBasedGateway: true,
};

export function isGateway(el: FlowElement): el is Gateway {
  return el.kind in GATEWAY_KINDS;
}

/**
 * The flow a gateway takes when no condition matches, and `undefined` for a
 * kind that has no such flow. Every kind answers, so a gateway that gains a
 * default cannot lose it on the way out.
 */
export function gatewayDefaultFlowId(gateway: Gateway): string | undefined {
  switch (gateway.kind) {
    case 'exclusiveGateway':
    case 'inclusiveGateway':
      return gateway.defaultFlowId;
    case 'parallelGateway':
    case 'eventBasedGateway':
      return undefined;
    default: {
      const exhaustive: never = gateway;
      throw new Error(`Unhandled gateway kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** An activity that is itself a container; the parent wires flow to it by `id`. */
export interface SubProcess
  extends FlowContainer, EngineAttributes, IoMapped, Repeatable {
  kind: 'subProcess';
  name?: string;
  /** The event sub-process an `on` lowers to, fired by its start event's trigger. */
  triggeredByEvent?: true;
  /**
   * Which tag this serializes to; absent is an embedded sub-process. Operaton
   * runs a transaction through the very behavior class it gives an ordinary
   * sub-process, so nothing about the block is atomic and nothing rolls back;
   * what the tag buys is that the engine then accepts a cancel end inside the
   * block and a cancel boundary on it.
   */
  element?: 'transaction';
}

/** Which deployed version a call activity or a decision task resolves to. */
export type VersionBinding =
  | { kind: 'latest' }
  | { kind: 'deployment' }
  | { kind: 'version'; version: string };

/**
 * `target` always names the receiving side: the variable created in the callee
 * for an in-mapping, back in the caller for an out-mapping. `local` restricts
 * the mapping to the activity's local scope and is only ever `true`.
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
 * A leaf, not a {@link FlowContainer}: the callee's body lives in its own
 * definition. Extension children serialize in one order so the round trip is
 * stable: `businessKey`, then `inMappings`, then `outMappings`.
 */
export interface CallActivity extends EngineAttributes, IoMapped, Repeatable {
  kind: 'callActivity';
  id: string;
  name?: string;
  /** The id of the invoked process. */
  calledElement: string;
  /** Absent means the engine default, latest. */
  binding?: VersionBinding;
  /** `operaton:in businessKey`, propagated to the callee. */
  businessKey?: string;
  inMappings?: CallVariableMapping[];
  outMappings?: CallVariableMapping[];
}

/**
 * The only flow element with outgoing flow but no incoming: a token appears
 * here when the host is running and the trigger fires, so `cfg-analysis.ts`
 * wires it to the container's virtual entry.
 */
export interface BoundaryEvent extends EngineAttributes {
  kind: 'boundaryEvent';
  id: string;
  /** Host activity, which BPMN requires to be in this same container. */
  attachedToRef: string;
  /** Never compensation, which BPMN attaches through a `bpmn:association`. */
  eventDefinition: EventDefinition;
  /** Non-interrupting (`alongside`) only. Never with an `error` definition. */
  cancelActivity?: false;
}

export interface SequenceFlow {
  id: string;
  /** Ids rather than object references keep the IR serializable and acyclic. */
  sourceRef: string;
  targetRef: string;
  /** The `<bpmn:formalExpression>` body, e.g. `"${amount > 1000}"`. */
  conditionExpression?: string;
}
