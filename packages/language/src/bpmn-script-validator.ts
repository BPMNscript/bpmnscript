/**
 * Validation checks for the BPMNscript AST, all registered through
 * {@link registerValidationChecks}.
 *
 * The checks fall into four families: structural checks (one process per
 * file, start-event position, empty bodies/blocks, goto into a parallel
 * branch), naming and id-collision checks (reserved synthesised-id patterns,
 * duplicate variable/label/statement names), variable and expression checks
 * (undeclared-variable warning, operator/type mismatch against the declared
 * Operaton-aligned types), and attribute checks (duplicate keys, allowed keys
 * per element kind, the service-task `class` requirement). Diagnostics attach
 * to the most specific property of the offending node (usually `name`, `key`,
 * or the offending operand).
 */

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
  DoWhileStatement,
  EndEvent,
  Expr,
  FormBlock,
  GotoStatement,
  IfStatement,
  Logical,
  Model,
  Multiplicative,
  ParallelStatement,
  Process,
  Relational,
  ServiceTask,
  StartEvent,
  Statement,
  UserTask,
  VarType,
  WhileStatement,
} from './generated/ast.js';
import {
  isAdditive,
  isAttribute,
  isBlock,
  isEndEvent,
  isExpr,
  isLogical,
  isMultiplicative,
  isParallelStatement,
  isProcessLabel,
  isRelational,
  isServiceTask,
  isStartEvent,
  isUserTask,
  isVarDecl,
  isVarRef,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import type { VariableSymbolProvider } from './variable-symbol-provider.js';

/**
 * Register the BPMNscript validation checks against the AST node types.
 *
 * @param services The fully-injected language services (provides the validator
 *   instance and the validation registry).
 */
export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkModel,
    Process: validator.checkProcess,
    StartEvent: validator.checkStartEvent,
    UserTask: validator.checkUserTaskAttributes,
    ServiceTask: validator.checkServiceTaskAttributes,
    IfStatement: validator.checkIfStatement,
    WhileStatement: validator.checkWhileStatement,
    DoWhileStatement: validator.checkDoWhileStatement,
    ParallelStatement: validator.checkParallelStatement,
    GotoStatement: validator.checkGotoStatement,
  };
  registry.register(checks, validator);
}

/**
 * The legal attribute keys per element kind. The grammar accepts any key on
 * any element (a single `AttrKey` datatype rule); the validator restricts them.
 */
const USER_TASK_KEYS: ReadonlySet<string> = new Set(['assignee', 'formKey']);
const SERVICE_TASK_KEYS: ReadonlySet<string> = new Set(['class']);

/**
 * The {@link VarType}s an Operaton form field can carry. `json`/`any` have no
 * `operaton:formField` representation, so the grammar's permissive `VarType` is
 * restricted here.
 */
const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
]);

/**
 * Patterns for synthesised element ids produced by the `astToIr` desugarer
 * (`packages/transform/src/synthesize-ids.ts`). These prefixes are reserved —
 * an author-chosen statement name matching any of them would collide with a
 * desugarer-generated id, producing duplicate-id IR. Gateway ids in particular
 * bypass the `taken`/`resolveCollision` guard (see `ast-to-ir.ts` STRUCTURAL-
 * COORDINATE SCHEME docstring), so the guard must be applied here.
 *
 * Patterns are anchored.
 *
 * Synthesised flow ids always carry at least two trailing segments
 * (`Flow_<src>_<tgt>` and `Flow_<gatewayId>_default`) and are only assigned
 * to `SequenceFlow.id` — they never appear in the node-name namespace. A
 * single-segment name such as `Flow_Control` therefore cannot collide with
 * any synthesised id, so only the two-segment shape is reserved
 * (`/^Flow_.+_.+$/`).
 */
const RESERVED_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /^Gateway_.+_(split|join|fork|loop)$/,
  /^Flow_.+_.+$/,
  /^StartEvent_/,
  /^EndEvent_/,
];

/**
 * The internal type lattice used by the type-mismatch check. It is the Operaton
 * variable types plus the literal-derived categories and the `unknown` top used
 * for anything we cannot (or deliberately do not) constrain.
 *
 * `any`/`json`/`unknown` are compatible with every operator (Operaton coerces),
 * so they never trigger a mismatch — keeping the lattice small and false
 * positives out.
 */
type ExprType = VarType | 'unknown';

/** Types that participate in arithmetic and ordered comparison without error. */
const NUMERIC_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'any',
  'json',
  'unknown',
]);
/** Types that are valid operands of an ordered comparison (`< <= > >=`). */
const ORDERED_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'date',
  'any',
  'json',
  'unknown',
]);

/**
 * The concrete `Statement` subtypes that carry a `name` and are therefore valid
 * `goto` targets. Shared by the reserved-name check and the duplicate-name
 * check so both address exactly the same set of nodes (expression `VarRef`s
 * are never part of this set).
 */
type NamedStatement = StartEvent | EndEvent | UserTask | ServiceTask;

/**
 * Collect every goto-targetable named statement in `process`, in document
 * order, regardless of nesting depth (inside `if`/`while`/`parallel` blocks).
 *
 * @param process The process to scan.
 * @returns Every `StartEvent`/`EndEvent`/`UserTask`/`ServiceTask` node.
 */
function collectNamedStatements(process: Process): NamedStatement[] {
  const result: NamedStatement[] = [];
  for (const node of AstUtils.streamAst(process)) {
    if (
      isStartEvent(node) ||
      isEndEvent(node) ||
      isUserTask(node) ||
      isServiceTask(node)
    ) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Invoke `onDuplicate` for every item whose key repeats an earlier occurrence.
 * `seen` can be pre-seeded with keys that count as already present before the
 * first item.
 */
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

/**
 * Structural + variable + attribute validator for BPMNscript processes.
 */
export class BpmnScriptValidator {
  private readonly variables: VariableSymbolProvider;

  /**
   * @param services The language services; the validator pulls the injected
   *   {@link VariableSymbolProvider} from the references service group so the
   *   symbol-collection seam is shared with any other consumer.
   */
  constructor(services: BpmnScriptServices) {
    this.variables = services.references.VariableSymbolProvider;
  }

  /**
   * Whole-model check: BPMNscript supports one process per file. The grammar
   * permits several so that a stray second `process` block produces a clear
   * diagnostic here rather than being silently dropped by the AST → IR
   * transform, which only converts the first process. Every process after
   * the first is flagged, which also covers reused process names.
   *
   * @param model The parsed model (all top-level processes).
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
   * An explicit `start` is only valid as the first statement of the process
   * body. Anywhere else — later in the body or nested inside a branch — the
   * desugarer gives it an incoming sequence flow, and a start event with
   * incoming flows is invalid BPMN that Operaton rejects at deployment.
   * (A process whose first statement is not a `start` gets an implicit one;
   * that path never conflicts with this check.)
   */
  private checkStartPosition(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAst(process)) {
      if (!isStartEvent(node)) continue;
      if (node === process.body[0]) continue;
      accept(
        'error',
        `'start ${node.name}' must be the first statement of the process. ` +
          'A start event cannot have incoming flows.',
        { node, property: 'name' },
      );
    }
  }

  /**
   * Process-level checks: the empty-body structural edge case, the variable
   * checks (undeclared warning, type-mismatch error) over every expression in
   * the process, and the whole-process integrity checks (duplicate variable
   * name, duplicate process label, duplicate statement name). Variable checks
   * run here, not per-`VarRef`, because variable visibility is *process-scoped*
   * and *position-independent* — the symbol table is built once per process and
   * consulted for every reference.
   *
   * @param process The process to validate.
   */
  checkProcess = (process: Process, accept: ValidationAcceptor): void => {
    // Structural: implicit start/end make a missing start/end impossible, so the
    // only surviving structural edge case is a process with no executable body.
    if (process.body.length === 0) {
      accept('warning', `Process '${process.name}' has an empty body.`, {
        node: process,
        property: 'name',
      });
    }

    const symbols = this.variables.collect(process);

    // Walk every expression in the process and run the variable checks. The
    // symbol table is flat/process-scoped, so a single table serves every
    // reference regardless of where the `var` was declared (position-independent).
    for (const expr of collectExpressions(process)) {
      this.checkExpression(expr, symbols, accept);
    }

    // Structural: an explicit `start` anywhere but first would deploy as
    // invalid BPMN (see checkStartPosition).
    this.checkStartPosition(process, accept);

    const named = collectNamedStatements(process);

    // Check every named statement for reserved synthesised-id name patterns.
    this.checkReservedNames(named, accept);

    // Whole-process integrity: duplicate declarations and duplicate step names.
    this.checkDuplicateVarDecls(process, accept);
    this.checkDuplicateProcessLabel(process, accept);
    this.checkDuplicateStatementNames(process, named, accept);
    this.checkFormVariableAgreement(process, accept);
  };

  /**
   * Every declaration of a given variable name — explicit `var`s and `form`
   * fields alike — must agree on the type. A `form` field whose type conflicts
   * with an earlier declaration of the same name (a `var`, or another field) is
   * flagged, because both bind the same runtime process variable.
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

  /**
   * Reject statement names that match the reserved synthesised-id patterns.
   *
   * The `astToIr` desugarer produces gateway ids (`Gateway_<X>_split/join/…`),
   * sequence-flow ids (`Flow_<src>_<tgt>` and `Flow_<gatewayId>_default`), and
   * implicit event ids (`StartEvent_…`, `EndEvent_…`) from structural
   * coordinates. These ids bypass the `taken`/`resolveCollision` guard, so an
   * author-chosen name colliding with one of those patterns would produce
   * duplicate-id IR. Rejecting the name here at validation time surfaces the
   * conflict as a clear IDE error. Only the two-segment `Flow_*_*` shape is
   * reserved (single-segment `Flow_X` cannot collide — see {@link
   * RESERVED_ID_PATTERNS} comment).
   *
   * @param named The goto-targetable named statements of the process.
   */
  private checkReservedNames(
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    for (const node of named) {
      if (isReservedName(node.name)) {
        accept(
          'error',
          `Statement name '${node.name}' matches a reserved synthesised-id pattern. ` +
            `Prefixes 'Gateway_…_(split|join|fork|loop)', 'Flow_', 'StartEvent_', and ` +
            `'EndEvent_' are reserved for ids generated by the BPMNscript desugarer.`,
          { node, property: 'name' },
        );
      }
    }
  }

  /**
   * Flag every `var` declaration in the process header whose name repeats an
   * earlier declaration. The symbol provider itself stays last-wins; this
   * check is what actually surfaces the conflict to the DSL author.
   *
   * @param process The process to scan.
   */
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
   * Flag a second (or later) label declaration in one process. The inline
   * label string (`process P "…"`) counts as the first occurrence: `astToIr`
   * prefers the inline label and silently drops any `label = "…"` attribute,
   * so a `label = "…"` next to an inline label is dead text and an *error*.
   * The grammar also accepts any number of `ProcessLabel` decls in
   * `process.decls`; only the first is meaningful.
   *
   * @param process The process to scan.
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
      // The inline `process P "…"` label counts as the first occurrence.
      new Set(process.label !== undefined ? ['label'] : []),
    );
  }

  /**
   * Flag a goto-targetable step (`start`/`end`/`user`/`service`) whose name
   * repeats an earlier step's name anywhere in the process — regardless of
   * nesting — because `goto <name>` would then be ambiguous.
   *
   * @param process The process to scan.
   */
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

  /**
   * Run the per-expression variable checks for a single expression node.
   *
   * @param expr The expression node.
   * @param symbols The process variable table.
   */
  private checkExpression(
    expr: Expr,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    // 1. Undeclared-variable warning: a VarRef root not in the symbol set.
    //    Skip VarRefs that are a `class` or `formKey` attribute value: those
    //    identifiers name Java classes / form ids, not process variables, so
    //    they must not fire a spurious "not declared" warning. An `assignee`
    //    value is NOT skipped — a bare identifier there renders as a `${var}`
    //    JUEL expression (see expression-render.ts), so it is a real variable
    //    reference. Only the direct attribute-value position is skipped —
    //    VarRefs inside conditions (and nested operands of a more complex
    //    attribute value) are still checked.
    const container = expr.$container;
    const isNonVariableAttrValue =
      isAttribute(container) &&
      (container.key === 'class' || container.key === 'formKey');
    if (isVarRef(expr) && !isNonVariableAttrValue && !symbols.has(expr.name)) {
      accept(
        'warning',
        `Variable '${expr.name}' is not declared. Add 'var ${expr.name}: <type>' to the process.`,
        { node: expr, property: 'name' },
      );
    }

    // 2. Type-mismatch error: an operator used with an operand whose declared
    //    type is incompatible. Only binary operator nodes carry a constraint.
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
      this.checkLogicalTypes(expr, symbols, accept);
    }
  }

  /**
   * Flag each operand of a numeric/ordered binary node whose *declared* variable
   * type is incompatible with the operator. Literal operands are typed too, so
   * `name(string) > 1000` is caught on the `name` side. A diagnostic is attached
   * to the offending operand and names the variable.
   */
  private checkBinaryTypes(
    node: Relational | Additive | Multiplicative,
    allowed: ReadonlySet<ExprType>,
    context: string,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue; // Only flag declared variables, never literals.
      }
      const type = symbols.get(operand.name)?.type;
      if (type === undefined) {
        continue; // Undeclared — handled by the warning, not a type error.
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

  /**
   * Flag an operand of a logical (`&&`/`||`) node whose declared variable type
   * is not boolean-compatible.
   */
  private checkLogicalTypes(
    node: Logical,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    const booleanOk: ReadonlySet<ExprType> = new Set<ExprType>([
      'boolean',
      'any',
      'json',
      'unknown',
    ]);
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue;
      }
      const type = symbols.get(operand.name)?.type;
      if (type !== undefined && !booleanOk.has(type)) {
        accept(
          'error',
          `Variable '${operand.name}' of type '${type}' cannot be used in a logical expression (operator '${node.op}').`,
          { node, property: side },
        );
      }
    }
  }

  /**
   * StartEvent checks: a start event may carry a `form { … }` block but no
   * `assignee`/`formKey`/`class` attributes (those belong on tasks).
   *
   * @param start The start event.
   */
  checkStartEvent = (start: StartEvent, accept: ValidationAcceptor): void => {
    for (const attr of start.attrs) {
      accept(
        'error',
        `Attribute '${attr.key}' is not valid on a start event; only a 'form' block is allowed.`,
        { node: attr, property: 'key' },
      );
    }
    this.checkFormBlocks(start.forms, 'a start event', accept);
  };

  /**
   * UserTask attribute checks: duplicate keys, key-kind validity, and its form
   * blocks.
   *
   * @param task The user task.
   */
  checkUserTaskAttributes = (
    task: UserTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(task.attrs, accept);
    this.checkAllowedKeys(task.attrs, USER_TASK_KEYS, 'user', accept);
    this.checkFormBlocks(task.forms, 'a user task', accept);
  };

  /**
   * ServiceTask attribute checks: duplicate keys, key-kind validity, the
   * exactly-one-`class` discriminator (zero → error; the more-than-one case is
   * reported by the duplicate-key check), and the absence of a form block
   * (service tasks are automated and render no form).
   *
   * @param task The service task.
   */
  checkServiceTaskAttributes = (
    task: ServiceTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(task.attrs, accept);
    this.checkAllowedKeys(task.attrs, SERVICE_TASK_KEYS, 'service', accept);

    const classCount = task.attrs.filter((a) => a.key === 'class').length;
    if (classCount === 0) {
      accept(
        'error',
        `Service task '${task.name}' must declare a 'class' attribute.`,
        { node: task, property: 'name' },
      );
    }

    for (const form of task.forms) {
      accept(
        'error',
        "A service task cannot declare a 'form' block; forms belong on start events and user tasks.",
        { node: form },
      );
    }
  };

  /**
   * Validate the `form { … }` block(s) on an element: at most one block, no
   * duplicate field ids within a block, and only form-compatible field types.
   * Cross-element agreement with a `var` of the same name is checked once at the
   * process level (see {@link checkFormVariableAgreement}).
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

  /**
   * Flag every attribute key that repeats within one block (one error per
   * duplicate *occurrence*, attached to the repeated entry's `key`).
   */
  private checkDuplicateKeys(
    attrs: Attribute[],
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

  /**
   * Flag every attribute whose key is not legal for this element kind.
   */
  private checkAllowedKeys(
    attrs: Attribute[],
    allowed: ReadonlySet<string>,
    kind: string,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        accept(
          'error',
          `Attribute '${attr.key}' is not valid on a ${kind} task.`,
          { node: attr, property: 'key' },
        );
      }
    }
  }

  /**
   * Warn on an empty `then` branch, each empty `else if` branch, and an empty
   * `else` branch. Syntactically legal (the grammar allows a `Block` with zero
   * statements) but almost always an authoring mistake, so this is a
   * *warning*, not an error.
   *
   * @param stmt The `if` statement.
   */
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

  /**
   * Warn on an empty `while` body.
   *
   * @param stmt The `while` statement.
   */
  checkWhileStatement = (
    stmt: WhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'while' body has no steps.", accept);
  };

  /**
   * Warn on an empty `do … while` body.
   *
   * @param stmt The `do … while` statement.
   */
  checkDoWhileStatement = (
    stmt: DoWhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'do' body has no steps.", accept);
  };

  /**
   * Warn on each empty `parallel` branch.
   *
   * @param stmt The `parallel` statement.
   */
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

  /**
   * Emit one warning if `block` has zero statements. Shared by every
   * empty-block check (if/else-if/else/while/do-while/parallel branch).
   */
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
   * Flag a `goto` whose resolved target lies inside a `parallel` branch when
   * the `goto` itself is not inside that same branch's subtree — a
   * `parallel` branch's steps run only when the whole `parallel` statement is
   * reached, not via an external `goto` into the middle of one of its
   * branches.
   *
   * Guarded by `if (goto.target.ref)`: an unresolved `goto` is owned by the
   * linker, which already emits exactly one
   * "Could not resolve reference" error. Touching `target.ref` unguarded here
   * would double-report on top of that error, so an unresolved reference is
   * silently skipped by this check.
   *
   * @param goto The `goto` statement.
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
}

/**
 * Collect every expression node reachable from a process: conditions of
 * `if`/`else if`/`while`/`do … while` and attribute values. Returns flat list of
 * `Expr` nodes (including nested sub-expressions, via {@link AstUtils.streamAst}).
 *
 * @param process The process to scan.
 * @returns Every `Expr` node in the process.
 */
function collectExpressions(process: Process): Expr[] {
  const result: Expr[] = [];
  for (const node of AstUtils.streamAst(process)) {
    if (isExpr(node)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Return `true` when `name` matches any reserved synthesised-id pattern.
 * Tests against {@link RESERVED_ID_PATTERNS}.
 */
function isReservedName(name: string): boolean {
  return RESERVED_ID_PATTERNS.some((re) => re.test(name));
}

/**
 * Walk up from `node` to the nearest `Block` whose direct container is a
 * `ParallelStatement` — i.e. the nearest enclosing `parallel` branch, if any.
 *
 * A `Block`'s only possible containers are `DoWhileStatement`, `ElseIf`,
 * `IfStatement`, `ParallelStatement`, and `WhileStatement` (per the grammar);
 * `ParallelStatement`'s only `Block`-typed property is `branches`, so a
 * `Block` whose container is a `ParallelStatement` is necessarily one of that
 * statement's branches — no separate membership check is needed.
 *
 * @param node The node to walk up from (typically a resolved `goto` target).
 * @returns The enclosing branch `Block`, or `undefined` if `node` is not
 *   nested inside any `parallel` branch.
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

/**
 * Return `true` when `node` is `block` itself or nested anywhere inside it
 * (checked by walking up `node`'s own `$container` chain).
 *
 * @param node The node to test (typically a `goto` statement).
 * @param block The candidate enclosing block.
 */
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

/**
 * The `name` of a resolved `goto` target for use in a diagnostic message.
 * Only `StartEvent`/`EndEvent`/`UserTask`/`ServiceTask` carry a `name` (the
 * other `Statement` members are structurally impossible `goto` targets, since
 * the grammar's `NameProvider` only keys on nodes exposing `name`), so the
 * `'?'` fallback shouldn't be reachable.
 */
function targetStatementName(target: Statement): string {
  if (
    isStartEvent(target) ||
    isEndEvent(target) ||
    isUserTask(target) ||
    isServiceTask(target)
  ) {
    return target.name;
  }
  return '?';
}
