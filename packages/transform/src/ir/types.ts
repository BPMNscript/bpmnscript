/**
 * Intermediate Representation for BPMNscript: a statically typed graph of flow
 * elements and sequence flows, shared by all four transforms. Field names carry
 * no vendor prefix; the IR -> XML transform applies `operaton:` and anything
 * that varies only at serialization.
 *
 * See ADR 0006, Use an Intermediate Representation between the AST and BPMN XML.
 */

import type {
  BuiltinTaskType,
  DECISION_RESULT_MAPPINGS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  FORM_CONSTRAINT_NAMES,
  FORM_FIELD_TYPES,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
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

export interface BpmnProcess extends FlowContainer, Named {
  /** Always `true`; Operaton runs only executable processes. */
  isExecutable: true;
  /** Distinct from the engine's deployment version. */
  versionTag?: string;
  /** Absent means the exporter's default; see `HISTORY_TIME_TO_LIVE`. */
  historyTimeToLive?: string;
  /** Comma-separated user ids the engine checks before it will start the process. */
  candidateStarterUsers?: string;
  /** Comma-separated group ids the engine checks before it will start the process. */
  candidateStarterGroups?: string;
  /**
   * Every error code the process raises, catches, or declares, in canonical
   * order: codes something uses in first-use order, then the rest in
   * declaration order. Stored rather than derived from usage because two throws
   * of one code share a root element, a declared code emits its root even when
   * unused, and the message text usage alone cannot recover. `name` is the
   * identifier a use site refers to, which is the code itself unless the code
   * cannot be spelled as one. See ADR 0016, Derive Event Root Elements From
   * Usage.
   */
  errorDecls?: { name: string; code: string; message?: string }[];
  /** As {@link BpmnProcess.errorDecls}; BPMN gives an escalation no message. */
  escalationDecls?: { name: string; code: string }[];
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
      case 'serviceTask':
        // An external task's failure mapping raises its code the way a throw
        // does, so its root is derived the same way even with no throw or
        // declaration of its own (`ExternalTaskEntity.evaluateThrowBpmnError`).
        if (el.binding.kind === 'external' && el.binding.errorMappings) {
          for (const mapping of el.binding.errorMappings) {
            defs.push({ kind: 'error', errorCode: mapping.errorCode });
          }
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
        // Compensation, timer, conditional, and link need no document-level
        // element.
        break;
    }
  }
  return identities;
}

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormConstraintName = (typeof FORM_CONSTRAINT_NAMES)[number];

/** One `operaton:value` of an `enum` field; `label` is its `name` attribute. */
export interface FormFieldValue {
  id: string;
  label?: string;
}

/**
 * One `operaton:constraint`. `config` is absent on `required`/`readonly`
 * (`RequiredValidator.validate` and `ReadOnlyValidator.validate` never read
 * it), the parsed text of a bound on the four numeric/length names, and the
 * class name or `${...}` expression `validator` names.
 */
export interface FormFieldConstraint {
  name: FormConstraintName;
  config?: string;
}

/** One `operaton:property`; `key` is written as `id` on a form field and as `name` on an external task, the attribute each engine reader keys on. */
export interface ExtensionProperty {
  key: string;
  value: string;
}

/** An `<operaton:formField>` inside the owning element's `<operaton:formData>`. */
export interface FormField {
  /** Also the process variable the field binds. */
  id: string;
  type: FormFieldType;
  label?: string;
  /** Carried as text whatever the field's type. */
  defaultValue?: string;
  /** `datePattern`, read by `FormTypes.parseFormPropertyType` on a `date` field alone. */
  datePattern?: string;
  /** Document order, which the engine keeps; absent rather than empty. */
  values?: FormFieldValue[];
  /** Document order, which the engine validates in; absent rather than empty. */
  constraints?: FormFieldConstraint[];
  /** Document order; absent rather than empty. */
  properties?: ExtensionProperty[];
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
    }
  | {
      kind: 'link';
      /**
       * What a throw and a catch match on: the engine keys one table of these
       * per deployed file and rewires every throw of a name to the catch of
       * the same name, so the IR carries no reference between the two nodes.
       */
      linkName: string;
    };

/** The definitions an `await` may catch; narrower than what a `throw`/`emit` may raise. */
export type CatchEventDefinition = Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' | 'link' }
>;

/**
 * The definitions an end may carry: what a `throw` raises plus the two an
 * `end` statement spells itself. Link, timer, and conditional stay out, since
 * BPMN gives none of them an end form.
 */
export type EndEventDefinition = Extract<
  EventDefinition,
  { kind: (typeof THROW_TRIGGERS | typeof END_TRIGGERS)[number] }
>;

/**
 * The human-facing text a BPMN element carries, mixed into every kind the
 * surface gives a name, so a kind that carries one carries the other. The
 * three intermediate events have no label slot and therefore hold neither.
 */
export interface Named {
  name?: string;
  documentation?: string;
}

/**
 * The five Operaton job-execution settings, mixed into every event and
 * activity kind and, authored on the statement head, into the four gateway
 * kinds directly. Each field is stored only in the non-default direction, so
 * `asyncBefore="false"` and `exclusive="true"` reproduce by omission. See
 * ADR 0022, Carry Operaton Engine Attributes as Named IR Fields, and ADR
 * 0040, Engine Settings on Synthesized Gateways.
 */
export interface JobSettings {
  asyncBefore?: true;
  asyncAfter?: true;
  exclusive?: false;
  /** An integer or EL, verbatim. */
  jobPriority?: string;
  /** The `operaton:failedJobRetryTimeCycle` element body, verbatim. */
  retryCycle?: string;
}

export function jobSettings(found: {
  asyncBefore: boolean | undefined;
  asyncAfter: boolean | undefined;
  exclusive: boolean | undefined;
  jobPriority: string | undefined;
  retryCycle: string | undefined;
}): JobSettings {
  return {
    ...(found.asyncBefore === true ? { asyncBefore: true } : {}),
    ...(found.asyncAfter === true ? { asyncAfter: true } : {}),
    ...(found.exclusive === false ? { exclusive: false } : {}),
    ...(found.jobPriority === undefined
      ? {}
      : { jobPriority: found.jobPriority }),
    ...(found.retryCycle === undefined ? {} : { retryCycle: found.retryCycle }),
  };
}

/**
 * {@link JobSettings} plus execution listeners. Mixed into every event and
 * activity kind; the four gateway kinds extend `JobSettings` directly and
 * take no listeners, since a listener needs the textual identity a
 * synthesized gateway has none of (ADR 0010) to author one against.
 */
export interface EngineAttributes extends JobSettings {
  /** In emission order. */
  executionListeners?: ExecutionListener[];
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
 * runs while each run still sees its element. The job settings are the ones
 * the engine reads off this element onto each run, `RUN_ENGINE_KEYS` in the
 * language package, which is why there is no `jobPriority`.
 */
export interface LoopCharacteristics extends Omit<JobSettings, 'jobPriority'> {
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

/**
 * One `operaton:field`, set on the bean its binding instantiates. `value`
 * carries both of the XML value slots as one text: a body opening with `${` is
 * the expression form, evaluated per instantiation and written as an
 * `operaton:expression` child, and anything else is the literal form, injected
 * verbatim and written as a `stringValue` attribute. That is the same reading
 * of a leading `${` that `renderIoValue` does on the way out.
 */
export interface FieldInjection {
  name: string;
  value: string;
}

/**
 * The field list sits on the two members whose behaviours Operaton builds one
 * for rather than on the element, so a binding that receives none has no slot
 * to hold one instead of a rule against holding one.
 */
export type CodeBinding =
  | {
      kind: 'class';
      /** Fully qualified. */
      className: string;
      /** In emission order. */
      fields?: FieldInjection[];
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
      /** In emission order. */
      fields?: FieldInjection[];
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

export interface StartEvent extends EngineAttributes, Named {
  kind: 'startEvent';
  id: string;
  /** `operaton:formData` fields, so Tasklist renders a start form. */
  formFields?: FormField[];
  /** The trigger this start waits on, whether the process's or a handler's. */
  eventDefinition?: EventDefinition;
  /** The process variable the engine writes the starting user's id into. */
  initiator?: string;
  /** Stored only for a non-interrupting (`alongside`) start; BPMN defaults to on. */
  isInterrupting?: false;
}

export interface EndEvent extends EngineAttributes, Named {
  kind: 'endEvent';
  id: string;
  /** Present when this end is a typed throw or a terminate. */
  eventDefinition?: EndEventDefinition;
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
 * inline, hence the narrowing. `await` has no label slot; the id is
 * synthesized unless the `await` carries a name.
 */
export interface IntermediateCatchEvent extends EngineAttributes {
  kind: 'intermediateCatchEvent';
  id: string;
  eventDefinition: CatchEventDefinition;
}

export interface UserTask
  extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'userTask';
  id: string;
  assignee?: string;
  formKey?: string;
  /**
   * The deployed form the task renders, as `operaton:formRef` and the binding
   * pinning which version of it. Operaton refuses to deploy a form reference
   * carrying no binding, so the binding is required rather than optional.
   */
  formRef?: { key: string; binding: VersionBinding };
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

/** One `operaton:errorEventDefinition` on an external task: the failure condition and the code it raises. */
export interface ErrorMapping {
  /** The code the `errorRef` root carries; resolved to a declaration name on print. */
  errorCode: string;
  /** Raw JUEL, evaluated on the task's execution on failure and on completion (`ExternalTaskEntity.evaluateThrowBpmnError`). */
  condition: string;
}

/**
 * A service task adds the external topic and the built-in mail or shell
 * behaviour a listener has no form for, and a business rule task the deployed
 * decision it evaluates.
 */
export type ServiceTaskBinding =
  | CodeBinding
  | {
      kind: 'external';
      /** Paired with `operaton:type="external"`. */
      topic: string;
      /** Verbatim: an integer or EL; `operaton:taskPriority`, the worker's fetch order. */
      taskPriority?: string;
      /** Document order; absent rather than empty. */
      properties?: ExtensionProperty[];
      /** Document order, which the engine evaluates in; absent rather than empty. */
      errorMappings?: ErrorMapping[];
    }
  | {
      kind: 'decision';
      /** The deployed decision's key. */
      decisionRef: string;
      /** `operaton:decisionRefBinding` and `operaton:decisionRefVersion`. */
      binding?: VersionBinding;
      /** What `resultVariable` ends up holding. */
      mapDecisionResult?: DecisionResultMapping;
    }
  | {
      kind: 'builtin';
      /** Paired with `operaton:type="mail"`/`"shell"`. */
      type: BuiltinTaskType;
      fields?: FieldInjection[];
    };

/**
 * The bindings Operaton hands a field list to, `FIELD_BINDING_KEYS` in the
 * language package: a class and the two built-in behaviours through
 * `instantiateDelegate`, a delegate expression's bean on each invocation.
 */
export function carriesFields(
  binding: ServiceTaskBinding | ListenerBinding,
): binding is Extract<
  ServiceTaskBinding | ListenerBinding,
  { fields?: FieldInjection[] }
> {
  return (
    binding.kind === 'class' ||
    binding.kind === 'delegateExpression' ||
    binding.kind === 'builtin'
  );
}

export interface ServiceTask
  extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'serviceTask';
  id: string;
  binding: ServiceTaskBinding;
  /** Filled with the binding's return value. */
  resultVariable?: string;
  /**
   * Which tag this serializes to; absent is a service task. Operaton runs all
   * three through `parseServiceTaskLike` when the tag carries a class,
   * expression, delegate expression, external topic, or `mail`/`shell` type
   * binding, so they share this node. A business rule task naming an
   * `operaton:decisionRef` goes to `parseDmnBusinessRuleTask` instead, and
   * that binding is legal on that tag alone.
   */
  element?: 'send' | 'businessRule';
}

export interface ScriptTask
  extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'scriptTask';
  id: string;
  /** Canonical Operaton `scriptFormat`, e.g. `"javascript"`, `"groovy"`. */
  format: string;
  /** The `<bpmn:script>` body, verbatim. */
  code: string;
  /** Filled with the script's result. */
  resultVariable?: string;
}

/** A step the engine records and leaves at once; the work happens outside it. */
export interface Task extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'task';
  id: string;
}

/**
 * A wait state. With no `messageName` the engine continues it through its own
 * API rather than a correlation.
 */
export interface ReceiveTask
  extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'receiveTask';
  id: string;
  /** `messageRef`, and the dedupe key: one name, one root element. */
  messageName?: string;
}

/** Job settings but no listeners: see {@link EngineAttributes}. The other three kinds are the same. */
export interface ExclusiveGateway extends JobSettings, Named {
  kind: 'exclusiveGateway';
  id: string;
  /** The BPMN `default` attribute: the flow taken when no condition matches. */
  defaultFlowId?: string;
}

/**
 * Fork and join both. Every outgoing flow is taken, so there are no conditions
 * and no default.
 */
export interface ParallelGateway extends JobSettings, Named {
  kind: 'parallelGateway';
  id: string;
}

/**
 * A fork that takes every branch whose condition holds, and the merge that
 * waits for exactly those.
 */
export interface InclusiveGateway extends JobSettings, Named {
  kind: 'inclusiveGateway';
  id: string;
  /** The BPMN `default` attribute: the flow taken when no condition matches. */
  defaultFlowId?: string;
}

/**
 * A fork whose branches each begin with a wait; the first to resolve cancels
 * the rest. Every outgoing flow is unconditioned, so there is no default.
 */
export interface EventBasedGateway extends JobSettings, Named {
  kind: 'eventBasedGateway';
  id: string;
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
  extends FlowContainer, EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'subProcess';
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
 * Computes a call activity's variable mapping in code, running after the
 * declared `in`/`out` mappings on each side, so it adds to them rather than
 * replacing them. Not {@link CodeBinding}: the engine reads exactly two
 * attributes here, with no expression form, and `CodeBinding`'s `fields?`
 * slot exists only for the two behaviours Operaton injects into, which this
 * is not.
 */
export type CallVariableMapper =
  | { kind: 'class'; /** Fully qualified. */ className: string }
  | { kind: 'delegateExpression'; /** Raw JUEL text. */ expression: string };

/**
 * A leaf, not a {@link FlowContainer}: the callee's body lives in its own
 * definition. Extension children serialize in one order so the round trip is
 * stable: `businessKey`, then `inMappings`, then `outMappings`.
 */
export interface CallActivity
  extends EngineAttributes, IoMapped, Repeatable, Named {
  kind: 'callActivity';
  id: string;
  /** The id of the invoked process. */
  calledElement: string;
  /** Absent means the engine default, latest. */
  binding?: VersionBinding;
  /** `operaton:in businessKey`, propagated to the callee. */
  businessKey?: string;
  mapper?: CallVariableMapper;
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
