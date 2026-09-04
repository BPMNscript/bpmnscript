/**
 * Intermediate Representation for BPMNscript: a statically typed graph of flow
 * elements and sequence flows, shared by all four transforms. Field names carry
 * no vendor prefix; the IR -> XML transform applies `operaton:` and anything
 * that varies only at serialization. Each field below names what it maps to.
 *
 * See ADR 0006, Use an Intermediate Representation between the AST and BPMN XML.
 */

/**
 * Sequence flows never cross a container boundary, so a parent can treat a
 * nested container as one opaque activity node.
 */
export interface FlowContainer {
  /** BPMN `id`, unique across the whole definitions document. */
  id: string;
  flowElements: FlowElement[];
  sequenceFlows: SequenceFlow[];
}

export interface BpmnProcess extends FlowContainer {
  name?: string;
  /** Always `true`; Operaton runs only executable processes. */
  isExecutable: true;
  /** `operaton:versionTag`, distinct from the engine's deployment version. */
  versionTag?: string;
  /**
   * `operaton:errorMessage` on the synthesized `bpmn:Error`, in declaration
   * order. Stored rather than derived from usage because two throws of one code
   * share a root element, and a declared code emits its root even when unused.
   * See ADR 0016, Derive Event Root Elements From Usage.
   */
  errorMessages?: { code: string; message: string }[];
}

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
  | IntermediateThrowEvent
  | IntermediateCatchEvent
  | BoundaryEvent;

/** Vendor-neutral spelling; `number` becomes the Operaton `long` at export. */
export type FormFieldType = 'string' | 'number' | 'boolean' | 'date';

/** An `<operaton:formField>` inside the owning element's `<operaton:formData>`. */
export interface FormField {
  /** `operaton:formField id`, also the process variable the field binds. */
  id: string;
  type: FormFieldType;
  /** `operaton:formField label`. */
  label?: string;
  /** `operaton:formField defaultValue`, carried as text. */
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
  /** `operaton:asyncBefore`. */
  asyncBefore?: true;
  /** `operaton:asyncAfter`. */
  asyncAfter?: true;
  /** `operaton:exclusive`. */
  exclusive?: false;
  /** `operaton:jobPriority`, an integer or EL, verbatim. */
  jobPriority?: string;
  /** The `operaton:failedJobRetryTimeCycle` element body, verbatim. */
  retryCycle?: string;
  /** `operaton:executionListener` children, in emission order. */
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
  /** `operaton:script scriptFormat`. */
  format: string;
  /** The `operaton:script` body text. */
  code: string;
};

export type CodeBinding =
  | {
      kind: 'class';
      /** `operaton:class`, fully qualified. */
      className: string;
    }
  | {
      kind: 'expression';
      /** `operaton:expression`, raw JUEL text. */
      expression: string;
    }
  | {
      kind: 'delegateExpression';
      /** `operaton:delegateExpression`, raw JUEL text. */
      expression: string;
    };

/** A listener adds the inline script a service task has no form for. */
export type ListenerBinding = CodeBinding | ScriptValue;

/** An `operaton:executionListener`, fired on entering or leaving execution. */
export interface ExecutionListener {
  event: 'start' | 'end';
  binding: ListenerBinding;
}

/** An `operaton:taskListener`, fired at a point in the task's human lifecycle. */
export interface TaskListener {
  event: 'create' | 'assign' | 'complete' | 'update' | 'delete' | 'timeout';
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
  /** The caught trigger, when this start opens an event sub-process. */
  eventDefinition?: EventDefinition;
  /** Stored only for a non-interrupting (`alongside`) start; BPMN defaults to on. */
  isInterrupting?: false;
}

export interface EndEvent extends EngineAttributes {
  kind: 'endEvent';
  id: string;
  name?: string;
  /** Present when this end is a typed throw, which raises the code and ends the path. */
  eventDefinition?: EventDefinition;
}

/**
 * The DSL's `emit`: fires and lets flow continue. Only an escalation is
 * emittable, BPMN having no intermediate error throw. `emit` has no label slot.
 */
export interface IntermediateThrowEvent extends EngineAttributes {
  kind: 'intermediateThrowEvent';
  id: string;
  eventDefinition: EventDefinition;
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

export interface UserTask extends EngineAttributes, IoMapped {
  kind: 'userTask';
  id: string;
  name?: string;
  /** `operaton:assignee`. */
  assignee?: string;
  /** `operaton:formKey`. */
  formKey?: string;
  /** `operaton:formData` fields Tasklist renders. */
  formFields?: FormField[];
  /** `operaton:candidateGroups`, verbatim: comma-separated text or EL. */
  candidateGroups?: string;
  /** `operaton:candidateUsers`, verbatim. */
  candidateUsers?: string;
  /** `operaton:dueDate`, verbatim: ISO-8601 or EL. */
  dueDate?: string;
  /** `operaton:followUpDate`, verbatim: ISO-8601 or EL. */
  followUpDate?: string;
  /** `operaton:priority`, verbatim: an integer or EL. */
  priority?: string;
  /** `operaton:taskListener` children, in emission order. */
  taskListeners?: TaskListener[];
}

/** A service task adds the external topic a listener has no form for. */
export type ServiceTaskBinding =
  | CodeBinding
  | {
      kind: 'external';
      /** `operaton:topic`, paired with `operaton:type="external"`. */
      topic: string;
    };

export interface ServiceTask extends EngineAttributes, IoMapped {
  kind: 'serviceTask';
  id: string;
  name?: string;
  binding: ServiceTaskBinding;
  /** `operaton:resultVariable`, filled with the binding's return value. */
  resultVariable?: string;
}

export interface ScriptTask extends EngineAttributes, IoMapped {
  kind: 'scriptTask';
  id: string;
  name?: string;
  /** Canonical Operaton `scriptFormat`, e.g. `"javascript"`, `"groovy"`. */
  format: string;
  /** The `<bpmn:script>` body, verbatim. */
  code: string;
  /** `operaton:resultVariable`, filled with the script's result. */
  resultVariable?: string;
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

/** An activity that is itself a container; the parent wires flow to it by `id`. */
export interface SubProcess extends FlowContainer, EngineAttributes, IoMapped {
  kind: 'subProcess';
  name?: string;
  /** The event sub-process an `on` lowers to, fired by its start event's trigger. */
  triggeredByEvent?: true;
}

export type CalledElementBinding =
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
export interface CallActivity extends EngineAttributes, IoMapped {
  kind: 'callActivity';
  id: string;
  name?: string;
  /** `bpmn:calledElement`, the id of the invoked process. */
  calledElement: string;
  /** Absent means the engine default, latest. */
  binding?: CalledElementBinding;
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
