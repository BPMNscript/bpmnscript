/**
 * The graph shared by all four transforms. Field names carry no vendor
 * prefix; the IR -> XML transform applies `operaton:`.
 */

import type {
  BuiltinTaskType,
  CallBindingValue,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EngineKey,
  EXECUTION_LISTENER_EVENTS,
  FORM_CONSTRAINT_NAMES,
  FORM_FIELD_TYPES,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TimerJobKey,
  TimerKind,
} from '@bpmn-script/language';
import { TIMER_JOB_KEYS } from '@bpmn-script/language';

/** Sequence flows never cross a container boundary. */
export interface FlowContainer {
  /** Unique across the whole definitions document, as an XML ID must be. */
  id: string;
  flowElements: FlowElement[];
  sequenceFlows: SequenceFlow[];
}

export interface BpmnProcess extends FlowContainer, Named {
  /** Operaton runs only executable processes. */
  isExecutable: true;
  /** Distinct from the engine's deployment version. */
  versionTag?: string;
  /** Absent means the exporter's default; see `HISTORY_TIME_TO_LIVE`. */
  historyTimeToLive?: string;
  /**
   * Comma-separated; stored as written and not checked when an instance starts.
   */
  candidateStarterUsers?: string;
  candidateStarterGroups?: string;
  /** `operaton:isStartableInTasklist`; absent means the engine's default, `true`. */
  isStartableInTasklist?: boolean;
  /**
   * Codes in use in first-use order, then unused declared ones. Stored, not
   * derived, because a declared code emits its root even when unused and usage
   * cannot recover the message. `name` is the identifier a use site refers to.
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

function* eachElement(container: FlowContainer): Generator<FlowElement> {
  for (const el of container.flowElements) {
    yield el;
    if (el.kind === 'subProcess') yield* eachElement(el);
  }
}

/**
 * Every position counts, so a message caught by an `await` and by a handler
 * share a root.
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
        if (el.messageName !== undefined) {
          defs.push({ kind: 'message', messageName: el.messageName });
        }
        break;
      case 'serviceTask':
        // The engine raises an external task's mapped code like a throw
        // (`ExternalTaskEntity.evaluateThrowBpmnError`).
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

interface EventIdentities {
  errorCodes: Set<string>;
  escalationCodes: Set<string>;
  messageNames: Set<string>;
  signalNames: Set<string>;
}

/**
 * Read by both XML directions, so the roots one synthesizes are exactly the
 * roots the other counts as referenced. A catch-all contributes none.
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
        break;
    }
  }
  return identities;
}

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormConstraintName = (typeof FORM_CONSTRAINT_NAMES)[number];

/** `label` is the `operaton:value`'s `name` attribute. */
export interface FormFieldValue {
  id: string;
  label?: string;
}

/**
 * `config` is absent on `required`/`readonly` (their validators never read
 * it), a bound on the numeric/length names, and a class or `${...}` on
 * `validator`.
 */
export interface FormFieldConstraint {
  name: FormConstraintName;
  config?: string;
}

/**
 * `key` is written as `id` on a form field and as `name` on an external task.
 */
export interface ExtensionProperty {
  key: string;
  value: string;
}

/**
 * List fields keep document order (constraints validate in it) and are absent
 * rather than empty.
 */
export interface FormField {
  /** Also the process variable the field binds. */
  id: string;
  type: FormFieldType;
  label?: string;
  defaultValue?: string;
  /** Read by the engine on a `date` field only. */
  datePattern?: string;
  values?: FormFieldValue[];
  constraints?: FormFieldConstraint[];
  properties?: ExtensionProperty[];
}

/**
 * Mirrors what BPMN can represent; the validator and importer enforce that
 * bindings appear only on a catch and that a throw has a non-empty code.
 */
export type EventDefinition =
  | {
      kind: 'error';
      /** Absent on a catch means catch-all. */
      errorCode?: string;
      codeVariable?: string;
      messageVariable?: string;
    }
  | {
      kind: 'escalation';
      /** Absent on a catch means catch-all. */
      escalationCode?: string;
      /** BPMN has no escalation message, hence no message variable. */
      codeVariable?: string;
    }
  | {
      /**
       * No `activityRef`, so a throw compensates its whole scope.
       * `waitForCompletion` is unmodeled: moddle defaults it to `true` and the
       * engine warns on any other value.
       */
      kind: 'compensation';
    }
  | {
      kind: 'terminate';
    }
  | {
      kind: 'cancel';
    }
  | {
      kind: 'message';
      /** Also the dedupe key: one name, one root element. */
      messageName: string;
    }
  | {
      kind: 'signal';
      signalName: string;
    }
  | {
      kind: 'timer';
      timerKind: TimerKind;
      /** ISO-8601 or EL, verbatim. */
      expression: string;
    }
  | {
      kind: 'conditional';
      /** Raw `${...}` body. */
      condition: string;
    }
  | {
      kind: 'link';
      /**
       * The engine pairs throw and catch by name; the IR holds no reference
       * between them.
       */
      linkName: string;
    };

export type CatchEventDefinition = Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' | 'link' }
>;

/**
 * Link, timer, and conditional stay out: BPMN gives none of them an end form.
 */
export type EndEventDefinition = Extract<
  EventDefinition,
  { kind: (typeof THROW_TRIGGERS | typeof END_TRIGGERS)[number] }
>;

export type EmitEventDefinition = Extract<
  EventDefinition,
  { kind: (typeof EMIT_TRIGGERS)[number] }
>;

/** The three intermediate events have no label slot and hold neither. */
export interface Named {
  name?: string;
  documentation?: string;
}

/**
 * Stored only in the non-default direction, so defaults reproduce by omission.
 */
export type JobSettings = { [K in EngineKey]?: StoredJobSetting[K] };

interface StoredJobSetting {
  asyncBefore: true;
  asyncAfter: true;
  exclusive: false;
  /** An integer or EL, verbatim. */
  jobPriority: string;
  /** The `operaton:failedJobRetryTimeCycle` body, verbatim. */
  retryCycle: string;
}

type FoundJobSettings = {
  [K in EngineKey]:
    | (StoredJobSetting[K] extends boolean ? boolean : StoredJobSetting[K])
    | undefined;
};

export function jobSettings(found: FoundJobSettings): JobSettings {
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
 * A timer element creates two jobs: the {@link TIMER_JOB_KEYS} configure the
 * timer job, the async flags create the continuation job and stay with it.
 */
export function splitTimerJobSettings<T extends JobSettings>(
  settings: T,
): { timer: JobSettings; continuation: Omit<T, TimerJobKey> } {
  const continuation = { ...settings } as Omit<T, TimerJobKey>;
  for (const key of TIMER_JOB_KEYS) delete (continuation as JobSettings)[key];
  return {
    timer: jobSettings({
      asyncBefore: undefined,
      asyncAfter: undefined,
      exclusive: settings.exclusive,
      jobPriority: settings.jobPriority,
      retryCycle: settings.retryCycle,
    }),
    continuation,
  };
}

/**
 * Gateways extend `JobSettings` directly and take no listeners: a synthesized
 * gateway has no textual identity to author one against.
 */
export interface EngineAttributes extends JobSettings {
  executionListeners?: ExecutionListener[];
}

export interface IoMapped {
  inputParameters?: IoParameter[];
  outputParameters?: IoParameter[];
}

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
 * At least one of `cardinality` and `collection` is present; with both, the
 * count drives the runs. No `jobPriority`: the activity's own already prices
 * each run's job.
 */
export interface LoopCharacteristics extends Omit<JobSettings, 'jobPriority'> {
  cardinality?: string;
  /** A variable name, or an expression when it carries `${`. */
  collection?: string;
  elementVariable?: string;
  completionCondition?: string;
  /**
   * Serialized as `isSequential`; absent means parallel, the engine default.
   */
  sequential?: true;
}

export interface Repeatable {
  loop?: LoopCharacteristics;
}

export interface Activity extends Repeatable {
  /**
   * BPMN `default` on a step: the engine takes it when no other outgoing
   * condition held, as on a gateway.
   */
  defaultFlowId?: string;
}

/**
 * Shared by both write-out directions so they agree on a loop with nothing to
 * repeat over.
 */
export function repeats(
  loop: LoopCharacteristics | undefined,
): loop is LoopCharacteristics {
  return loop?.cardinality !== undefined || loop?.collection !== undefined;
}

export type SettingsCarrier = EngineAttributes &
  IoMapped & { taskListeners?: TaskListener[] };

export interface IoParameter {
  name: string;
  value: IoValue;
}

/**
 * Tagged so a value carrying two forms is unrepresentable; import refuses one.
 */
export type IoValue =
  | {
      kind: 'text';
      text: string;
    }
  | ScriptValue
  | {
      kind: 'list';
      items: IoValue[];
    }
  | {
      kind: 'map';
      entries: { key: string; value: IoValue }[];
    };

export type ScriptValue = {
  kind: 'script';
  format: string;
  code: string;
};

/**
 * A `value` opening with `${` is written as an `operaton:expression` child,
 * anything else as a `stringValue` attribute.
 */
export interface FieldInjection {
  name: string;
  value: string;
}

/**
 * `fields` exists only on the kinds whose behaviours Operaton injects fields
 * into.
 */
export type CodeBinding =
  | {
      kind: 'class';
      className: string;
      fields?: FieldInjection[];
    }
  | {
      kind: 'expression';
      expression: string;
    }
  | {
      kind: 'delegateExpression';
      expression: string;
      fields?: FieldInjection[];
    };

export type ListenerBinding = CodeBinding | ScriptValue;

export interface ExecutionListener {
  event: (typeof EXECUTION_LISTENER_EVENTS)[number];
  binding: ListenerBinding;
}

export interface TaskListener {
  event: (typeof TASK_LISTENER_EVENTS)[number];
  binding: ListenerBinding;
  /** Required when `event` is `'timeout'`, absent otherwise. */
  timer?: Extract<EventDefinition, { kind: 'timer' }>;
}

export interface StartEvent extends EngineAttributes, Named {
  kind: 'startEvent';
  id: string;
  formFields?: FormField[];
  eventDefinition?: EventDefinition;
  /** The variable the engine writes the starting user's id into. */
  initiator?: string;
  /**
   * Stored only for a non-interrupting start; BPMN defaults to interrupting.
   */
  isInterrupting?: false;
}

export interface EndEvent extends EngineAttributes, Named {
  kind: 'endEvent';
  id: string;
  eventDefinition?: EndEventDefinition;
  /**
   * What actually sends a thrown message; without it the throw only records.
   * Serializes onto the message definition, not the event.
   */
  binding?: ServiceTaskBinding;
}

/** An error has no emit form: raising one always ends its path. */
export interface IntermediateThrowEvent extends EngineAttributes {
  kind: 'intermediateThrowEvent';
  id: string;
  eventDefinition: EmitEventDefinition;
  binding?: ServiceTaskBinding;
}

export interface IntermediateCatchEvent extends EngineAttributes {
  kind: 'intermediateCatchEvent';
  id: string;
  eventDefinition: CatchEventDefinition;
}

export interface UserTask extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'userTask';
  id: string;
  assignee?: string;
  formKey?: string;
  /** Operaton refuses to deploy a form reference without a binding. */
  formRef?: { key: string; binding: VersionBinding };
  formFields?: FormField[];
  candidateGroups?: string;
  candidateUsers?: string;
  dueDate?: string;
  followUpDate?: string;
  priority?: string;
  taskListeners?: TaskListener[];
}

type DecisionResultMapping = (typeof DECISION_RESULT_MAPPINGS)[number];

export interface ErrorMapping {
  /** Resolved to a declaration name on print. */
  errorCode: string;
  /** Raw JUEL, evaluated on failure and on completion. */
  condition: string;
}

export type ServiceTaskBinding =
  | CodeBinding
  | {
      kind: 'external';
      topic: string;
      /** `operaton:taskPriority`, the worker's fetch order. */
      taskPriority?: string;
      /** Both lists keep document order and are absent rather than empty. */
      properties?: ExtensionProperty[];
      errorMappings?: ErrorMapping[];
    }
  | {
      kind: 'decision';
      decisionRef: string;
      binding?: VersionBinding;
      mapDecisionResult?: DecisionResultMapping;
    }
  | {
      kind: 'builtin';
      type: BuiltinTaskType;
      fields?: FieldInjection[];
    };

/** The IR side of `FIELD_BINDING_KEYS` in the language package. */
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
  extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'serviceTask';
  id: string;
  binding: ServiceTaskBinding;
  resultVariable?: string;
  /**
   * Absent is a service task. Operaton parses all three via
   * `parseServiceTaskLike`, except a business rule task with a decision
   * binding, which only that tag may carry.
   */
  element?: 'send' | 'businessRule';
}

export interface ScriptTask
  extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'scriptTask';
  id: string;
  /** Canonical Operaton `scriptFormat`. */
  format: string;
  code: string;
  resultVariable?: string;
}

export interface Task extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'task';
  id: string;
}

/**
 * Without `messageName` the engine continues it through its API, not
 * correlation.
 */
export interface ReceiveTask
  extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'receiveTask';
  id: string;
  messageName?: string;
}

export interface ExclusiveGateway extends JobSettings, Named {
  kind: 'exclusiveGateway';
  id: string;
  defaultFlowId?: string;
}

export interface ParallelGateway extends JobSettings, Named {
  kind: 'parallelGateway';
  id: string;
}

export interface InclusiveGateway extends JobSettings, Named {
  kind: 'inclusiveGateway';
  id: string;
  defaultFlowId?: string;
}

export interface EventBasedGateway extends JobSettings, Named {
  kind: 'eventBasedGateway';
  id: string;
}

/**
 * Membership is the `Gateway` kind suffix; a kind spelled without it drops out
 * without a compile error.
 */
export type Gateway = Extract<FlowElement, { kind: `${string}Gateway` }>;

/** A `Record`, so a new gateway kind breaks the build here. */
const GATEWAY_KINDS: Record<Gateway['kind'], true> = {
  exclusiveGateway: true,
  parallelGateway: true,
  inclusiveGateway: true,
  eventBasedGateway: true,
};

export function isGateway(el: FlowElement): el is Gateway {
  return el.kind in GATEWAY_KINDS;
}

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

export interface SubProcess
  extends FlowContainer, EngineAttributes, IoMapped, Activity, Named {
  kind: 'subProcess';
  /** Set on the event sub-process an `on` lowers to. */
  triggeredByEvent?: true;
  /**
   * Absent is an embedded sub-process. Operaton runs a transaction like a
   * plain sub-process (nothing atomic, no rollback); the tag only makes the
   * engine accept a cancel end inside and a cancel boundary on it.
   */
  element?: 'transaction';
}

export type VersionBinding =
  { kind: CallBindingValue } | { kind: 'version'; version: string };

/**
 * `target` is the receiving side: the callee for an in-mapping, the caller for
 * an out-mapping.
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
 * Runs after the declared `in`/`out` mappings, not instead of them. Not a
 * {@link CodeBinding}: no expression form and no field injection.
 */
export type CallVariableMapper =
  | { kind: 'class'; className: string }
  | { kind: 'delegateExpression'; expression: string };

/**
 * Extension children serialize as `businessKey`, `inMappings`, `outMappings` so
 * the round trip is stable.
 */
export interface CallActivity
  extends EngineAttributes, IoMapped, Activity, Named {
  kind: 'callActivity';
  id: string;
  calledElement: string;
  /** Absent means the engine default, latest. */
  binding?: VersionBinding;
  businessKey?: string;
  mapper?: CallVariableMapper;
  inMappings?: CallVariableMapping[];
  outMappings?: CallVariableMapping[];
}

/**
 * Outgoing flow but no incoming, so `cfg-analysis.ts` wires it to the
 * container's virtual entry.
 */
export interface BoundaryEvent extends EngineAttributes {
  kind: 'boundaryEvent';
  id: string;
  /** BPMN requires the host in this same container. */
  attachedToRef: string;
  /** Never compensation, which BPMN attaches through a `bpmn:association`. */
  eventDefinition: EventDefinition;
  /** Stored only when non-interrupting; never with an `error` definition. */
  cancelActivity?: false;
}

export interface SequenceFlow {
  id: string;
  sourceRef: string;
  targetRef: string;
  /** Includes the wrapper, e.g. `"${amount > 1000}"`. */
  conditionExpression?: string;
}
