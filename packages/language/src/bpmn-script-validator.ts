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
  CallActivity,
  DoWhileStatement,
  EmitStatement,
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
  isCallActivity,
  isDoWhileStatement,
  isEmitStatement,
  isEndEvent,
  isErrorDecl,
  isExpr,
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
  isRelational,
  isScriptTask,
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
  ATTRIBUTE_BLOCK_RULES,
  attributeBlockRuleOf,
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  EVENT_BINDING_FIELDS,
  EXECUTION_LISTENER_EVENTS,
  IO_DIRECTIONS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  ON_TRIGGERS,
  PROCESS_HEADER_KEYS,
  SCRIPT_FORMAT_ALIASES,
  SERVICE_TASK_BINDING_KEYS,
  splitFencedScript,
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
import type { VariableSymbolProvider } from './variable-symbol-provider.js';

export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkModel,
    Process: validator.checkProcess,
    StartEvent: validator.checkStartEvent,
    EndEvent: validator.checkAttributeOwner,
    UserTask: validator.checkAttributeOwner,
    ServiceTask: validator.checkServiceTaskAttributes,
    ScriptTask: validator.checkScriptTask,
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
}

/**
 * An error always interrupts, so it has no `alongside`. `message`/`signal` are
 * name-keyed subscriptions, so the name is required. `compensation` reverses
 * finished work: nothing to catch by name, no flow to run alongside.
 */
const TRIGGER_PAYLOAD: Readonly<
  Record<(typeof ON_TRIGGERS)[number], TriggerPayloadRule>
> = {
  error: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: false,
    boundary: true,
  },
  escalation: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: true,
    boundary: true,
  },
  message: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  signal: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  timer: {
    code: 'forbidden',
    timer: true,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  condition: {
    code: 'forbidden',
    timer: false,
    parens: 'condition',
    alongside: true,
    boundary: true,
  },
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: false,
  },
};

const ON_TRIGGERS_SET: ReadonlySet<string> = new Set(ON_TRIGGERS);
const CATCH_TRIGGERS_SET: ReadonlySet<string> = new Set(CATCH_TRIGGERS);
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
const SUPPORTED_SCRIPT_TAGS: ReadonlySet<string> = new Set(
  Object.keys(SCRIPT_FORMAT_ALIASES),
);

/**
 * Read off the block rules so the message cannot name a set the checks do not
 * enforce. The host-less `on` handler has no row, hence the appended clause.
 */
const PARAMETER_HOSTS_MESSAGE = `parameters belong on ${Object.values(
  ATTRIBUTE_BLOCK_RULES,
)
  .filter((rule) => rule.parameters)
  .map((rule) => rule.description)
  .join(', ')}, and an 'on' handler with no host.`;

const LISTENER_PARTICLE_ONLY_MESSAGE = "Only 'on timeout' takes a particle.";

const MESSAGELESS_NAME_MESSAGE =
  "A message handler needs the message's name — the engine matches messages by name.";

const TIMER_PAYLOAD_MESSAGE =
  `A timer needs to know how to read the time: write 'after "PT1H"', ` +
  `'at "2026-08-01T09:00:00"', or 'every "R/PT10M"'.`;

const CONDITION_REQUIRED_MESSAGE =
  "A condition handler needs its condition: 'on condition (amount > 100)'.";

const CONDITION_NO_CODE_MESSAGE =
  "A condition handler takes no code string — write the condition in parentheses: 'on condition (amount > 100)'.";

const CONDITION_ONLY_MESSAGE =
  "Only 'on condition' takes a condition expression.";

const PARTICLE_ONLY_MESSAGE = "Only 'on timer' takes a particle.";

const COMPENSATE_TYPO_MESSAGE =
  "Unknown event kind 'compensate'; write 'compensation'.";

const CATCH_NAME_REQUIRED_MESSAGE =
  "An awaited message needs the message's name — the engine matches messages by name.";

const CATCH_CONDITION_REQUIRED_MESSAGE =
  "An awaited condition needs its condition: 'await condition (amount > 100)'.";

const CATCH_CONDITION_NO_CODE_MESSAGE =
  "An awaited condition takes no code string — write the condition in parentheses: 'await condition (amount > 100)'.";

const CATCH_CONDITION_ONLY_MESSAGE =
  "Only 'await condition' takes a condition expression.";

const CATCH_PARTICLE_ONLY_MESSAGE = "Only 'await timer' takes a particle.";

const MESSAGE_NOTHING_TO_SEND_MESSAGE =
  "A message reaches this process from outside — there is nothing to send; write a message handler with 'on message'.";

const COMPENSATION_NO_CODE_MESSAGE =
  "Compensation has no code or name — 'on compensation { }' is the undo block for this subprocess; omit the string.";

const COMPENSATION_BINDINGS_MESSAGE =
  "'(code c)' bindings belong to error and escalation handlers — compensation carries no values.";

const COMPENSATION_ALONGSIDE_MESSAGE =
  'The work an undo block reverses has already finished — there is no ' +
  "running flow to run alongside; remove 'alongside'.";

const COMPENSATION_PLACEMENT_MESSAGE =
  "An undo block belongs directly inside the 'subprocess' whose work it " +
  'undoes — a process cannot undo itself.';

const COMPENSATION_DUPLICATE_MESSAGE =
  'A subprocess has one undo block — merge the steps.';

const COMPENSATION_HOST_MESSAGE =
  "Compensation cannot attach to a host — it undoes a subprocess's " +
  'already-completed work through its own undo block, not through a ' +
  "boundary event; remove the host and write 'on compensation { … }' " +
  'directly inside the subprocess it reverses.';

/** `json`/`any` have no `operaton:formField` representation. */
const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
]);

/**
 * Ids the `astToIr` desugarer synthesises; an author-chosen statement name
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
      .map((goto) => goto.target.$refText)
      .filter((name) => name.length > 0),
  );
}

function statementName(stmt: Statement): string | undefined {
  if (
    isStartEvent(stmt) ||
    isEndEvent(stmt) ||
    isUserTask(stmt) ||
    isServiceTask(stmt) ||
    isScriptTask(stmt) ||
    isSubProcess(stmt) ||
    isCallActivity(stmt)
  ) {
    return stmt.name;
  }
  if (isThrowStatement(stmt) || isEmitStatement(stmt)) {
    return stmt.name;
  }
  return undefined;
}

function childBlocks(stmt: Statement): Block[] {
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
      blockTerminates(stmt.then.statements) &&
      stmt.elseIfs.every((elseIf) => blockTerminates(elseIf.body.statements)) &&
      blockTerminates(stmt.elseBlock.statements)
    );
  }
  if (isParallelStatement(stmt)) {
    return stmt.branches.every((branch) => blockTerminates(branch.statements));
  }
  return false;
}

function blockTerminates(statements: Statement[]): boolean {
  return statements.some(
    (stmt) => !isOnHandler(stmt) && statementTerminates(stmt),
  );
}

/** Seed `seen` with keys that count as present before the first item. */
function forEachDuplicate<T>(
  items: Iterable<T>,
  key: (item: T) => string,
  onDuplicate: (item: T) => void,
  seen: Set<string> = new Set(),
): void {
  for (const item of items) {
    const k = key(item);
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
      if (!isStartEvent(node)) continue;
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
        `'start ${node.name}' must be the first statement of its process, subprocess, or event-handler body. ` +
          'A start event cannot have incoming flows.',
        { node, property: 'name' },
      );
    }
  }

  /** Every check that needs the whole process at once; the symbol table is built once. */
  checkProcess = (process: Process, accept: ValidationAcceptor): void => {
    if (hasNoFlowStep(process.body)) {
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
            scan(block.statements);
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
              'would lower to a disconnected node with no incoming flow — ' +
              'invalid BPMN.',
            { node: stmt },
          );
        } else {
          for (const block of childBlocks(stmt)) {
            scan(block.statements);
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
    for (const decl of process.decls) {
      if (isVarDecl(decl)) {
        declaredType.set(decl.name, decl.type);
      }
    }
    for (const node of AstUtils.streamAst(process)) {
      if (isOnHandler(node)) {
        for (const binding of node.bindings) {
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
          `Statement name '${node.name}' matches a reserved synthesised-id pattern. ` +
            `Prefixes 'Gateway_…_(split|join|fork|loop)', 'Flow_', 'StartEvent_', ` +
            `'EndEvent_', 'Throw_', 'EventSubProcess_', and 'Boundary_' are reserved ` +
            `for ids generated by the BPMNscript desugarer.`,
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
    forEachDuplicate(
      process.decls.filter(isProcessLabel),
      () => 'label',
      (decl) =>
        accept(
          'error',
          `Process '${process.name}' already has a label declared; a second 'label = …' is not allowed.`,
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

  /** A handler-body start carries the event definition, not form semantics. */
  checkStartEvent = (start: StartEvent, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(start, accept);

    const container = start.$container;
    if (isBlock(container) && isOnHandler(container.$container)) {
      for (const form of start.forms) {
        accept(
          'error',
          `The start of an event-handler body has no form; the event's data is bound by the handler's own '(…)' bindings, not by a form.`,
          { node: form },
        );
      }
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

    this.checkExactlyOneBinding(
      task.attrs,
      SERVICE_TASK_BINDING_KEYS,
      `Service task '${task.name}'`,
      { node: task, property: 'name' },
      accept,
    );
  };

  checkScriptTask = (task: ScriptTask, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(task, accept);

    if (task.body === undefined) {
      // An unterminated fence never lexes as FENCED_SCRIPT, so the parser
      // recovers into a bodyless ScriptTask. With no CST node for the body,
      // the diagnostic has to land on `name`.
      accept(
        'error',
        `Script task '${task.name}' has a malformed or unterminated fenced ` +
          'script body; a script must be a closed ```<lang> … ``` block.',
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
        if (!FORM_FIELD_TYPES.has(field.type)) {
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
    const bindingKeys = new Set(
      attrs.map((attr) => attr.key).filter((key) => keys.includes(key)),
    );
    if (bindingKeys.size === 0) {
      accept(
        'error',
        `${subject} must declare a ${formatWordList(keys)} attribute${alternative}.`,
        target,
      );
    } else if (bindingKeys.size > 1) {
      accept(
        'error',
        `${subject} declares more than one binding (${[...bindingKeys].join(', ')}); exactly one of ${formatWordList(keys)} is allowed.`,
        target,
      );
    }
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
      (param) => `${param.direction}:${param.name}`,
      (param) =>
        accept(
          'error',
          `Duplicate '${param.direction}' parameter '${param.name}'.`,
          { node: param, property: 'name' },
        ),
    );

    for (const param of directed) {
      this.checkMapKeys(param.value, accept);
    }
  }

  /**
   * A map value may hold a list holding another map, so the walk reaches an
   * entry at any depth. A keyless entry compiles to unimportable XML.
   */
  private checkMapKeys(value: IoValue, accept: ValidationAcceptor): void {
    for (const node of AstUtils.streamAst(value)) {
      if (isMapEntry(node) && node.key.length === 0) {
        accept(
          'error',
          `A map entry's key cannot be empty; name the key its value is looked up by.`,
          { node, property: 'key' },
        );
      }
    }
  }

  /** An unrecognised event word stops that listener's own checks: one mistake, one diagnostic. */
  private checkListeners(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    const recognised: Listener[] = [];
    for (const listener of owner.listeners) {
      if (!this.checkListenerEvent(listener, rule, accept)) {
        continue;
      }
      recognised.push(listener);
      this.checkListenerTimer(listener, accept);
      this.checkListenerBinding(listener, accept);
    }

    forEachDuplicate(
      recognised,
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

    if (hasNoFlowStep(stmt.body.statements)) {
      accept(
        'error',
        `Subprocess '${stmt.name}' has no flow steps: a subprocess needs at least one step on its main flow (handlers alone do not start it).`,
        { node: stmt, property: 'name' },
      );
    }
  };

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
    block: Block,
    message: string,
    accept: ValidationAcceptor,
  ): void {
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
    const target = goto.target.ref;
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
    this.checkCallBindingAttribute(call, accept);
    this.checkCallBindingVersionExclusion(call, accept);
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
   */
  private checkCallBindingAttribute(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const bindingAttr = call.attrs.find((a) => a.key === 'binding');
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

  /** Both pin which deployed version starts, so declaring both is one error. */
  private checkCallBindingVersionExclusion(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const hasBinding = call.attrs.some((a) => a.key === 'binding');
    const hasVersion = call.attrs.some((a) => a.key === 'version');
    if (hasBinding && hasVersion) {
      accept(
        'error',
        `A call cannot combine 'binding' and 'version'; use 'version = <number>' to pin a specific version, or 'binding = latest'/'binding = deployment' for the other modes.`,
        { node: call, property: 'name' },
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
      (mapping) => `${mapping.direction}:${mapping.all ? '*' : mapping.target}`,
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
      accept(
        'error',
        handler.trigger === 'compensation'
          ? COMPENSATION_ALONGSIDE_MESSAGE
          : "An error always interrupts: the handler takes over from the failed scope; 'alongside' is only available for escalations.",
        { node: handler, property: 'alongside' },
      );
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
            : `'(code c)' bindings belong to error and escalation handlers — a ${handler.trigger} carries no code.`,
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
    node: OnHandler | IntermediateCatchEvent | Listener,
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
        'A repeating timer that interrupts its scope fires at most once — ' +
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
      'An event handler belongs directly in a process or subprocess body — it handles events for that whole scope, not for a single branch.',
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
   * boundary is restricted further, to a `subprocess`, a `call`, or a `user`
   * task, Operaton's own restriction in `BpmnParse.parseBoundaryEvents`.
   */
  private checkHandlerHost(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (handler.host === undefined) {
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
          `${handlerHostKey(handler)}:${handler.trigger}:${handler.code ?? ''}`,
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

    if (!THROW_TRIGGERS.includes(stmt.trigger)) {
      accept('error', throwTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'A thrown', 'throw', accept);
  };

  checkEmitStatement = (
    stmt: EmitStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(stmt, accept);

    if (!EMIT_TRIGGERS.includes(stmt.trigger)) {
      accept('error', emitTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'An emitted', 'emit', accept);
  };

  /** The grammar carries no host, bindings, `alongside`, or body on this node. */
  checkIntermediateCatchEvent = (
    catchEvent: IntermediateCatchEvent,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(catchEvent, accept);

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
          `Error code '${decl.code}' already has a message declared; a second 'error "${decl.code}" message …' is not allowed.`,
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

/** A quoted English "or" clause: `'a'`, `'b'`, or `'c'`. */
function formatWordList(words: readonly string[]): string {
  const quoted = words.map((w) => `'${w}'`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
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

function throwTriggerMessage(word: string): string {
  if (word === 'message') {
    return MESSAGE_NOTHING_TO_SEND_MESSAGE;
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  return unknownTriggerMessage(word, THROW_TRIGGERS);
}

function emitTriggerMessage(word: string): string {
  if (word === 'error') {
    return "An error always aborts its path — write 'throw error'.";
  }
  if (word === 'message') {
    return MESSAGE_NOTHING_TO_SEND_MESSAGE;
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  return unknownTriggerMessage(word, EMIT_TRIGGERS);
}

function catchTriggerMessage(word: string): string {
  return (
    `Unknown event kind '${word}'; intermediate catch supports ${formatWordList(CATCH_TRIGGERS)}. ` +
    "Errors and escalations are raised with 'throw'/'emit', and compensation " +
    "is a subprocess's undo block, so none of them can be awaited inline."
  );
}

/** The activities an engine token can be "at", which a boundary event may attach to. */
function isActivityStatement(stmt: Statement): boolean {
  return (
    isUserTask(stmt) ||
    isServiceTask(stmt) ||
    isScriptTask(stmt) ||
    isSubProcess(stmt) ||
    isCallActivity(stmt)
  );
}

/**
 * Operaton restricts an `escalation` boundary to these three, narrower than
 * every other boundary trigger. Read from `BpmnParse.parseBoundaryEvents`.
 */
function isEscalationLegalHost(stmt: Statement): boolean {
  return isSubProcess(stmt) || isCallActivity(stmt) || isUserTask(stmt);
}

/** Only a node carrying a `name` can resolve, so the fallback just keeps this total. */
function describeStatementKind(stmt: Statement): string {
  if (isStartEvent(stmt)) return 'a start event';
  if (isEndEvent(stmt)) return 'an end event';
  if (isUserTask(stmt)) return 'a user task';
  if (isServiceTask(stmt)) return 'a service task';
  if (isScriptTask(stmt)) return 'a script task';
  if (isSubProcess(stmt)) return 'a subprocess';
  if (isCallActivity(stmt)) return 'a call';
  if (isThrowStatement(stmt)) return 'a throw statement';
  if (isEmitStatement(stmt)) return 'an emit statement';
  return 'not an activity';
}

function illegalHostMessage(host: Statement): string {
  return (
    'A boundary event can only attach to an activity — a user, service, ' +
    `or script task, a subprocess, or a call; '${targetStatementName(host)}' is ` +
    `${describeStatementKind(host)}.`
  );
}

function escalationHostMessage(host: Statement): string {
  return (
    'An escalation boundary can only attach to a subprocess, a call, or a ' +
    `user task; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
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
        'Compensation undoes completed work — there is nothing to name; ' +
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
