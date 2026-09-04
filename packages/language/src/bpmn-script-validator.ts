/** Validation checks for the BPMNscript AST. */

import {
  AstUtils,
  type AstNode,
  type ValidationAcceptor,
  type ValidationChecks,
} from 'langium';
import type {
  Additive,
  Attribute,
  Block,
  BpmnScriptAstType,
  BusinessRuleTask,
  CallActivity,
  DoWhileStatement,
  EmitStatement,
  EndEvent,
  ErrorDecl,
  Expr,
  FormBlock,
  GotoStatement,
  IfStatement,
  IntermediateCatchEvent,
  IoParameter,
  IoValue,
  Listener,
  Logical,
  Model,
  Multiplicative,
  OnHandler,
  ParallelStatement,
  Process,
  ProcessAttribute,
  Relational,
  ScriptTask,
  SendTask,
  ServiceTask,
  StartEvent,
  Statement,
  SubProcess,
  ThrowStatement,
  VarType,
  WhileStatement,
} from './generated/ast.js';
import {
  isAdditive,
  isAttribute,
  isBlock,
  isBusinessRuleTask,
  isCallActivity,
  isDoWhileStatement,
  isEndEvent,
  isErrorDecl,
  isExpr,
  isGenericTask,
  isGotoStatement,
  isIfStatement,
  isLiteralBool,
  isLiteralString,
  isLogical,
  isMapEntry,
  isMultiplicative,
  isOnHandler,
  isParallelStatement,
  isProcess,
  isProcessAttribute,
  isProcessLabel,
  isRawExpr,
  isReceiveTask,
  isRelational,
  isScriptTask,
  isSendTask,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isThrowStatement,
  isUserTask,
  isVarDecl,
  isVariableMapping,
  isVarRef,
  isWhileStatement,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import {
  ATTEMPT_BLOCK_RULE,
  ATTRIBUTE_BLOCK_RULES,
  attributeBlockRuleOf,
  BUSINESS_RULE_BINDING_KEYS,
  CATCH_TRIGGERS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EVENT_BINDING_FIELDS,
  EXECUTION_LISTENER_EVENTS,
  formatWordList,
  IO_DIRECTIONS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  ON_TRIGGERS,
  PROCESS_HEADER_KEYS,
  SCRIPT_FORMAT_ALIASES,
  SERVICE_TASK_BINDING_KEYS,
  splitFencedScript,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TIMER_PARTICLES,
  type AttributeBlockRule,
  type AttributeOwner,
} from './vocabulary.js';
import {
  enclosingFlowContainer,
  isNamedStatement,
  type NamedStatement,
} from './bpmn-script-scope-provider.js';
import {
  isRepeated,
  type VariableSymbolProvider,
} from './variable-symbol-provider.js';

export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkModel,
    Process: validator.checkProcess,
    StartEvent: validator.checkStartEvent,
    EndEvent: validator.checkEndEvent,
    UserTask: validator.checkAttributeOwner,
    ServiceTask: validator.checkServiceTaskAttributes,
    ScriptTask: validator.checkScriptTask,
    GenericTask: validator.checkAttributeOwner,
    SendTask: validator.checkSendTask,
    ReceiveTask: validator.checkAttributeOwner,
    BusinessRuleTask: validator.checkBusinessRuleTask,
    IfStatement: validator.checkIfStatement,
    WhileStatement: validator.checkWhileStatement,
    DoWhileStatement: validator.checkDoWhileStatement,
    ParallelStatement: validator.checkParallelStatement,
    GotoStatement: validator.checkGotoStatement,
    SubProcess: validator.checkSubProcess,
    CallActivity: validator.checkCallActivity,
    OnHandler: validator.checkOnHandler,
    ThrowStatement: validator.checkThrowStatement,
    EmitStatement: validator.checkEmitStatement,
    IntermediateCatchEvent: validator.checkIntermediateCatchEvent,
  };
  registry.register(checks, validator);
}

const CALL_BINDING_VALUES: ReadonlySet<string> = new Set([
  'latest',
  'deployment',
]);

/** The two elements naming a deployed artifact they pin a version of. */
type VersionPinnedElement = CallActivity | BusinessRuleTask;

/**
 * Attribute keys whose value names something outside process-variable scope (a
 * Java class, a form id, an EL binding, a worker topic, a called process id,
 * an identity principal), so a bareword there must not warn about an
 * undeclared variable. `jobPriority`, `priority`, and `businessKey` stay out:
 * a bareword there lowers to `${...}` and does name a process variable.
 *
 * The date keys are here for a different reason. `dueDate = deadline` emits
 * `operaton:dueDate="deadline"`, which Operaton cannot parse as a date, so
 * declaring `deadline` would hide the warning and leave the attribute just as
 * broken; {@link BpmnScriptValidator.checkAttributeValues} asks for a quoted
 * date instead. `assignee` stays out because a literal there is a valid user
 * id, so a bareword reads as a variable holding the user and still warns.
 */
const NON_VARIABLE_ATTR_KEYS: ReadonlySet<string> = new Set([
  'class',
  'formKey',
  'expression',
  'delegate',
  'topic',
  'process',
  'binding',
  'version',
  'mapDecisionResult',
  'candidateGroups',
  'candidateUsers',
  'dueDate',
  'followUpDate',
  'retryCycle',
  'resultVariable',
]);

const BOOLEAN_ATTR_KEYS: ReadonlySet<string> = new Set([
  'asyncBefore',
  'asyncAfter',
  'exclusive',
]);

/**
 * Keys whose value the engine parses (version label, ISO retry cycle, ISO
 * date). `candidateGroups`, `candidateUsers`, `jobPriority`, and `priority`
 * stay out: the engine takes their bare value as written.
 */
const TEXT_ATTR_KEYS: ReadonlySet<string> = new Set([
  'versionTag',
  'retryCycle',
  'dueDate',
  'followUpDate',
]);

interface TriggerPayloadRule {
  readonly code: 'required' | 'optional' | 'forbidden';
  /** Whether the `particle`/`time` clause is required. */
  readonly timer: boolean;
  readonly parens: 'bindings' | 'condition' | 'forbidden';
  /** Whether a non-interrupting `alongside` handler is legal. */
  readonly alongside: boolean;
  /**
   * Whether the trigger may attach as a `bpmn:boundaryEvent` on a named host.
   * `false` only for `compensation`, which attaches through
   * `bpmn:association`/`isForCompensation` as the subprocess's undo block.
   */
  readonly boundary: boolean;
  /**
   * Whether the trigger may open a handler that names no host, which lowers to
   * an event sub-process. `false` only for `cancel`: nothing opens on a cancel,
   * so it is caught on the block it gives up.
   */
  readonly hostless: boolean;
}

/**
 * An error always interrupts, so it has no `alongside`. `message`/`signal` are
 * name-keyed subscriptions, so the name is required. `compensation` reverses
 * finished work: nothing to catch by name, no flow to run alongside. `cancel`
 * mirrors `compensation`: legal only on a host, where compensation is legal
 * only without one.
 *
 * The `satisfies` clause is what forces a row per word in {@link ON_TRIGGERS};
 * the annotation keeps the lookup readable for a trigger word of any origin.
 */
const TRIGGER_PAYLOAD: Readonly<Record<string, TriggerPayloadRule>> = {
  error: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: false,
    boundary: true,
    hostless: true,
  },
  escalation: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  message: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  signal: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  timer: {
    code: 'forbidden',
    timer: true,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  condition: {
    code: 'forbidden',
    timer: false,
    parens: 'condition',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: false,
    hostless: true,
  },
  cancel: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: true,
    hostless: false,
  },
} satisfies Record<(typeof ON_TRIGGERS)[number], TriggerPayloadRule>;

const ON_TRIGGERS_SET: ReadonlySet<string> = new Set(ON_TRIGGERS);
const END_TRIGGERS_SET: ReadonlySet<string> = new Set(END_TRIGGERS);
const CATCH_TRIGGERS_SET: ReadonlySet<string> = new Set(CATCH_TRIGGERS);
const START_TRIGGERS_SET: ReadonlySet<string> = new Set(START_TRIGGERS);
const THROW_TRIGGERS_SET: ReadonlySet<string> = new Set(THROW_TRIGGERS);
const EMIT_TRIGGERS_SET: ReadonlySet<string> = new Set(EMIT_TRIGGERS);
const TIMER_PARTICLE_SET: ReadonlySet<string> = new Set(TIMER_PARTICLES);
const EVENT_BINDING_FIELD_SET: ReadonlySet<string> = new Set(
  EVENT_BINDING_FIELDS,
);
const IO_DIRECTION_SET: ReadonlySet<string> = new Set(IO_DIRECTIONS);
const LISTENER_BINDING_KEY_SET: ReadonlySet<string> = new Set(
  LISTENER_BINDING_KEYS,
);
const PROCESS_HEADER_KEY_SET: ReadonlySet<string> = new Set(
  PROCESS_HEADER_KEYS,
);
const DECISION_RESULT_MAPPING_SET: ReadonlySet<string> = new Set(
  DECISION_RESULT_MAPPINGS,
);
const SUPPORTED_SCRIPT_TAGS: ReadonlySet<string> = new Set(
  Object.keys(SCRIPT_FORMAT_ALIASES),
);

/**
 * Read off the block rules so the message cannot name a set the checks do not
 * enforce. The `attempt` block shares its AST type with `subprocess` and so has
 * no row of its own to read; the host-less `on` handler shares one with the
 * hosted form, whose noun would not say which of the two takes parameters,
 * hence the appended clause.
 */
const PARAMETER_HOSTS_MESSAGE = `parameters belong on ${[
  ...Object.values(ATTRIBUTE_BLOCK_RULES),
  ATTEMPT_BLOCK_RULE,
]
  .filter((rule) => rule.parameters)
  .map((rule) => rule.description)
  .join(', ')}, and an 'on' handler with no host.`;

const REPEATED_OUTPUT_MESSAGE =
  "A repeated step cannot map an 'output' parameter: the engine refuses to " +
  'deploy it. Move the mapping to a step after the repetition.';

const LISTENER_PARTICLE_ONLY_MESSAGE = "Only 'on timeout' takes a particle.";

const MESSAGELESS_NAME_MESSAGE =
  "A message handler needs the message's name: the engine matches messages by name.";

const TIMER_PAYLOAD_MESSAGE =
  `A timer needs to know how to read the time: write 'after "PT1H"', ` +
  `'at "2026-08-01T09:00:00"', or 'every "R/PT10M"'.`;

const CONDITION_REQUIRED_MESSAGE =
  "A condition handler needs its condition: 'on condition (amount > 100)'.";

const CONDITION_NO_CODE_MESSAGE =
  "A condition handler takes no code string; write the condition in parentheses: 'on condition (amount > 100)'.";

const CONDITION_ONLY_MESSAGE =
  "Only 'on condition' takes a condition expression.";

const PARTICLE_ONLY_MESSAGE = "Only 'on timer' takes a particle.";

const COMPENSATE_TYPO_MESSAGE =
  "Unknown event kind 'compensate'; write 'compensation'.";

const CATCH_NAME_REQUIRED_MESSAGE =
  "An awaited message needs the message's name: the engine matches messages by name.";

const CATCH_CONDITION_REQUIRED_MESSAGE =
  "An awaited condition needs its condition: 'await condition (amount > 100)'.";

const CATCH_CONDITION_NO_CODE_MESSAGE =
  "An awaited condition takes no code string; write the condition in parentheses: 'await condition (amount > 100)'.";

const CATCH_CONDITION_ONLY_MESSAGE =
  "Only 'await condition' takes a condition expression.";

const CATCH_PARTICLE_ONLY_MESSAGE = "Only 'await timer' takes a particle.";

const START_TRIGGER_IN_HANDLER_MESSAGE =
  "The start of an event-handler body carries no trigger; the handler's own " +
  "'on <kind>' is what it catches.";

const START_CONDITION_MESSAGE =
  'A process cannot start on a condition in this tool; a start event supports ' +
  'message, signal, or timer.';

const START_PARTICLE_ONLY_MESSAGE = 'Only a timer start takes a particle.';

const END_TRIGGERS_MESSAGE =
  "An end event carries 'terminate', which stops every running path in this " +
  `scope, or 'cancel', which gives up the 'attempt' block it sits in.`;

const END_TIMER_MESSAGE =
  'A timer cannot end a process; a timer is something a process waits on. ' +
  `Write 'await timer after "PT1H"' to pause the flow here, ` +
  `'on timer after "PT1H"' to react while the surrounding steps run, or ` +
  `'on <step>: timer after "PT1H"' to watch only while that step runs. ` +
  END_TRIGGERS_MESSAGE;

const END_CONDITION_MESSAGE =
  'A condition cannot end a process; a condition is something a process ' +
  `waits on. Write 'await condition (amount > 100)' to pause the flow ` +
  `here, 'on condition (amount > 100)' to react while the surrounding ` +
  `steps run, or 'on <step>: condition (amount > 100)' to watch only ` +
  'while that step runs. ' +
  END_TRIGGERS_MESSAGE;

/** Neither end word names anything, and each says so in its own terms. */
const END_TRIGGER_NO_CODE_MESSAGES: Readonly<Record<string, string>> = {
  terminate:
    'Terminate names nothing: it stops every running path in this scope; ' +
    'omit the string.',
  cancel:
    'Cancel names nothing: it gives up the block this end sits in; omit the ' +
    'string.',
} satisfies Record<(typeof END_TRIGGERS)[number], string>;

const CANCEL_END_PLACEMENT_MESSAGE =
  "A cancel end belongs directly inside an 'attempt' block: it gives that " +
  'block up, and the engine refuses one anywhere else. Wrap the steps to ' +
  `give up in 'attempt <name> { ... }', or end this path with a plain 'end'.`;

const CANCEL_HOSTLESS_MESSAGE =
  "A cancel is caught on the block it gives up; write 'on <block>: cancel'. " +
  'A handler with no host opens on its own trigger, and nothing opens on a ' +
  'cancel.';

const CANCEL_ALONGSIDE_MESSAGE =
  'Giving a block up ends every step still running inside it, so there is ' +
  "nothing left to run alongside; remove 'alongside'.";

const CANCEL_NO_CODE_MESSAGE =
  'A cancel handler catches nothing by name: it runs when its block is ' +
  'given up; omit the string.';

const CANCEL_NOT_RAISED_MESSAGE =
  'A cancel is not raised: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block.`;

/** The awaiting author wants the catch surface too, which no thrower asks for. */
const CANCEL_NOT_AWAITED_MESSAGE =
  'A cancel is not awaited: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block, and ` +
  `'on <block>: cancel' beside the block to say what happens then.`;

const COMPENSATION_NO_CODE_MESSAGE =
  "Compensation has no code or name: 'on compensation { }' is the undo block " +
  'of the subprocess or attempt block it sits in; omit the string.';

const COMPENSATION_BINDINGS_MESSAGE =
  "'(code c)' bindings belong to error and escalation handlers; compensation carries no values.";

const COMPENSATION_ALONGSIDE_MESSAGE =
  'The work an undo block reverses has already finished, so there is no ' +
  "running flow to run alongside; remove 'alongside'.";

const COMPENSATION_PLACEMENT_MESSAGE =
  "An undo block belongs directly inside the 'subprocess' or 'attempt' whose " +
  'work it undoes: a process cannot undo itself.';

const COMPENSATION_DUPLICATE_MESSAGE =
  'A subprocess or an attempt block has one undo block; merge the steps.';

const COMPENSATION_HOST_MESSAGE =
  "Compensation cannot attach to a host: it undoes a subprocess's " +
  'already-completed work through its own undo block, not through a ' +
  "boundary event; remove the host and write 'on compensation { ... }' " +
  'directly inside the subprocess or attempt block it reverses.';

/** `json`/`any` have no `operaton:formField` representation. */
const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
]);

/**
 * Ids the `astToIr` desugarer synthesizes; an author-chosen statement name
 * matching one produces duplicate-id IR. ADR-0010 (Deterministic Structural
 * Ids) has the templates and why the single-segment `Flow_` shape stays legal.
 * Gateway ids bypass the desugarer's collision guard entirely; `Boundary_`
 * runs through it but would be renamed with a suffix rather than flagged.
 */
const RESERVED_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /^Gateway_.+_(split|join|fork|loop)$/,
  /^Flow_.+_.+$/,
  /^StartEvent_/,
  /^EndEvent_/,
  /^Throw_/,
  /^EventSubProcess_/,
  /^Boundary_/,
  /^Catch_/,
];

/**
 * `any`/`json`/`unknown` are compatible with every operator because Operaton
 * coerces, so they never trigger a mismatch.
 */
type ExprType = VarType | 'unknown';

const NUMERIC_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'any',
  'json',
  'unknown',
]);
const ORDERED_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'date',
  'any',
  'json',
  'unknown',
]);
const BOOLEAN_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'boolean',
  'any',
  'json',
  'unknown',
]);

function collectNamedStatements(process: Process): NamedStatement[] {
  return AstUtils.streamAst(process).filter(isNamedStatement).toArray();
}

function collectGotoTargetNames(process: Process): Set<string> {
  return new Set(
    AstUtils.streamAst(process)
      .filter(isGotoStatement)
      .map((goto) => goto.target?.$refText ?? '')
      .filter((name) => name.length > 0),
  );
}

function statementName(stmt: Statement): string | undefined {
  return isNamedStatement(stmt) ? stmt.name : undefined;
}

/**
 * Parser error recovery leaves a mandatory slot empty, so a `Block` and a name
 * are both `undefined`-capable however the generated types declare them. A
 * `Block` is read either through here or behind a guard of its own, and a
 * check whose message would print a missing name stands down: the parse error
 * already named the mistake.
 */
function blockStatements(block: Block | undefined): Statement[] {
  return block?.statements ?? [];
}

function childBlocks(stmt: Statement): Array<Block | undefined> {
  if (isIfStatement(stmt)) {
    return [
      stmt.then,
      ...stmt.elseIfs.map((e) => e.body),
      ...(stmt.elseBlock ? [stmt.elseBlock] : []),
    ];
  }
  if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
    return [stmt.body];
  }
  if (isParallelStatement(stmt)) {
    return stmt.branches;
  }
  if (isSubProcess(stmt) || isOnHandler(stmt)) {
    return [stmt.body];
  }
  return [];
}

/** A handler never joins the main sequence, so a handler-only body counts as empty. */
function hasNoFlowStep(statements: Statement[]): boolean {
  return statements.every(isOnHandler);
}

/**
 * Whether `stmt`, once reached, always ends or diverts the flow. A compound
 * counts only when every branch does, which is exactly when the transform
 * prunes its synthesized join to zero incoming flows. An `if` without an
 * `else` and a `while`/`do-while` never count however their body ends: their
 * gateway always keeps a non-terminating exit.
 */
function statementTerminates(stmt: Statement): boolean {
  if (isEndEvent(stmt) || isGotoStatement(stmt) || isThrowStatement(stmt)) {
    return true;
  }
  if (isIfStatement(stmt) && stmt.elseBlock !== undefined) {
    return (
      blockTerminates(blockStatements(stmt.then)) &&
      stmt.elseIfs.every((elseIf) =>
        blockTerminates(blockStatements(elseIf.body)),
      ) &&
      blockTerminates(blockStatements(stmt.elseBlock))
    );
  }
  if (isParallelStatement(stmt)) {
    return stmt.branches.every((branch) =>
      blockTerminates(blockStatements(branch)),
    );
  }
  return false;
}

function blockTerminates(statements: Statement[]): boolean {
  return statements.some(
    (stmt) => !isOnHandler(stmt) && statementTerminates(stmt),
  );
}

/**
 * A composite duplicate key. `undefined` when any part was left unparsed, so a
 * template literal cannot stringify a missing slot into a key that collides
 * with itself.
 */
function duplicateKey(
  ...parts: ReadonlyArray<string | undefined>
): string | undefined {
  return parts.includes(undefined) ? undefined : parts.join(':');
}

/** Seed `seen` with keys that count as present before the first item. */
function forEachDuplicate<T>(
  items: Iterable<T>,
  key: (item: T) => string | undefined,
  onDuplicate: (item: T) => void,
  seen: Set<string> = new Set(),
): void {
  for (const item of items) {
    const k = key(item);
    if (k === undefined) {
      continue;
    }
    if (seen.has(k)) {
      onDuplicate(item);
    } else {
      seen.add(k);
    }
  }
}

export class BpmnScriptValidator {
  private readonly variables: VariableSymbolProvider;

  constructor(services: BpmnScriptServices) {
    this.variables = services.references.VariableSymbolProvider;
  }

  /**
   * The grammar permits several processes so a stray second `process` block
   * gets a clear diagnostic here instead of being dropped by the AST -> IR
   * transform, which converts only the first.
   */
  checkModel = (model: Model, accept: ValidationAcceptor): void => {
    forEachDuplicate(
      model.processes,
      () => 'process',
      (extra) =>
        accept(
          'error',
          'Only one process is supported per file. ' +
            'Move additional processes into separate files.',
          { node: extra, property: 'name' },
        ),
    );
  };

  /**
   * An explicit `start` is only valid first in a container body: the process, a
   * `subprocess`, or a host-less `on` handler. Anywhere else the desugarer
   * gives it an incoming sequence flow, and a start event with incoming flows
   * is invalid BPMN that Operaton rejects at deployment. A hosted handler's
   * body lowers inline into the host's container and is entered from the
   * boundary event, so it is no container of its own and gets its own message.
   */
  private checkStartPosition(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAst(process)) {
      if (!isStartEvent(node) || node.name === undefined) continue;
      if (node === process.body[0]) continue;
      const container = node.$container;
      if (isBlock(container) && container.statements[0] === node) {
        if (isSubProcess(container.$container)) continue;
        if (isOnHandler(container.$container)) {
          if (container.$container.host === undefined) continue;
          accept('error', hostedHandlerStartMessage(node.name), {
            node,
            property: 'name',
          });
          continue;
        }
      }
      accept(
        'error',
        `'start ${node.name}' must be the first statement of its process, subprocess, attempt block, or event-handler body. ` +
          'A start event cannot have incoming flows.',
        { node, property: 'name' },
      );
    }
  }

  /** Every check that needs the whole process at once; the symbol table is built once. */
  checkProcess = (process: Process, accept: ValidationAcceptor): void => {
    if (process.name !== undefined && hasNoFlowStep(process.body)) {
      accept(
        'error',
        `Process '${process.name}' has no flow steps: a process needs at least one step on its main flow (handlers alone do not start a process).`,
        { node: process, property: 'name' },
      );
    }

    const symbols = this.variables.collect(process);

    for (const expr of collectExpressions(process)) {
      this.checkExpression(expr, symbols, accept);
    }

    this.checkStartPosition(process, accept);

    const named = collectNamedStatements(process);
    this.checkReservedNames(named, accept);

    this.checkDuplicateVarDecls(process, accept);
    this.checkProcessAttributes(process, accept);
    this.checkDuplicateProcessLabel(process, accept);
    this.checkDuplicateStatementNames(process, named, accept);
    this.checkFormVariableAgreement(process, accept);
    this.checkUnreachableStatements(process, accept);
    this.checkHandlerDuplicates(process, accept);
    this.checkErrorDecls(process, accept);
  };

  /**
   * Reject a step control flow can never reach: it would lower to a
   * disconnected node with no incoming flow, which is invalid BPMN. A step
   * named by some `goto` is reachable again. Nested blocks are scanned only
   * when their owner is reachable, so an unreachable `if` is reported once
   * instead of once per step inside it. An `on` handler is not part of the
   * sequential flow, so the scan skips it and treats its body as a fresh root.
   * The scan is sound rather than exhaustive: a dead step may go unreported, a
   * live one is never wrongly rejected.
   */
  private checkUnreachableStatements(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const gotoTargets = collectGotoTargetNames(process);

    const scan = (statements: Statement[]): void => {
      let reachable = true;
      for (const stmt of statements) {
        if (isOnHandler(stmt)) {
          for (const block of childBlocks(stmt)) {
            scan(blockStatements(block));
          }
          continue;
        }
        const name = statementName(stmt);
        if (!reachable && name !== undefined && gotoTargets.has(name)) {
          reachable = true;
        }
        if (!reachable) {
          accept(
            'error',
            'This step can never run: an earlier `end`, `throw`, `goto`, or ' +
              'an all-terminating `if`/`parallel` in the same block always ' +
              'ends or redirects the flow before reaching it, so this step ' +
              'would lower to a disconnected node with no incoming flow, ' +
              'which is invalid BPMN.',
            { node: stmt },
          );
        } else {
          for (const block of childBlocks(stmt)) {
            scan(blockStatements(block));
          }
        }
        if (statementTerminates(stmt)) {
          reachable = false;
        }
      }
    };

    scan(process.body);
  }

  /**
   * Every declaration of a name must agree on the type, whether it is a `var`,
   * a `form` field, or a catch binding: they all bind the same runtime process
   * variable. A catch binding always fills a `string`.
   */
  private checkFormVariableAgreement(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const declaredType = new Map<string, VarType>();
    // An unparsed name or type would seed `undefined` into the table, which
    // both prints as a name and hides the next genuine disagreement.
    for (const decl of process.decls) {
      if (
        isVarDecl(decl) &&
        decl.name !== undefined &&
        decl.type !== undefined
      ) {
        declaredType.set(decl.name, decl.type);
      }
    }
    for (const node of AstUtils.streamAst(process)) {
      if (isOnHandler(node)) {
        for (const binding of node.bindings) {
          if (binding.variable === undefined) continue;
          const prior = declaredType.get(binding.variable);
          if (prior === undefined) {
            declaredType.set(binding.variable, 'string');
          } else if (prior !== 'string') {
            accept(
              'error',
              `Catch-binding variable '${binding.variable}' is typed 'string', but '${binding.variable}' is already declared as '${prior}'; the types must agree.`,
              { node: binding, property: 'variable' },
            );
          }
        }
        continue;
      }
      if (!isStartEvent(node) && !isUserTask(node)) continue;
      for (const form of node.forms) {
        for (const field of form.fields) {
          if (field.id === undefined || field.type === undefined) continue;
          const prior = declaredType.get(field.id);
          if (prior === undefined) {
            declaredType.set(field.id, field.type);
          } else if (prior !== field.type) {
            accept(
              'error',
              `Form field '${field.id}' is typed '${field.type}', but '${field.id}' is already declared as '${prior}'; the types must agree.`,
              { node: field, property: 'type' },
            );
          }
        }
      }
    }
  }

  /** A reserved-pattern name would produce duplicate-id IR; the IDE error comes first. */
  private checkReservedNames(
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    for (const node of named) {
      if (isReservedName(node.name)) {
        accept(
          'error',
          `Statement name '${node.name}' matches a reserved synthesized-id pattern. ` +
            `Prefixes 'Gateway_..._(split|join|fork|loop)', 'Flow_', 'StartEvent_', ` +
            `'EndEvent_', 'Throw_', 'EventSubProcess_', 'Boundary_', and 'Catch_' ` +
            `are reserved for ids generated by the BPMNscript desugarer.`,
          { node, property: 'name' },
        );
      }
    }
  }

  /** The symbol provider stays last-wins; this check surfaces the conflict to the author. */
  private checkDuplicateVarDecls(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    if (process.name === undefined) return;

    forEachDuplicate(
      process.decls.filter(isVarDecl),
      (decl) => decl.name,
      (decl) =>
        accept(
          'error',
          `Variable '${decl.name}' is already declared in process '${process.name}'.`,
          { node: decl, property: 'name' },
        ),
    );
  }

  /**
   * `versionTag` is the one setting a process header carries. The engine
   * execution settings are per-flow-node and have no process-wide form.
   *
   * `label` never reaches this check: it is a keyword of its own declaration
   * rule and never lexes as an attribute key, which keeps
   * {@link checkDuplicateProcessLabel} the single owner of the label rules.
   */
  private checkProcessAttributes(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    this.checkAttributeKeys(
      process.decls.filter(isProcessAttribute),
      PROCESS_HEADER_KEY_SET,
      'a process header',
      accept,
    );
  }

  /**
   * The inline label string counts as the first occurrence: the desugarer
   * prefers it and drops any `label` attribute, so a second one is dead text.
   */
  private checkDuplicateProcessLabel(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    if (process.name === undefined) return;

    forEachDuplicate(
      process.decls.filter(isProcessLabel),
      () => 'label',
      (decl) =>
        accept(
          'error',
          `Process '${process.name}' already has a label declared; a second 'label = ...' is not allowed.`,
          { node: decl, property: 'value' },
        ),
      new Set(process.label !== undefined ? ['label'] : []),
    );
  }

  /** A step name repeated anywhere in the process makes `goto <name>` ambiguous. */
  private checkDuplicateStatementNames(
    process: Process,
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    if (process.name === undefined) return;

    forEachDuplicate(
      named,
      (node) => node.name,
      (node) =>
        accept(
          'error',
          `Step name '${node.name}' is already used by another step in process ` +
            `'${process.name}'; 'goto ${node.name}' would be ambiguous.`,
          { node, property: 'name' },
        ),
    );
  }

  private checkExpression(
    expr: Expr,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    // An `out` mapping's source is evaluated in the called process's scope,
    // which the caller's symbol table cannot judge. `getContainerOfType` so a
    // VarRef nested inside an `out` source is exempt too; `in` stays checked.
    const enclosingMapping = AstUtils.getContainerOfType(
      expr,
      isVariableMapping,
    );
    if (enclosingMapping?.direction === 'out') {
      return;
    }

    // Only the direct attribute-value position is exempt: a VarRef nested in
    // a more complex attribute value is still checked.
    const container = expr.$container;
    const isNonVariableAttrValue =
      isAttribute(container) && NON_VARIABLE_ATTR_KEYS.has(container.key);
    if (isVarRef(expr) && !isNonVariableAttrValue && !symbols.has(expr.name)) {
      accept(
        'warning',
        `Variable '${expr.name}' is not declared. Add 'var ${expr.name}: <type>' to the process.`,
        { node: expr, property: 'name' },
      );
    }

    if (isRelational(expr)) {
      this.checkBinaryTypes(
        expr,
        ORDERED_OK,
        'an ordered comparison',
        symbols,
        accept,
      );
    } else if (isAdditive(expr) || isMultiplicative(expr)) {
      this.checkBinaryTypes(
        expr,
        NUMERIC_OK,
        'an arithmetic expression',
        symbols,
        accept,
      );
    } else if (isLogical(expr)) {
      this.checkBinaryTypes(
        expr,
        BOOLEAN_OK,
        'a logical expression',
        symbols,
        accept,
      );
    }
  }

  private checkBinaryTypes(
    node: Relational | Additive | Multiplicative | Logical,
    allowed: ReadonlySet<ExprType>,
    context: string,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue;
      }
      const type = symbols.get(operand.name)?.type;
      if (type === undefined) {
        continue; // Undeclared: handled by the warning, not a type error.
      }
      if (!allowed.has(type)) {
        accept(
          'error',
          `Variable '${operand.name}' of type '${type}' cannot be used in ${context} (operator '${node.op}').`,
          { node, property: side },
        );
      }
    }
  }

  checkStartEvent = (start: StartEvent, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(start, accept);

    const container = start.$container;
    // A handler-body start reads the event's data through the handler's own
    // bindings, so it has no form semantics of its own.
    if (isBlock(container) && isOnHandler(container.$container)) {
      for (const form of start.forms) {
        accept(
          'error',
          `The start of an event-handler body has no form; the event's data is bound by the handler's own '(...)' bindings, not by a form.`,
          { node: form },
        );
      }
    }

    if (start.trigger === undefined) return;

    if (isBlock(container)) {
      const host = container.$container;
      if (isSubProcess(host) || isOnHandler(host)) {
        accept(
          'error',
          isSubProcess(host)
            ? startTriggerInBlockMessage(host)
            : START_TRIGGER_IN_HANDLER_MESSAGE,
          { node: start, property: 'trigger' },
        );
        return;
      }
    }

    if (!START_TRIGGERS_SET.has(start.trigger)) {
      accept('error', startTriggerMessage(start.trigger), {
        node: start,
        property: 'trigger',
      });
      return;
    }

    this.checkStartPayload(start, TRIGGER_PAYLOAD[start.trigger]!, accept);
  };

  /**
   * Mirrors {@link checkCatchPayload}. A start gets no timer shape warnings:
   * a repeating start is a legitimate schedule, not a one-shot mistake.
   */
  private checkStartPayload(
    start: StartEvent,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required' && !start.code) {
      accept('error', startNameRequiredMessage(start.trigger!), {
        node: start,
        property: 'trigger',
      });
    }

    if (
      start.trigger === 'message' &&
      start.code !== undefined &&
      EXPRESSION_IN_NAME.test(start.code)
    ) {
      accept('error', startMessageExpressionMessage(start.code), {
        node: start,
        property: 'code',
      });
    }

    if (rule.timer) {
      if (!start.particle || !start.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: start,
          property: 'trigger',
        });
      } else {
        this.checkTimerParticleWord(start, start.particle, accept);
      }
    } else if (start.particle !== undefined) {
      accept('error', START_PARTICLE_ONLY_MESSAGE, {
        node: start,
        property: 'particle',
      });
    }
  }

  checkEndEvent = (end: EndEvent, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(end, accept);

    if (end.trigger === undefined) return;

    if (!END_TRIGGERS_SET.has(end.trigger)) {
      accept('error', endTriggerMessage(end.trigger), {
        node: end,
        property: 'trigger',
      });
      return;
    }

    // The scope the engine reads is the enclosing container, so a cancel end
    // in an `if` branch of the block still ends the block.
    if (
      end.trigger === 'cancel' &&
      !isAttemptBlock(enclosingFlowContainer(end))
    ) {
      accept('error', CANCEL_END_PLACEMENT_MESSAGE, {
        node: end,
        property: 'trigger',
      });
      return;
    }

    if (end.code !== undefined) {
      accept('error', END_TRIGGER_NO_CODE_MESSAGES[end.trigger], {
        node: end,
        property: 'code',
      });
    }
  };

  checkAttributeOwner = (
    owner: AttributeOwner,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(owner, accept);
  };

  checkServiceTaskAttributes = (
    task: ServiceTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(task, accept);
    if (task.name === undefined) return;

    this.checkExactlyOneBinding(
      task.attrs,
      SERVICE_TASK_BINDING_KEYS,
      `Service task '${task.name}'`,
      { node: task, property: 'name' },
      accept,
    );
  };

  /** The engine runs a send task the way it runs a service task, so it binds the same way. */
  checkSendTask = (task: SendTask, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(task, accept);
    if (task.name === undefined) return;

    this.checkExactlyOneBinding(
      task.attrs,
      SERVICE_TASK_BINDING_KEYS,
      `Send task '${task.name}'`,
      { node: task, property: 'name' },
      accept,
    );
  };

  /**
   * A decision step binds to a decision table or, failing that, to code. Its
   * `binding`/`version` pinning is the call activity's rule, shared verbatim,
   * and `mapDecisionResult` picks what the decision leaves in `resultVariable`.
   */
  checkBusinessRuleTask = (
    task: BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(task, accept);

    if (task.name !== undefined) {
      this.checkExactlyOneBinding(
        task.attrs,
        BUSINESS_RULE_BINDING_KEYS,
        `Decision step '${task.name}'`,
        { node: task, property: 'name' },
        accept,
      );
    }
    this.checkBindingAttribute(task, accept);
    this.checkBindingVersionExclusion(task, 'A decision step', accept);
    this.checkDecisionResultMapping(task, accept);
  };

  private checkDecisionResultMapping(
    task: BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void {
    const attr = task.attrs.find((a) => a.key === 'mapDecisionResult');
    if (!attr) {
      return;
    }
    const value = bindingValueText(attr.value);
    if (value !== undefined && DECISION_RESULT_MAPPING_SET.has(value)) {
      return;
    }
    accept(
      'error',
      `Attribute 'mapDecisionResult' must be ${formatWordList(DECISION_RESULT_MAPPINGS)}.`,
      { node: attr, property: 'value' },
    );
  }

  checkScriptTask = (task: ScriptTask, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(task, accept);
    if (task.name === undefined) return;

    if (task.body === undefined) {
      // An unterminated fence never lexes as FENCED_SCRIPT, so the parser
      // recovers into a bodyless ScriptTask. With no CST node for the body,
      // the diagnostic has to land on `name`.
      accept(
        'error',
        `Script task '${task.name}' has a malformed or unterminated fenced ` +
          'script body; a script must be a closed ```<lang> ... ``` block.',
        { node: task, property: 'name' },
      );
      return;
    }

    checkFencedScript(
      task.body,
      `Script task '${task.name}'`,
      { node: task, property: 'body' },
      accept,
    );
  };

  /**
   * Agreement with a `var` of the same name is process-wide and lives in
   * {@link checkFormVariableAgreement}.
   */
  private checkFormBlocks(
    forms: FormBlock[],
    ownerDescription: string,
    accept: ValidationAcceptor,
  ): void {
    forms.slice(1).forEach((form) => {
      accept(
        'error',
        `${ownerDescription} may declare at most one 'form' block.`,
        { node: form },
      );
    });

    for (const form of forms) {
      forEachDuplicate(
        form.fields,
        (field) => field.id,
        (field) =>
          accept('error', `Duplicate form field '${field.id}'.`, {
            node: field,
            property: 'id',
          }),
      );
      for (const field of form.fields) {
        if (field.type !== undefined && !FORM_FIELD_TYPES.has(field.type)) {
          accept(
            'error',
            `Form field '${field.id}' has type '${field.type}', which a form cannot use. Use string, number, boolean, or date.`,
            { node: field, property: 'type' },
          );
        }
      }
    }
  }

  /** @param description Sentence-starting noun phrase, e.g. `'A service task'`. */
  private rejectFormBlock(
    forms: FormBlock[],
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const form of forms) {
      accept(
        'error',
        `${description} cannot declare a 'form' block; forms belong on start events and user tasks.`,
        { node: form },
      );
    }
  }

  /** @param description Noun phrase with article, e.g. `'a user task'`. */
  private checkAttributeKeys(
    attrs: readonly (Attribute | ProcessAttribute)[],
    allowed: ReadonlySet<string>,
    description: string,
    accept: ValidationAcceptor,
  ): void {
    this.checkDuplicateKeys(attrs, accept);
    this.checkAllowedKeys(attrs, allowed, description, accept);
    this.checkAttributeValues(attrs, allowed, accept);
  }

  /**
   * A repeated *same* key is left to the duplicate-key check, so the count is
   * over distinct keys.
   *
   * @param subject The message's leading noun phrase (`"Service task 'total'"`).
   * @param alternative Appended to the names-none message only.
   */
  private checkExactlyOneBinding(
    attrs: readonly Attribute[],
    keys: readonly string[],
    subject: string,
    target: { node: AstNode; property: string },
    accept: ValidationAcceptor,
    alternative = '',
  ): void {
    if (bindingKeysOf(attrs, keys).length === 0) {
      accept(
        'error',
        `${subject} must declare a ${formatWordList(keys)} attribute${alternative}.`,
        target,
      );
      return;
    }
    checkAtMostOneBinding(attrs, keys, subject, target, accept);
  }

  private checkDuplicateKeys(
    attrs: readonly (Attribute | ProcessAttribute)[],
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      attrs,
      (attr) => attr.key,
      (attr) =>
        accept('error', `Duplicate attribute '${attr.key}'.`, {
          node: attr,
          property: 'key',
        }),
    );
  }

  /** @param description Noun phrase with article, e.g. `'a user task'`. */
  private checkAllowedKeys(
    attrs: readonly (Attribute | ProcessAttribute)[],
    allowed: ReadonlySet<string>,
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        accept(
          'error',
          `Attribute '${attr.key}' is not valid on ${description}.`,
          {
            node: attr,
            property: 'key',
          },
        );
      }
    }
  }

  /**
   * A boolean flag and an engine-side text field each accept one shape and drop
   * the rest without a trace: `asyncBefore = "true"` emits no
   * `operaton:asyncBefore` at all, so the step runs with the setting off.
   * Quoting is the norm next to it, which makes the quoted boolean the slip to
   * expect, and `versionTag = 3` is that slip in reverse. A key this element
   * does not own is already an allowed-key error from {@link checkAllowedKeys}.
   */
  private checkAttributeValues(
    attrs: readonly (Attribute | ProcessAttribute)[],
    allowed: ReadonlySet<string>,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        continue;
      }
      if (BOOLEAN_ATTR_KEYS.has(attr.key) && !isLiteralBool(attr.value)) {
        accept(
          'error',
          `Attribute '${attr.key}' takes an unquoted boolean; ` +
            `write '${attr.key} = true' or '${attr.key} = false'.`,
          { node: attr, property: 'value' },
        );
      } else if (
        TEXT_ATTR_KEYS.has(attr.key) &&
        !isLiteralString(attr.value) &&
        !isRawExpr(attr.value)
      ) {
        accept(
          'error',
          `Attribute '${attr.key}' takes a quoted string or a "\${...}" ` +
            'expression; put the value in quotes.',
          { node: attr, property: 'value' },
        );
      }
    }
  }

  private checkAttributeBlock(
    owner: AttributeOwner,
    accept: ValidationAcceptor,
  ): void {
    const rule = attributeBlockRuleOf(owner)!;
    this.checkAttributeKeys(owner.attrs, rule.keys, rule.description, accept);
    // A `call` block has no `forms` member at all.
    if ('forms' in owner) {
      if (rule.forms) {
        this.checkFormBlocks(owner.forms, rule.description, accept);
      } else {
        this.rejectFormBlock(owner.forms, capitalize(rule.description), accept);
      }
    }
    this.checkIoParameters(owner, rule, accept);
    this.checkListeners(owner, rule, accept);
  }

  private checkIoParameters(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    if (!rule.parameters) {
      for (const param of owner.params) {
        accept(
          'error',
          `${capitalize(rule.description)} cannot declare an 'input' or 'output' parameter; ${PARAMETER_HOSTS_MESSAGE}`,
          { node: param, property: 'direction' },
        );
      }
      return;
    }

    const directed: IoParameter[] = [];
    for (const param of owner.params) {
      if (IO_DIRECTION_SET.has(param.direction)) {
        directed.push(param);
      } else {
        accept(
          'error',
          `Unknown parameter direction '${param.direction}'; write ${formatWordList(IO_DIRECTIONS)}.`,
          { node: param, property: 'direction' },
        );
      }
    }

    forEachDuplicate(
      directed,
      (param) => duplicateKey(param.direction, param.name),
      (param) =>
        accept(
          'error',
          `Duplicate '${param.direction}' parameter '${param.name}'.`,
          { node: param, property: 'name' },
        ),
    );

    this.checkRepeatedOutput(owner, directed, accept);

    for (const param of directed) {
      this.checkMapKeys(param.value, accept);
    }
  }

  /**
   * The one authoring rule a repeat clause carries. Operaton rejects the
   * deployment outright (`BpmnParse.checkActivityOutputParameterSupported`),
   * so the mapping is an error rather than a warning, reported once however
   * many mappings the block holds.
   *
   * The clause needs no further rule, and any reader looking for one is
   * looking in vain: the grammar already admits a clause only with a count, a
   * collection, or both; an element name only inside `each ... in ...`; and
   * `until` only as part of a clause.
   */
  private checkRepeatedOutput(
    owner: AttributeOwner,
    directed: readonly IoParameter[],
    accept: ValidationAcceptor,
  ): void {
    if (!isRepeated(owner)) {
      return;
    }
    const mapping = directed.find((param) => param.direction === 'output');
    if (mapping) {
      accept('error', REPEATED_OUTPUT_MESSAGE, {
        node: mapping,
        property: 'direction',
      });
    }
  }

  /**
   * A map value may hold a list holding another map, so the walk reaches an
   * entry at any depth. A keyless entry compiles to unimportable XML.
   */
  private checkMapKeys(
    value: IoValue | undefined,
    accept: ValidationAcceptor,
  ): void {
    if (value === undefined) return;

    for (const node of AstUtils.streamAst(value)) {
      if (isMapEntry(node) && node.key !== undefined && node.key.length === 0) {
        accept(
          'error',
          `A map entry's key cannot be empty; name the key its value is looked up by.`,
          { node, property: 'key' },
        );
      }
    }
  }

  /** An unrecognized event word stops that listener's own checks: one mistake, one diagnostic. */
  private checkListeners(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    const recognized: Listener[] = [];
    for (const listener of owner.listeners) {
      if (!this.checkListenerEvent(listener, rule, accept)) {
        continue;
      }
      recognized.push(listener);
      this.checkListenerTimer(listener, accept);
      this.checkListenerBinding(listener, accept);
    }

    forEachDuplicate(
      recognized,
      (listener) => listener.event,
      (listener) =>
        accept('error', `Duplicate 'on ${listener.event}' listener.`, {
          node: listener,
          property: 'event',
        }),
    );
  }

  /** Whether the listener's event word is one this element kind has. */
  private checkListenerEvent(
    listener: Listener,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): boolean {
    if (listener.event === undefined) return false;

    if (EXECUTION_LISTENER_EVENTS.includes(listener.event)) {
      return true;
    }
    if (TASK_LISTENER_EVENTS.includes(listener.event)) {
      if (rule.taskListeners) {
        return true;
      }
      accept(
        'error',
        `'on ${listener.event}' is a task listener, which only a user task has; ` +
          `${rule.description} takes ${formatWordList(EXECUTION_LISTENER_EVENTS)}.`,
        { node: listener, property: 'event' },
      );
      return false;
    }
    accept(
      'error',
      `Unknown listener event '${listener.event}'; write ${formatWordList(listenerEventsFor(rule))}.`,
      { node: listener, property: 'event' },
    );
    return false;
  }

  /** `timeout` is the one listener event with no lifecycle transition to fire on. */
  private checkListenerTimer(
    listener: Listener,
    accept: ValidationAcceptor,
  ): void {
    if (listener.event === 'timeout') {
      if (!listener.particle || !listener.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: listener,
          property: 'event',
        });
      } else {
        this.checkTimerParticleWord(listener, listener.particle, accept);
      }
    } else if (listener.particle !== undefined) {
      accept('error', LISTENER_PARTICLE_ONLY_MESSAGE, {
        node: listener,
        property: 'particle',
      });
    }
  }

  /** The fenced script replaces the whole brace block, so only braces can bind none or several. */
  private checkListenerBinding(
    listener: Listener,
    accept: ValidationAcceptor,
  ): void {
    if (listener.script !== undefined) {
      checkFencedScript(
        listener.script,
        `The 'on ${listener.event}' listener`,
        { node: listener, property: 'script' },
        accept,
      );
      return;
    }

    this.checkAttributeKeys(
      listener.attrs,
      LISTENER_BINDING_KEY_SET,
      'a listener',
      accept,
    );
    this.checkExactlyOneBinding(
      listener.attrs,
      LISTENER_BINDING_KEYS,
      `The 'on ${listener.event}' listener`,
      { node: listener, property: 'event' },
      accept,
      ', or a fenced script body',
    );
  }

  /** The grammar allows an empty `Block`, so an empty branch is a warning, not an error. */
  checkIfStatement = (stmt: IfStatement, accept: ValidationAcceptor): void => {
    this.warnIfEmptyBlock(stmt.then, "The 'if' branch has no steps.", accept);
    for (const elseIf of stmt.elseIfs) {
      this.warnIfEmptyBlock(
        elseIf.body,
        "The 'else if' branch has no steps.",
        accept,
      );
    }
    if (stmt.elseBlock) {
      this.warnIfEmptyBlock(
        stmt.elseBlock,
        "The 'else' branch has no steps.",
        accept,
      );
    }
  };

  checkWhileStatement = (
    stmt: WhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'while' body has no steps.", accept);
  };

  checkDoWhileStatement = (
    stmt: DoWhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'do' body has no steps.", accept);
  };

  checkSubProcess = (stmt: SubProcess, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.name !== undefined && hasNoFlowStep(blockStatements(stmt.body))) {
      const kind = describeStatementKind(stmt);
      accept(
        'error',
        `${capitalize(kind)} named '${stmt.name}' has no flow steps: ${kind} needs at least one step on its main flow (handlers alone do not start it).`,
        { node: stmt, property: 'name' },
      );
    }

    this.checkCancelPair(stmt, accept);
  };

  /**
   * A cancel end and the handler that catches it are written apart, and each
   * half is inert without the other: the engine deploys either alone and then
   * stops at the first token that reaches the end, or never enters the handler.
   * Both halves are read from the block, so one check reports both.
   */
  private checkCancelPair(block: SubProcess, accept: ValidationAcceptor): void {
    if (!block.transactional || block.name === undefined) return;

    const handler = cancelHandlerFor(block);
    if (hasCancelEndInScope(block)) {
      if (handler === undefined) {
        accept('warning', cancelEndWithoutHandlerMessage(block.name), {
          node: block,
          property: 'name',
        });
      }
    } else if (handler !== undefined) {
      accept('warning', cancelHandlerWithoutEndMessage(block.name), {
        node: handler,
        property: 'trigger',
      });
    }
  }

  checkParallelStatement = (
    stmt: ParallelStatement,
    accept: ValidationAcceptor,
  ): void => {
    stmt.branches.forEach((branch, index) => {
      this.warnIfEmptyBlock(
        branch,
        `Branch ${index + 1} of the 'parallel' statement has no steps.`,
        accept,
      );
    });
  };

  private warnIfEmptyBlock(
    block: Block | undefined,
    message: string,
    accept: ValidationAcceptor,
  ): void {
    if (block === undefined) {
      return;
    }
    if (block.statements.length === 0) {
      accept('warning', message, { node: block, property: 'statements' });
    }
  }

  /**
   * A `parallel` branch's steps run only when the whole statement is reached,
   * so a `goto` into a branch from outside it is an error. An unresolved
   * `goto` is skipped: the linker already reports it.
   */
  checkGotoStatement = (
    goto: GotoStatement,
    accept: ValidationAcceptor,
  ): void => {
    const target = goto.target?.ref;
    if (!target) {
      return;
    }
    const branch = findEnclosingParallelBranch(target);
    if (branch && !isWithinBlock(goto, branch)) {
      const targetName = targetStatementName(target);
      accept(
        'error',
        `'goto ${targetName}' jumps into a branch of a 'parallel' statement from outside that branch; a 'parallel' branch's steps run only when the whole 'parallel' statement is reached, not via an external 'goto'.`,
        { node: goto, property: 'target' },
      );
    }
  };

  checkCallActivity = (
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(call, accept);
    this.checkCallProcessAttribute(call, accept);
    this.checkBindingAttribute(call, accept);
    this.checkBindingVersionExclusion(call, 'A call', accept);
    this.checkCallMappingDuplicates(call, accept);
  };

  /** A missing `process` has no node to attach to, so the diagnostic lands on `name`. */
  private checkCallProcessAttribute(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const processAttr = call.attrs.find((a) => a.key === 'process');
    if (!processAttr) {
      accept(
        'error',
        `A call must name the process it starts: add process = "<id>".`,
        { node: call, property: 'name' },
      );
      return;
    }
    if (
      isLiteralString(processAttr.value) &&
      processAttr.value.value.length === 0
    ) {
      accept(
        'error',
        `A call's 'process' attribute cannot be empty; name the process to start.`,
        { node: processAttr, property: 'value' },
      );
    }
  }

  /**
   * `binding = version` reaches here in either spelling: bare `version` parses
   * as a variable reference and quoted as a string, and
   * {@link bindingValueText} reads the same text out of both.
   *
   * @param owner A call or a decision step; both pin a deployed version the
   * same way, so both read the same two attributes.
   */
  private checkBindingAttribute(
    owner: VersionPinnedElement,
    accept: ValidationAcceptor,
  ): void {
    const bindingAttr = owner.attrs.find((a) => a.key === 'binding');
    if (!bindingAttr) {
      return;
    }
    const value = bindingValueText(bindingAttr.value);
    if (value !== undefined && CALL_BINDING_VALUES.has(value)) {
      return;
    }
    if (value === 'version') {
      accept(
        'error',
        `Write 'version = <number>' instead of 'binding = version'.`,
        { node: bindingAttr, property: 'value' },
      );
      return;
    }
    accept('error', `Attribute 'binding' must be 'latest' or 'deployment'.`, {
      node: bindingAttr,
      property: 'value',
    });
  }

  /**
   * Both pin which deployed version runs, so declaring both is one error.
   *
   * @param subject The message's leading noun phrase (`'A call'`).
   */
  private checkBindingVersionExclusion(
    owner: VersionPinnedElement,
    subject: string,
    accept: ValidationAcceptor,
  ): void {
    const hasBinding = owner.attrs.some((a) => a.key === 'binding');
    const hasVersion = owner.attrs.some((a) => a.key === 'version');
    if (hasBinding && hasVersion) {
      accept(
        'error',
        `${subject} cannot combine 'binding' and 'version'; use 'version = <number>' to pin a specific version, or 'binding = latest'/'binding = deployment' for the other modes.`,
        { node: owner, property: 'name' },
      );
    }
  }

  /**
   * `in` and `out` are independent namespaces. A bare `*` keys on the direction
   * alone, so a second `*` collides but `*` alongside a named mapping is legal.
   */
  private checkCallMappingDuplicates(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      call.mappings,
      (mapping) =>
        duplicateKey(mapping.direction, mapping.all ? '*' : mapping.target),
      (mapping) =>
        accept(
          'error',
          mapping.all
            ? `Duplicate '${mapping.direction} *' mapping; a direction can copy every variable only once.`
            : `Duplicate '${mapping.direction}' mapping target '${mapping.target}'.`,
          mapping.all
            ? { node: mapping }
            : { node: mapping, property: 'target' },
        ),
    );
  }

  // One diagnostic per mistake: in the event checks below an unknown trigger
  // or field word makes the owning check return immediately, since the
  // remaining rules would stack a second diagnostic on the same mistake.

  /** Sibling duplicates are compared once per process in {@link checkHandlerDuplicates}. */
  checkOnHandler = (handler: OnHandler, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(handler, accept);

    if (handler.trigger === undefined) return;

    if (!ON_TRIGGERS_SET.has(handler.trigger)) {
      accept('error', onTriggerMessage(handler.trigger), {
        node: handler,
        property: 'trigger',
      });
      return;
    }

    this.checkHandlerPlacement(handler, accept);
    this.checkHandlerTrailing(handler, accept);

    const rule = TRIGGER_PAYLOAD[handler.trigger];

    this.checkHandlerHost(handler, rule, accept);

    if (handler.alongside && !rule.alongside) {
      accept('error', alongsideMessage(handler.trigger), {
        node: handler,
        property: 'alongside',
      });
    }

    this.checkHandlerPayload(handler, rule, accept);

    if (rule.parens === 'bindings') {
      this.checkHandlerBindings(handler, accept);
    }

    this.warnIfEmptyBlock(
      handler.body,
      'The event handler has no steps.',
      accept,
    );
  };

  /** An empty string in a required slot counts as omitted; there is no "empty means catch-all". */
  private checkHandlerPayload(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required') {
      if (!handler.code) {
        accept('error', MESSAGELESS_NAME_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
    } else if (rule.code === 'optional') {
      checkEmptyCode(handler.code, handler, accept);
    } else if (handler.trigger === 'condition' && handler.code !== undefined) {
      // Timer's forbidden code folds into the timer branch below, so
      // `on timer "PT1H"` reads as a missing particle, not a stray code.
      accept('error', CONDITION_NO_CODE_MESSAGE, {
        node: handler,
        property: 'code',
      });
    } else if (
      handler.trigger === 'compensation' &&
      handler.code !== undefined
    ) {
      accept('error', COMPENSATION_NO_CODE_MESSAGE, {
        node: handler,
        property: 'code',
      });
    } else if (handler.trigger === 'cancel' && handler.code !== undefined) {
      accept('error', CANCEL_NO_CODE_MESSAGE, {
        node: handler,
        property: 'code',
      });
    }

    if (rule.timer) {
      if (!handler.particle || !handler.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      } else {
        this.checkTimerParticle(handler, accept);
      }
    } else if (handler.particle !== undefined) {
      accept('error', PARTICLE_ONLY_MESSAGE, {
        node: handler,
        property: 'particle',
      });
    }

    if (rule.parens === 'condition') {
      if (handler.condition === undefined) {
        accept('error', CONDITION_REQUIRED_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
    } else if (rule.parens === 'forbidden' && handler.bindings.length > 0) {
      for (const binding of handler.bindings) {
        accept(
          'error',
          handler.trigger === 'compensation'
            ? COMPENSATION_BINDINGS_MESSAGE
            : `'(code c)' bindings belong to error and escalation handlers; a ${handler.trigger} carries no code.`,
          { node: binding, property: 'field' },
        );
      }
    }

    if (handler.trigger !== 'condition' && handler.condition !== undefined) {
      accept('error', CONDITION_ONLY_MESSAGE, {
        node: handler,
        property: 'condition',
      });
    }
  }

  /**
   * All three grammar rules accept any ID as the particle. Returns whether it
   * is legal, so callers can skip particle-dependent follow-ups.
   */
  private checkTimerParticleWord(
    node: OnHandler | IntermediateCatchEvent | Listener | StartEvent,
    particle: string,
    accept: ValidationAcceptor,
  ): boolean {
    if (!TIMER_PARTICLE_SET.has(particle)) {
      accept(
        'error',
        `Unknown timer particle '${particle}'; write ${formatWordList(TIMER_PARTICLES)}.`,
        { node, property: 'particle' },
      );
      return false;
    }
    return true;
  }

  /** The shape checks are warnings because they guess at intent from the spelling. */
  private checkTimerParticle(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const particle = handler.particle!;
    const time = handler.time!;
    if (!this.checkTimerParticleWord(handler, particle, accept)) {
      return;
    }

    if (particle === 'after' && !time.startsWith('P') && !time.includes('${')) {
      accept('warning', "'after' expects a duration such as PT1H.", {
        node: handler,
        property: 'time',
      });
    } else if (
      particle === 'at' &&
      (time.startsWith('P') || time.startsWith('R')) &&
      !time.includes('${')
    ) {
      accept(
        'warning',
        "'at' expects a point in time such as 2026-08-01T09:00:00.",
        { node: handler, property: 'time' },
      );
    }
    // `every` gets no shape check: cycles and cron are too varied to police.

    if (particle === 'every' && !handler.alongside) {
      accept(
        'warning',
        'A repeating timer that interrupts its scope fires at most once: ' +
          "add 'alongside' to let it repeat, or use 'after'.",
        { node: handler, property: 'particle' },
      );
    }
  }

  /**
   * A handler belongs directly in a process body, a `subprocess` body, or
   * another handler's body (BPMN allows nested event sub-processes), never in a
   * branch: it scopes to a whole container. `on compensation` is tighter still,
   * belonging inside the one `subprocess` whose work it undoes; that rule only
   * fires where the generic one passed, so one mistake gives one message.
   */
  private checkHandlerPlacement(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const container = handler.$container;
    if (isProcess(container)) {
      if (handler.trigger === 'compensation') {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    const owner = container.$container;
    if (isSubProcess(owner) || isOnHandler(owner)) {
      if (handler.trigger === 'compensation' && !isSubProcess(owner)) {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    accept(
      'error',
      'An event handler belongs directly in the body of a process, a subprocess, an attempt block, or another event handler: it handles events for that whole scope, not for a single branch.',
      { node: handler },
    );
  }

  /** A handler reads like a catch block: only further handlers may follow it. */
  private checkHandlerTrailing(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const list = statementListOf(handler);
    const index = list.indexOf(handler);
    const hasNonHandlerAfter = list
      .slice(index + 1)
      .some((stmt) => !isOnHandler(stmt));
    if (hasNonHandlerAfter) {
      accept(
        'error',
        'Event handlers read like catch blocks: move it after the last step of this body.',
        { node: handler },
      );
    }
  }

  /** Duplicates are keyed on the literal field text, legal word or not. */
  private checkHandlerBindings(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      handler.bindings,
      (binding) => binding.field,
      (binding) =>
        accept('error', `Duplicate catch-binding field '${binding.field}'.`, {
          node: binding,
          property: 'field',
        }),
    );

    for (const binding of handler.bindings) {
      if (!EVENT_BINDING_FIELD_SET.has(binding.field)) {
        accept(
          'error',
          `Unknown catch-binding field '${binding.field}'; write ${formatWordList(EVENT_BINDING_FIELDS)}.`,
          { node: binding, property: 'field' },
        );
        continue;
      }
      if (binding.field === 'message' && handler.trigger === 'escalation') {
        accept('error', 'An escalation carries a code but no message.', {
          node: binding,
          property: 'field',
        });
      }
    }
  }

  /**
   * Whether this handler may name a host, and whether the host it names is one
   * it could legally attach to. Stops at the first violation.
   *
   * An unresolved host is skipped; the linker already reports it. A host inside
   * the handler's own body is circular: the scope provider offers those steps
   * as candidates, but such a step only runs after the boundary event has
   * fired, so the engine would deploy a path nothing can take. An `escalation`
   * boundary is restricted further, to a `subprocess` under either head, a
   * `call`, or a `user` task, and a `cancel` handler to an `attempt` block,
   * both Operaton's own restrictions in `BpmnParse`.
   */
  private checkHandlerHost(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (handler.host === undefined) {
      if (!rule.hostless) {
        accept('error', CANCEL_HOSTLESS_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
      return;
    }
    if (!rule.boundary) {
      accept('error', COMPENSATION_HOST_MESSAGE, {
        node: handler,
        property: 'host',
      });
      return;
    }

    const host = handler.host.ref;
    if (host === undefined) {
      return;
    }

    if (AstUtils.hasContainerOfType(host, (n) => n === handler)) {
      accept('error', selfAttachedHostMessage(targetStatementName(host)), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (!isActivityStatement(host)) {
      accept('error', illegalHostMessage(host), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (handler.trigger === 'escalation' && !isEscalationLegalHost(host)) {
      accept('error', escalationHostMessage(host), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (handler.trigger === 'cancel' && !isAttemptBlock(host)) {
      accept('error', cancelHostMessage(host), {
        node: handler,
        property: 'host',
      });
    }
  }

  /**
   * Two handlers in one container catching the same host, trigger, and code are
   * ambiguous to the engine regardless of `alongside`, and Operaton rejects the
   * deployment. A coded handler and a catch-all of the same trigger coexist, as
   * do two handlers on different hosts: each keys differently here. Runs once
   * per process so a duplicate pair is reported once, not once per direction.
   */
  private checkHandlerDuplicates(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const candidates: OnHandler[] = [];
    for (const node of AstUtils.streamAst(process)) {
      if (!isOnHandler(node)) continue;
      // Timer and conditional handlers key no engine subscription name, and
      // two deadlines in one scope is a real pattern, so they never conflict.
      if (node.trigger === 'timer' || node.trigger === 'condition') continue;
      // An unresolved host would key an empty segment and collide with every
      // host-less handler, stacking a second diagnostic on the linker's.
      if (node.host !== undefined && node.host.ref === undefined) continue;
      candidates.push(node);
    }
    // Group by flow container, not syntactic parent: a hosted handler's body
    // lowers inline into its host's container, so handlers at different
    // nesting depths can land in the same one.
    const byContainer = Map.groupBy(candidates, enclosingFlowContainer);
    for (const [container, siblings] of byContainer) {
      if (container === undefined) continue;
      forEachDuplicate(
        siblings,
        (handler) =>
          duplicateKey(
            handlerHostKey(handler),
            handler.trigger,
            handler.code ?? '',
          ),
        (handler) =>
          accept(
            'error',
            handler.trigger === 'compensation'
              ? COMPENSATION_DUPLICATE_MESSAGE
              : handlerDuplicateMessage(handler),
            { node: handler, property: 'trigger' },
          ),
      );
    }
  }

  checkThrowStatement = (
    stmt: ThrowStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.trigger === undefined) return;

    if (!THROW_TRIGGERS_SET.has(stmt.trigger)) {
      accept('error', throwTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'A thrown', 'throw', accept);
    checkThrowEmitBinding(stmt, 'a thrown', accept);
  };

  checkEmitStatement = (
    stmt: EmitStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.trigger === undefined) return;

    if (!EMIT_TRIGGERS_SET.has(stmt.trigger)) {
      accept('error', emitTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'An emitted', 'emit', accept);
    checkThrowEmitBinding(stmt, 'an emitted', accept);
  };

  /** The grammar carries no host, bindings, `alongside`, or body on this node. */
  checkIntermediateCatchEvent = (
    catchEvent: IntermediateCatchEvent,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(catchEvent, accept);

    if (catchEvent.trigger === undefined) return;

    if (!CATCH_TRIGGERS_SET.has(catchEvent.trigger)) {
      accept('error', catchTriggerMessage(catchEvent.trigger), {
        node: catchEvent,
        property: 'trigger',
      });
      return;
    }

    this.checkCatchPayload(
      catchEvent,
      TRIGGER_PAYLOAD[catchEvent.trigger]!,
      accept,
    );
  };

  /** Mirrors {@link checkHandlerPayload} without bindings and `alongside`. */
  private checkCatchPayload(
    catchEvent: IntermediateCatchEvent,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required') {
      if (!catchEvent.code) {
        accept('error', CATCH_NAME_REQUIRED_MESSAGE, {
          node: catchEvent,
          property: 'trigger',
        });
      }
    } else if (
      catchEvent.trigger === 'condition' &&
      catchEvent.code !== undefined
    ) {
      // Timer's forbidden code folds into the timer branch below, so
      // `await timer "PT1H"` reads as a missing particle, not a stray code.
      accept('error', CATCH_CONDITION_NO_CODE_MESSAGE, {
        node: catchEvent,
        property: 'code',
      });
    }

    if (rule.timer) {
      if (!catchEvent.particle || !catchEvent.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: catchEvent,
          property: 'trigger',
        });
      } else {
        this.checkTimerParticleWord(catchEvent, catchEvent.particle, accept);
      }
    } else if (catchEvent.particle !== undefined) {
      accept('error', CATCH_PARTICLE_ONLY_MESSAGE, {
        node: catchEvent,
        property: 'particle',
      });
    }

    if (rule.parens === 'condition' && catchEvent.condition === undefined) {
      accept('error', CATCH_CONDITION_REQUIRED_MESSAGE, {
        node: catchEvent,
        property: 'trigger',
      });
    }

    if (
      catchEvent.trigger !== 'condition' &&
      catchEvent.condition !== undefined
    ) {
      accept('error', CATCH_CONDITION_ONLY_MESSAGE, {
        node: catchEvent,
        property: 'condition',
      });
    }
  }

  /** A second message for the same code is conflicting text rather than a merge. */
  private checkErrorDecls(process: Process, accept: ValidationAcceptor): void {
    const decls = process.decls.filter(isErrorDecl);
    const wellFormed: ErrorDecl[] = [];
    for (const decl of decls) {
      // `field` reaches a message, `code` and `message` a `.length` and the
      // duplicate key, so one empty slot stands the whole declaration down.
      if (
        decl.kind === undefined ||
        decl.field === undefined ||
        decl.code === undefined ||
        decl.message === undefined
      ) {
        continue;
      }
      if (decl.kind !== 'error') {
        accept(
          'error',
          `Unknown declaration kind '${decl.kind}'; write 'error'.`,
          {
            node: decl,
            property: 'kind',
          },
        );
        continue;
      }
      if (decl.field !== 'message') {
        accept(
          'error',
          `Unknown declaration field '${decl.field}'; write 'message'.`,
          { node: decl, property: 'field' },
        );
        continue;
      }
      if (decl.code.length === 0) {
        accept('error', "An error declaration's code cannot be empty.", {
          node: decl,
          property: 'code',
        });
      }
      if (decl.message.length === 0) {
        accept('error', "An error declaration's message cannot be empty.", {
          node: decl,
          property: 'message',
        });
      }
      wellFormed.push(decl);
    }
    forEachDuplicate(
      wellFormed,
      (decl) => decl.code,
      (decl) =>
        accept(
          'error',
          `Error code '${decl.code}' already has a message declared; a second 'error "${decl.code}" message ...' is not allowed.`,
          { node: decl, property: 'code' },
        ),
    );
  }
}

function collectExpressions(process: Process): Expr[] {
  return AstUtils.streamAst(process).filter(isExpr).toArray();
}

function isReservedName(name: string): boolean {
  return RESERVED_ID_PATTERNS.some((re) => re.test(name));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Shared by a `script` task's body and a listener's script binding, one lexical
 * form and so one rule.
 *
 * @param subject The message's leading noun phrase (`"Script task 'total'"`).
 */
function checkFencedScript(
  raw: string,
  subject: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  const { tag, code } = splitFencedScript(raw);

  if (!SUPPORTED_SCRIPT_TAGS.has(tag)) {
    accept(
      'error',
      `${subject} has an unsupported language tag '${tag}'. ` +
        "Use 'javascript'/'js', 'groovy', 'python'/'py', 'ruby'/'rb', or 'feel'.",
      target,
    );
  }

  if (code.trim().length === 0) {
    accept('error', `${subject} has an empty script body.`, target);
  }
}

function unknownTriggerMessage(word: string, legal: readonly string[]): string {
  return `Unknown event kind '${word}'; write ${formatWordList(legal)}.`;
}

function onTriggerMessage(word: string): string {
  if (word === 'conditional') {
    return `Unknown event kind 'conditional'; did you mean 'condition'?`;
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  return unknownTriggerMessage(word, ON_TRIGGERS);
}

function startTriggerMessage(word: string): string {
  if (word === 'error' || word === 'escalation') {
    return (
      `A process cannot start on an ${word}: the engine ignores the trigger ` +
      'and starts the process as if none were written. Catch it with ' +
      `'on ${word}' inside the scope that raises it.`
    );
  }
  if (word === 'compensation') {
    return (
      "A process cannot start on compensation: it undoes a subprocess's " +
      "completed work, so it belongs in an 'on compensation' block inside " +
      'that subprocess.'
    );
  }
  if (word === 'condition' || word === 'conditional') {
    return START_CONDITION_MESSAGE;
  }
  return `Unknown event kind '${word}'; a start event supports ${formatWordList(START_TRIGGERS)}.`;
}

/** Only the triggers that interrupt by nature reach this; each says why. */
function alongsideMessage(trigger: string): string {
  if (trigger === 'compensation') return COMPENSATION_ALONGSIDE_MESSAGE;
  if (trigger === 'cancel') return CANCEL_ALONGSIDE_MESSAGE;
  return (
    'An error always interrupts: the handler takes over from the failed ' +
    "scope; 'alongside' is only available for escalations."
  );
}

function endTriggerMessage(word: string): string {
  if (THROW_TRIGGERS_SET.has(word)) {
    const article = /^[aeiou]/.test(word) ? 'An' : 'A';
    return (
      `${article} ${word} is raised with 'throw', not on an end: write ` +
      `'throw ${word}' in place of this end. ` +
      END_TRIGGERS_MESSAGE
    );
  }
  if (word === 'timer') {
    return END_TIMER_MESSAGE;
  }
  if (word === 'condition' || word === 'conditional') {
    return END_CONDITION_MESSAGE;
  }
  return (
    `Unknown event kind '${word}'. ${END_TRIGGERS_MESSAGE} Every other kind ` +
    "is raised with 'throw'."
  );
}

function startNameRequiredMessage(trigger: string): string {
  return (
    `A ${trigger} start needs the ${trigger}'s name: the engine matches ` +
    `${trigger}s by name.`
  );
}

/**
 * `RAW_TEMPLATE` is anchored at the opening quote, so only a name that *opens*
 * with `${` lexes as an expression; every other placement, and the whole `#{`
 * spelling, arrives here as a plain name.
 */
const EXPRESSION_IN_NAME = /\$\{|#\{/;

function startMessageExpressionMessage(name: string): string {
  return (
    `A message start name cannot contain an expression ("${name}"): the ` +
    'engine rejects one there, because a process that has not started yet ' +
    'has no variables to evaluate it against. Give the start a fixed name; ' +
    "an expression belongs on an 'on message' handler or an 'await message', " +
    'which run once the process has variables.'
  );
}

function throwTriggerMessage(word: string): string {
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_RAISED_MESSAGE;
  }
  return unknownTriggerMessage(word, THROW_TRIGGERS);
}

function emitTriggerMessage(word: string): string {
  if (word === 'error') {
    return "An error always aborts its path; write 'throw error'.";
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_RAISED_MESSAGE;
  }
  return unknownTriggerMessage(word, EMIT_TRIGGERS);
}

function catchTriggerMessage(word: string): string {
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_AWAITED_MESSAGE;
  }
  return (
    `Unknown event kind '${word}'; intermediate catch supports ${formatWordList(CATCH_TRIGGERS)}. ` +
    "An error or an escalation is raised with 'throw'/'emit', compensation " +
    "is a subprocess's undo block, and a cancel is written on the end that " +
    `gives up an 'attempt' block.`
  );
}

/** The activities an engine token can be "at", which a boundary event may attach to. */
function isActivityStatement(stmt: Statement): boolean {
  return (
    isUserTask(stmt) ||
    isServiceTask(stmt) ||
    isScriptTask(stmt) ||
    isGenericTask(stmt) ||
    isSendTask(stmt) ||
    isReceiveTask(stmt) ||
    isBusinessRuleTask(stmt) ||
    isSubProcess(stmt) ||
    isCallActivity(stmt)
  );
}

/**
 * Operaton gates an `escalation` boundary on a subprocess scope, a call
 * activity, or a user task, and both the `subprocess` and the `attempt` head
 * are subprocess scopes, so the predicate admits four surface kinds. Read from
 * `BpmnParse.parseBoundaryEvents`.
 */
function isEscalationLegalHost(stmt: Statement): boolean {
  return isSubProcess(stmt) || isCallActivity(stmt) || isUserTask(stmt);
}

/** A block written with the `attempt` head: the only one a cancel may give up. */
function isAttemptBlock(node: AstNode | undefined): node is SubProcess {
  return node !== undefined && isSubProcess(node) && node.transactional;
}

/**
 * Whether a cancel end ends `block` itself. The enclosing container is the
 * scope the engine reads, so an end in an `if` branch of the block counts and
 * one in a nested block does not.
 */
function hasCancelEndInScope(block: SubProcess): boolean {
  for (const node of AstUtils.streamAst(block)) {
    if (
      isEndEvent(node) &&
      node.trigger === 'cancel' &&
      enclosingFlowContainer(node) === block
    ) {
      return true;
    }
  }
  return false;
}

/** The handler catching `block` being given up, from the container it sits in. */
function cancelHandlerFor(block: SubProcess): OnHandler | undefined {
  const container = enclosingFlowContainer(block);
  if (container === undefined) return undefined;
  for (const node of AstUtils.streamAst(container)) {
    if (
      isOnHandler(node) &&
      node.trigger === 'cancel' &&
      node.host?.ref === block
    ) {
      return node;
    }
  }
  return undefined;
}

function cancelHostMessage(host: Statement): string {
  return (
    `A cancel handler can only attach to an 'attempt' block: it catches ` +
    `that block being given up; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
  );
}

function cancelEndWithoutHandlerMessage(name: string): string {
  return (
    `'${name}' gives itself up but nothing catches it: the engine stops with ` +
    `an error the first time that end is reached. Write 'on ${name}: cancel ` +
    `{ ... }' beside the block to say what happens then.`
  );
}

function cancelHandlerWithoutEndMessage(name: string): string {
  return (
    `Nothing inside '${name}' gives it up, so this handler never runs: write ` +
    `'end <name> cancel' on the path that should give the block up, or ` +
    'remove the handler.'
  );
}

/**
 * The noun phrase the diagnostics name a statement by, taken from the one table
 * that already spells every element kind out, so an `attempt` block is named
 * for the head its author wrote rather than for the rule it shares. The
 * fallback covers the statements with no row, which no diagnostic reaches.
 */
function describeStatementKind(stmt: Statement): string {
  return attributeBlockRuleOf(stmt)?.description ?? 'not an activity';
}

function startTriggerInBlockMessage(block: SubProcess): string {
  const kind = describeStatementKind(block);
  return (
    `Only the process's own start carries a trigger: ${kind} is entered ` +
    'from the step before it, so its start has none. Put the trigger on an ' +
    "'on' handler inside the block if it should react to an event."
  );
}

function illegalHostMessage(host: Statement): string {
  return (
    'A boundary event can only attach to an activity: a user, service, ' +
    `script, send, or receive task, a step, a decision step, a subprocess, ` +
    `an attempt block, or a call; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
  );
}

function escalationHostMessage(host: Statement): string {
  return (
    'An escalation boundary can only attach to a subprocess, an attempt ' +
    `block, a call, or a user task; '${targetStatementName(host)}' is ` +
    `${describeStatementKind(host)}.`
  );
}

function selfAttachedHostMessage(hostName: string): string {
  return (
    `A boundary event cannot attach to a step inside its own escape path: ` +
    `'${hostName}' only runs after this handler has already fired, so it ` +
    'can never host the event that starts that path.'
  );
}

function hostedHandlerStartMessage(name: string): string {
  return (
    `'start ${name}' cannot open a handler that names a host: the body runs ` +
    "inside the host's own container and is entered from the boundary event, " +
    'so it is not a scope with a start of its own. Remove the start; the ' +
    'first step of the body is where the escape path begins.'
  );
}

function handlerHostKey(handler: OnHandler): string {
  return handler.host?.ref ? targetStatementName(handler.host.ref) : '';
}

function handlerDuplicateMessage(handler: OnHandler): string {
  const caught =
    handler.code !== undefined
      ? `code '${handler.code}'`
      : 'every event of this kind';
  const hostKey = handlerHostKey(handler);
  const scope = hostKey ? `attached to '${hostKey}'` : 'in this scope';
  return `Another 'on ${handler.trigger}' handler ${scope} already catches ${caught}; a duplicate catch is ambiguous to the engine.`;
}

/**
 * On `on`, catch-all is the omitted string, so an empty one is a mistake.
 * `throw`/`emit` read the same shape differently, see {@link checkThrowEmitCode}.
 */
function checkEmptyCode(
  code: string | undefined,
  node: AstNode,
  accept: ValidationAcceptor,
): void {
  if (code !== undefined && code.length === 0) {
    accept(
      'error',
      'An empty code ("") is not a catch-all; to catch every error, omit the string entirely.',
      { node, property: 'code' },
    );
  }
}

/** The distinct binding keys written in an attribute block, in document order. */
function bindingKeysOf(
  attrs: readonly Attribute[],
  keys: readonly string[],
): string[] {
  return [
    ...new Set(
      attrs.map((attr) => attr.key).filter((key) => keys.includes(key)),
    ),
  ];
}

/** @param subject The message's leading noun phrase (`"Service task 'total'"`). */
function checkAtMostOneBinding(
  attrs: readonly Attribute[],
  keys: readonly string[],
  subject: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  const written = bindingKeysOf(attrs, keys);
  if (written.length > 1) {
    accept(
      'error',
      `${subject} declares more than one binding (${written.join(', ')}); exactly one of ${formatWordList(keys)} is allowed.`,
      target,
    );
  }
}

/**
 * An implementation is what makes the engine really send a thrown message, so
 * no other kind has one to run. A message thrown without one is legal and
 * common, which is why only a second binding is an error here.
 *
 * @param subject The leading noun phrase (`'a thrown'`/`'an emitted'`).
 */
function checkThrowEmitBinding(
  stmt: ThrowStatement | EmitStatement,
  subject: 'a thrown' | 'an emitted',
  accept: ValidationAcceptor,
): void {
  const written = bindingKeysOf(stmt.attrs, SERVICE_TASK_BINDING_KEYS);
  if (written.length === 0) return;

  if (stmt.trigger !== 'message') {
    for (const attr of stmt.attrs) {
      if (!written.includes(attr.key)) continue;
      accept(
        'error',
        `Attribute '${attr.key}' is not valid on ${subject} ${stmt.trigger}; ` +
          'an implementation is what makes the engine really send a message, ' +
          'so only a message carries one.',
        { node: attr, property: 'key' },
      );
    }
    return;
  }

  checkAtMostOneBinding(
    stmt.attrs,
    SERVICE_TASK_BINDING_KEYS,
    capitalize(`${subject} ${stmt.trigger}`),
    { node: stmt, property: 'trigger' },
    accept,
  );
}

/**
 * Every trigger but `compensation` must name the code it throws, so an omitted
 * and an empty code string are the same mistake: there is no catch-all on the
 * throwing side. `compensation` names nothing, so carrying a code at all is
 * the mistake there.
 *
 * @param subject The leading noun phrase (`'A thrown'`/`'An emitted'`).
 */
function checkThrowEmitCode(
  stmt: ThrowStatement | EmitStatement,
  subject: 'A thrown' | 'An emitted',
  keyword: 'throw' | 'emit',
  accept: ValidationAcceptor,
): void {
  if (stmt.trigger === 'compensation') {
    if (stmt.code !== undefined) {
      accept(
        'error',
        'Compensation undoes completed work: there is nothing to name; ' +
          `write '${keyword} compensation'.`,
        { node: stmt, property: 'code' },
      );
    }
    return;
  }
  const message = `${subject} ${stmt.trigger} names its code: '${keyword} ${stmt.trigger} "CODE"'.`;
  if (stmt.code === undefined) {
    accept('error', message, { node: stmt, property: 'trigger' });
  } else if (stmt.code.length === 0) {
    accept('error', message, { node: stmt, property: 'code' });
  }
}

function statementListOf(handler: OnHandler): Statement[] {
  const container = handler.$container;
  return isProcess(container) ? container.body : container.statements;
}

/** A bareword parses as a `VarRef` and a quoted spelling as a `LiteralString`. */
function bindingValueText(expr: Expr): string | undefined {
  if (isVarRef(expr)) {
    return expr.name;
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return undefined;
}

/**
 * `ParallelStatement`'s only `Block`-typed property is `branches`, so a `Block`
 * under one is necessarily a branch and needs no membership check.
 */
function findEnclosingParallelBranch(node: AstNode): Block | undefined {
  let child: AstNode = node;
  let parent: AstNode | undefined = node.$container;
  while (parent) {
    if (isBlock(child) && isParallelStatement(parent)) {
      return child;
    }
    child = parent;
    parent = parent.$container;
  }
  return undefined;
}

function isWithinBlock(node: AstNode, block: Block): boolean {
  let current: AstNode | undefined = node;
  while (current) {
    if (current === block) {
      return true;
    }
    current = current.$container;
  }
  return false;
}

/** A resolved cross-reference always carries a name; the `'?'` just keeps this total. */
function targetStatementName(target: Statement): string {
  return statementName(target) ?? '?';
}
