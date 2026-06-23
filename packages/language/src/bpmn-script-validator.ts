/**
 * Validation checks for the BPMNscript AST.
 *
 * Six families of checks, all registered through {@link registerValidationChecks}:
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
 * CLAUDE.md guard-ref lesson: this file deliberately registers **no** check on
 * `GotoStatement`. An unresolved `goto` is owned by the linker, which already
 * emits exactly one "Could not resolve reference" error. Adding a validator that
 * touches `target.ref` would double-report on top of that error, so we don't.
 */

import { AstUtils, type ValidationAcceptor, type ValidationChecks } from 'langium';
import type {
  Additive,
  Attribute,
  BpmnScriptAstType,
  Expr,
  Logical,
  Multiplicative,
  Process,
  Relational,
  ServiceTask,
  UserTask,
  VarType,
} from './generated/ast.js';
import {
  isAdditive,
  isAttribute,
  isEndEvent,
  isExpr,
  isLogical,
  isMultiplicative,
  isRelational,
  isServiceTask,
  isStartEvent,
  isUserTask,
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
    Process: validator.checkProcess,
    UserTask: validator.checkUserTaskAttributes,
    ServiceTask: validator.checkServiceTaskAttributes,
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
 * Patterns are anchored and non-backtracking to avoid ReDoS.
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
  /^Gateway_[^_].*_(split|join|fork|loop)$/,
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
const NUMERIC_OK: ReadonlySet<ExprType> = new Set<ExprType>(['number', 'any', 'json', 'unknown']);
/** Types that are valid operands of an ordered comparison (`< <= > >=`). */
const ORDERED_OK: ReadonlySet<ExprType> = new Set<ExprType>(['number', 'date', 'any', 'json', 'unknown']);

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
   * Process-level checks: the empty-body structural edge case plus the variable
   * checks (undeclared warning, type-mismatch error) over every expression in
   * the process. Variable checks run here, not per-`VarRef`, because variable
   * visibility is *process-scoped* and *position-independent* — the symbol
   * table is built once per process and consulted for every reference.
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

    // Check every named statement for reserved synthesised-id name patterns.
    this.checkReservedNames(process, accept);
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
  private checkReservedNames(process: Process, accept: ValidationAcceptor): void {
    for (const node of AstUtils.streamAst(process)) {
      if (
        isStartEvent(node) ||
        isEndEvent(node) ||
        isUserTask(node) ||
        isServiceTask(node)
      ) {
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
    //    Skip VarRefs that ARE an attribute value: `class = com.example.X` or a
    //    dotted form key parses its value as a VarRef, but those identifiers name
    //    Java classes / form keys, not process variables, so they must not fire a
    //    spurious "not declared" warning. Only the direct attribute-value
    //    position is skipped — VarRefs inside conditions (and nested operands of
    //    a more complex attribute value) are still checked.
    if (isVarRef(expr) && !isAttribute(expr.$container) && !symbols.has(expr.name)) {
      accept(
        'warning',
        `Variable '${expr.name}' is not declared. Add 'var ${expr.name}: <type>' to the process.`,
        { node: expr, property: 'name' },
      );
    }

    // 2. Type-mismatch error: an operator used with an operand whose declared
    //    type is incompatible. Only binary operator nodes carry a constraint.
    if (isRelational(expr)) {
      this.checkBinaryTypes(expr, ORDERED_OK, 'an ordered comparison', symbols, accept);
    } else if (isAdditive(expr) || isMultiplicative(expr)) {
      this.checkBinaryTypes(expr, NUMERIC_OK, 'an arithmetic expression', symbols, accept);
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
  checkUserTaskAttributes = (task: UserTask, accept: ValidationAcceptor): void => {
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
  checkServiceTaskAttributes = (task: ServiceTask, accept: ValidationAcceptor): void => {
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
  private checkDuplicateKeys(attrs: Attribute[], accept: ValidationAcceptor): void {
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
