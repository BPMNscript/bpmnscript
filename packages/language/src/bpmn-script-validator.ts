/**
 * Validation checks for the BPMNscript AST.
 *
 * Attribute/type/structural families, all registered through
 * {@link registerValidationChecks}:
 *
 *  1. **Undeclared-variable warning**: every `VarRef` whose root identifier
 *     is not a declared process variable produces a *warning* (the variable may
 *     still exist at runtime; the DSL only *optionally* declares types).
 *  2. **Type-mismatch error**: when a referenced variable *is* declared, a
 *     use that is incompatible with the operator it appears under (a `string` in
 *     a numeric comparison, a `boolean` in arithmetic, …) is an *error*. The type
 *     lattice is intentionally small and aligned with Operaton variable types
 *     (`string`, `number`, `boolean`, `date`, `json`, `any`).
 *  3. **Duplicate attribute key**: the grammar admits an attribute block as
 *     a *list* of entries so duplicates are visible in the AST; each repeated key
 *     after the first is an *error*.
 *  4. **Service-task discriminator**: a `service` task needs exactly one `class`
 *     attribute. Zero → error (the more-than-one case is already covered by the
 *     duplicate-key check).
 *  5. **Structural process check**: re-expressed for the structured AST. Implicit
 *     start/end means "missing start/end" is no longer possible, so only the
 *     empty-body edge case survives — a process with no executable statements is
 *     a warning.
 *  6. **Reserved synthesised-id name check**: statement names matching the
 *     patterns reserved for synthesised gateway/flow/event ids
 *     (`Gateway_*_split/join/fork/loop`, `Flow_*_*`, `StartEvent_*`,
 *     `EndEvent_*`) are rejected with an error — these patterns are reserved for
 *     ids produced by the `astToIr` desugarer and would produce duplicate-id IR
 *     if allowed as element names. The `Flow_` pattern is intentionally
 *     tightened to the two-segment shape (`Flow_<src>_<tgt>`) because
 *     synthesised flow ids only occupy `SequenceFlow.id` (never node names), so
 *     only genuinely id-shaped names can collide. Gateway ids are NOT
 *     collision-guarded by the `taken` set (see `ast-to-ir.ts`), so the guard
 *     must be applied here at parse/validation time.
 *
 * Whole-process integrity families (added for compile-time safety of `goto` and
 * structural authoring mistakes):
 *
 *  7. **Duplicate process name** (`Model` check): a second `process` declaration
 *     reusing a name already seen is an *error*.
 *  8. **Duplicate variable name**: a second `var` declaration in one process
 *     reusing a name already declared is an *error* (the symbol provider itself
 *     stays last-wins — see `variable-symbol-provider.ts` — this check is the
 *     one that actually surfaces the conflict).
 *  9. **Duplicate process label**: a second label declaration in one process
 *     is an *error* — the inline `process P "…"` label counts as the first
 *     occurrence (the grammar accepts an inline label plus any number of
 *     `ProcessLabel` decls; only one label is meaningful).
 * 10. **Duplicate statement name**: two goto-targetable steps
 *     (`start`/`end`/`user`/`service`) sharing one name make `goto` ambiguous —
 *     an *error* naming the offending step.
 * 11. **Empty-block warning**: an `if`/`else if`/`else` branch, a `while`/
 *     `do … while` body, or a `parallel` branch with zero statements is a
 *     *warning* (syntactically legal, almost certainly an authoring mistake).
 * 12. **Goto into a parallel branch from outside**: `target.ref` is only
 *     inspected when it is already resolved (`if (goto.target.ref)` —
 *     CLAUDE.md guard-ref lesson: an unresolved `goto` is owned by the linker,
 *     which already emits exactly one "Could not resolve reference" error;
 *     touching `target.ref` unguarded would double-report on top of that). When
 *     resolved, a `goto` whose target lies inside a `parallel` branch, issued
 *     from outside that same branch's subtree, is an *error* — a `parallel`
 *     branch's steps run only when the whole `parallel` statement is reached,
 *     not via an external `goto`.
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
 * Patterns for synthesised element ids produced by the `astToIr` desugarer
 * (`packages/transform/src/synthesize-ids.ts`). These prefixes are reserved —
 * an author-chosen statement name matching any of them would collide with a
 * desugarer-generated id, producing duplicate-id IR. Gateway ids in particular
 * bypass the `taken`/`resolveCollision` guard (see `ast-to-ir.ts` STRUCTURAL-
 * COORDINATE SCHEME docstring), so the guard must be applied here.
 *
 * Patterns are anchored.
 *
 * **Flow_ rationale:** synthesised flow ids always carry ≥2 trailing segments
 * (`Flow_<src>_<tgt>` and `Flow_<gatewayId>_default`). Crucially, synthesised
 * `Flow_*` ids are only assigned to `SequenceFlow.id` — they never appear in
 * the node-name namespace. A single-segment name like `Flow_Control` therefore
 * cannot collide with any synthesised id, so only the two-segment shape is
 * reserved (`/^Flow_.+_.+$/`). This keeps the reserved-namespace contract for
 * genuinely id-shaped names while freeing single-segment names.
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
 * check so both address exactly the same set of nodes (CLAUDE.md
 * streamAst-attribute lesson: expression `VarRef`s are never part of this set).
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
   * @param accept The diagnostic sink.
   */
  checkModel = (model: Model, accept: ValidationAcceptor): void => {
    for (const extra of model.processes.slice(1)) {
      accept(
        'error',
        'Only one process is supported per file. ' +
          'Move additional processes into separate files.',
        { node: extra, property: 'name' },
      );
    }
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
   * @param accept The diagnostic sink.
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

    // Check every named statement for reserved synthesised-id name patterns.
    this.checkReservedNames(process, accept);

    // Whole-process integrity: duplicate declarations and duplicate step names.
    this.checkDuplicateVarDecls(process, accept);
    this.checkDuplicateProcessLabel(process, accept);
    this.checkDuplicateStatementNames(process, accept);
  };

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
   * @param process The process to scan.
   * @param accept The diagnostic sink.
   */
  private checkReservedNames(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of collectNamedStatements(process)) {
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
   * earlier declaration. The symbol provider itself stays last-wins (D-F); this
   * check is what actually surfaces the conflict to the DSL author.
   *
   * @param process The process to scan.
   * @param accept The diagnostic sink.
   */
  private checkDuplicateVarDecls(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const seen = new Set<string>();
    for (const decl of process.decls) {
      if (!isVarDecl(decl)) {
        continue;
      }
      if (seen.has(decl.name)) {
        accept(
          'error',
          `Variable '${decl.name}' is already declared in process '${process.name}'.`,
          { node: decl, property: 'name' },
        );
      } else {
        seen.add(decl.name);
      }
    }
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
   * @param accept The diagnostic sink.
   */
  private checkDuplicateProcessLabel(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    let seenOne = process.label !== undefined;
    for (const decl of process.decls) {
      if (!isProcessLabel(decl)) {
        continue;
      }
      if (seenOne) {
        accept(
          'error',
          `Process '${process.name}' already has a label declared; a second 'label = …' is not allowed.`,
          { node: decl, property: 'value' },
        );
      } else {
        seenOne = true;
      }
    }
  }

  /**
   * Flag a goto-targetable step (`start`/`end`/`user`/`service`) whose name
   * repeats an earlier step's name anywhere in the process — regardless of
   * nesting — because `goto <name>` would then be ambiguous.
   *
   * @param process The process to scan.
   * @param accept The diagnostic sink.
   */
  private checkDuplicateStatementNames(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const seen = new Set<string>();
    for (const node of collectNamedStatements(process)) {
      if (seen.has(node.name)) {
        accept(
          'error',
          `Step name '${node.name}' is already used by another step in process ` +
            `'${process.name}'; 'goto ${node.name}' would be ambiguous.`,
          { node, property: 'name' },
        );
      } else {
        seen.add(node.name);
      }
    }
  }

  /**
   * Run the per-expression variable checks for a single expression node.
   *
   * @param expr The expression node.
   * @param symbols The process variable table.
   * @param accept The diagnostic sink.
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
   * UserTask attribute checks: duplicate keys and key-kind validity.
   *
   * @param task The user task.
   * @param accept The diagnostic sink.
   */
  checkUserTaskAttributes = (
    task: UserTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(task.attrs, accept);
    this.checkAllowedKeys(task.attrs, USER_TASK_KEYS, 'user', accept);
  };

  /**
   * ServiceTask attribute checks: duplicate keys, key-kind validity, and the
   * exactly-one-`class` discriminator (zero → error; the more-than-one case is
   * reported by the duplicate-key check).
   *
   * @param task The service task.
   * @param accept The diagnostic sink.
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
  };

  /**
   * Flag every attribute key that repeats within one block (one error per
   * duplicate *occurrence*, attached to the repeated entry's `key`).
   */
  private checkDuplicateKeys(
    attrs: Attribute[],
    accept: ValidationAcceptor,
  ): void {
    const seen = new Set<string>();
    for (const attr of attrs) {
      if (seen.has(attr.key)) {
        accept('error', `Duplicate attribute '${attr.key}'.`, {
          node: attr,
          property: 'key',
        });
      } else {
        seen.add(attr.key);
      }
    }
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
   * *warning*, not an error (D-G).
   *
   * @param stmt The `if` statement.
   * @param accept The diagnostic sink.
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
   * @param accept The diagnostic sink.
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
   * @param accept The diagnostic sink.
   */
  checkDoWhileStatement = (
    stmt: DoWhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'do' body has no steps.", accept);
  };

  /**
   * Warn on each empty `parallel` branch (1-based position in the message so
   * the DSL author can find it without counting from zero).
   *
   * @param stmt The `parallel` statement.
   * @param accept The diagnostic sink.
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
   * Guarded by `if (goto.target.ref)` (CLAUDE.md guard-ref lesson): an
   * unresolved `goto` is owned by the linker, which already emits exactly one
   * "Could not resolve reference" error. Touching `target.ref` unguarded here
   * would double-report on top of that error, so an unresolved reference is
   * silently skipped by this check.
   *
   * @param goto The `goto` statement.
   * @param accept The diagnostic sink.
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
    if (isExprNode(node)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Type guard for any expression AST node. Delegates to the generated `isExpr`
 * reflection guard, which keys on the abstract `Expr` super-type and therefore
 * stays in sync with every concrete `Expr` member the grammar defines.
 */
function isExprNode(node: { $type: string }): node is Expr {
  return isExpr(node);
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
 * the grammar's `NameProvider` only keys on nodes exposing `name` — see the
 * grammar's naming-convention comment), so the fallback is defensive rather
 * than load-bearing.
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
