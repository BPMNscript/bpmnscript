/**
 * Container-scoped cross-reference resolution for `goto`.
 *
 * A `goto target=[Statement:ID]` may only jump to a step within its own
 * *flow container* — the nearest enclosing `process` or `subprocess`. Langium's
 * stock scope provider makes a named step visible only to references whose own
 * container chain passes through that step's block (classic block-lexical
 * visibility), which is wrong for `goto` in two ways:
 *
 *   1. A step nested inside a `parallel`/`if`/`while` block is invisible to a
 *      `goto` positioned outside that block, so a legitimate same-container
 *      jump target cannot resolve at all — and the "goto into a parallel
 *      branch" validator can never see a resolved target to flag.
 *   2. Nothing structurally guarantees a `goto` cannot reach into a *different*
 *      container — a different process, or across a sub-process boundary.
 *      BPMN forbids a sequence flow from crossing a sub-process boundary, so
 *      `goto` must not synthesize one either.
 *
 * This provider replaces the scope for the `goto` target reference with the set
 * of every named step whose *own* nearest enclosing container (process or
 * sub-process) is the same container the `goto` itself sits in — regardless of
 * block nesting inside that container — and with no global fall-through. A
 * `goto` therefore resolves to any step of its own container (including a
 * sibling `subprocess` statement, targetable by name like any other step) and
 * to nothing outside it — not an ancestor container, not a sibling container's
 * interior, and not another process entirely. Every other cross-reference keeps
 * Langium's default scope.
 *
 * A cross-boundary `goto` therefore fails to resolve; the resulting linker
 * diagnostic is upgraded to a boundary explanation by {@link
 * BpmnScriptLinker} rather than by an extra validator rule here.
 *
 * The `NameProvider` still keys on the AST `name` property (see the grammar's
 * naming-convention comment); this provider only *narrows the candidate set*, it
 * does not change the key — so no custom `NameProvider` is needed.
 */

import {
  AstUtils,
  DefaultScopeProvider,
  type AstNode,
  type ReferenceInfo,
  type Scope,
} from 'langium';
import {
  isGotoStatement,
  isProcess,
  isSubProcess,
  type Process,
  type SubProcess,
} from './generated/ast.js';

/**
 * A `goto` target lives in either a top-level `process` or a `subprocess`.
 * Exported so {@link BpmnScriptLinker} (the boundary-diagnostic hook) can
 * locate a resolved-elsewhere target's own container without duplicating the
 * walk.
 */
export type FlowContainer = Process | SubProcess;

export function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node);
}

/**
 * The nearest `process`/`subprocess` strictly enclosing `node` — i.e. the flow
 * container `node` itself lives in, found by walking `$container` upward
 * starting at `node.$container` (so `node` matching the predicate itself, as a
 * `SubProcess` statement would, does not short-circuit the walk).
 */
export function enclosingFlowContainer(node: AstNode): FlowContainer | undefined {
  return AstUtils.getContainerOfType(node.$container, isFlowContainer);
}

/**
 * Restricts `goto` resolution to the enclosing process/sub-process; delegates
 * every other cross-reference to {@link DefaultScopeProvider}.
 */
export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  /**
   * @param context The cross-reference for which a scope is requested.
   * @returns For the `goto` target reference, the named steps of the enclosing
   *   container (any nesting depth within it, no outer scope); otherwise the
   *   default scope.
   */
  override getScope(context: ReferenceInfo): Scope {
    // Only the `goto` target reference is container-scoped; delegate the rest.
    if (isGotoStatement(context.container) && context.property === 'target') {
      const container = AstUtils.getContainerOfType(
        context.container,
        isFlowContainer,
      );
      if (container) {
        // The reference type is `Statement`; keep only the named descendants
        // that are goto-targetable (its `Statement` subtypes), so process-scope
        // declarations such as `var` (which also carry a `name`) never pollute
        // the goto scope. `createScopeForNodes` drops the ones without a name.
        const referenceType = this.reflection.getReferenceType(context);
        const targets = AstUtils.streamAllContents(container).filter(
          (node) =>
            this.reflection.isSubtype(node.$type, referenceType) &&
            // A candidate counts only when THIS container is its own nearest
            // enclosing container — a step inside a nested `subprocess` has
            // that sub-process as its nearest container, not this one, so it
            // is excluded (nesting isolation). A `subprocess` statement sitting
            // directly in this container passes: its own nearest enclosing
            // container (walking up from its `$container`) is this container.
            enclosingFlowContainer(node) === container,
        );
        // No outer scope: a goto sees only its own container's steps, so a
        // step of an ancestor container, a sibling container, or another
        // process entirely is unreachable by construction.
        return this.createScopeForNodes(targets);
      }
    }
    return super.getScope(context);
  }
}
