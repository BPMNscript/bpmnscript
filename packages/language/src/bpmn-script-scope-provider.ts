/**
 * Container-scoped cross-reference resolution for `goto` and for an `on`
 * handler's host.
 *
 * A `goto target=[Statement:ID]` may only jump to a step within its own
 * *flow container* — the nearest enclosing `process`, `subprocess`, or `on`
 * handler body. Langium's stock scope provider makes a named step visible
 * only to references whose own container chain passes through that step's
 * block (classic block-lexical visibility), which is wrong for `goto` in two
 * ways:
 *
 *   1. A step nested inside a `parallel`/`if`/`while` block is invisible to a
 *      `goto` positioned outside that block, so a legitimate same-container
 *      jump target cannot resolve at all — and the "goto into a parallel
 *      branch" validator can never see a resolved target to flag.
 *   2. Nothing structurally guarantees a `goto` cannot reach into a *different*
 *      container — a different process, across a sub-process boundary, or
 *      into/out of an event handler body. BPMN forbids a sequence flow from
 *      crossing a sub-process boundary (an event handler being a kind of
 *      sub-process, this includes it too), so `goto` must not synthesize one
 *      either.
 *
 * This provider replaces the scope for the `goto` target reference with the set
 * of every named step whose *own* nearest enclosing container (process,
 * sub-process, or handler body) is the same container the `goto` itself sits
 * in — regardless of block nesting inside that container — and with no global
 * fall-through. A `goto` therefore resolves to any step of its own container
 * (including a sibling `subprocess` statement, targetable by name like any
 * other step) and to nothing outside it — not an ancestor container, not a
 * sibling container's interior, and not another process entirely. Every other
 * cross-reference keeps Langium's default scope.
 *
 * A cross-boundary `goto` therefore fails to resolve; the resulting linker
 * diagnostic is upgraded to a boundary explanation by {@link
 * BpmnScriptLinker} rather than by an extra validator rule here.
 *
 * An `on` handler's `host=[Statement:ID]` reference gets the *same* treatment,
 * for the same BPMN reason: an event attached to a step is a flow element of
 * the container that step belongs to, so a host in another process, in a
 * sibling sub-process, or inside another handler's body is not attachable and
 * must not resolve. The candidate set is left at "the named steps of this
 * container" rather than narrowed to activities: a host naming a step that
 * cannot carry an attached event is a resolvable reference with a diagnosable
 * problem, and the validator can name what the step actually is — far more
 * actionable than the reference silently not resolving at all.
 *
 * A handler that carries a host is *transparent* to the container walk. Such a
 * handler does not wrap its body in a container of its own the way a host-less
 * one does; it lowers inline into the container its host lives in, so its body's
 * steps and the surrounding main flow share one container and one sequence-flow
 * scope. `enclosingFlowContainer` therefore walks straight past it, which makes
 * a `goto` legal in both directions across such a body — and, since the host
 * reference itself is resolved from that same container, keeps the host and the
 * handler's own body in exactly the scope relationship the lowering produces.
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
  isOnHandler,
  isProcess,
  isSubProcess,
  type OnHandler,
  type Process,
  type SubProcess,
} from './generated/ast.js';

/**
 * A `goto` target lives in a top-level `process`, a `subprocess`, or an `on`
 * handler body — a handler body is a full BPMN container for every
 * container-scoped rule, `goto` included. Exported so {@link BpmnScriptLinker}
 * (the boundary-diagnostic hook) can locate a resolved-elsewhere target's own
 * container without duplicating the walk.
 */
export type FlowContainer = Process | SubProcess | OnHandler;

export function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node) || isOnHandler(node);
}

/**
 * The nearest `process`/`subprocess` strictly enclosing `node` — i.e. the flow
 * container `node` itself lives in, found by walking `$container` upward
 * starting at `node.$container` (so `node` matching the predicate itself, as a
 * `SubProcess` statement would, does not short-circuit the walk).
 *
 * A handler carrying a host is skipped rather than returned: its body compiles
 * into the container its host lives in, not into a container of its own, so the
 * flow container of anything written inside it is that same outer container.
 */
export function enclosingFlowContainer(node: AstNode): FlowContainer | undefined {
  let container = AstUtils.getContainerOfType(node.$container, isFlowContainer);
  while (container && isOnHandler(container) && container.host !== undefined) {
    container = AstUtils.getContainerOfType(
      container.$container,
      isFlowContainer,
    );
  }
  return container;
}

/**
 * Whether this cross-reference is one of the two the language resolves against
 * the enclosing flow container rather than lexically: a `goto` target and an
 * `on` handler's host.
 */
function isContainerScoped(context: ReferenceInfo): boolean {
  return (
    (isGotoStatement(context.container) && context.property === 'target') ||
    (isOnHandler(context.container) && context.property === 'host')
  );
}

/**
 * Restricts `goto` and handler-host resolution to the enclosing
 * process/sub-process; delegates every other cross-reference to
 * {@link DefaultScopeProvider}.
 */
export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  /**
   * @param context The cross-reference for which a scope is requested.
   * @returns For the `goto` target and the handler host references, the named
   *   steps of the enclosing container (any nesting depth within it, no outer
   *   scope); otherwise the default scope.
   */
  override getScope(context: ReferenceInfo): Scope {
    if (isContainerScoped(context)) {
      // Started from the reference's container rather than from the node
      // itself: for a handler host the referencing node IS a flow container
      // candidate, and a scope taken from it would offer the handler's own body
      // instead of the container the host has to be attachable in.
      const container = enclosingFlowContainer(context.container);
      if (container) {
        // The reference type is `Statement`; keep only the named descendants
        // that are referenceable (its `Statement` subtypes), so process-scope
        // declarations such as `var` (which also carry a `name`) never pollute
        // the scope. `createScopeForNodes` drops the ones without a name.
        const referenceType = this.reflection.getReferenceType(context);
        const targets = AstUtils.streamAllContents(container).filter(
          (node) =>
            this.reflection.isSubtype(node.$type, referenceType) &&
            // A candidate counts only when THIS container is its own nearest
            // enclosing container — a step inside a nested `subprocess` or
            // host-less `on` handler body has that container as its nearest
            // container, not this one, so it is excluded (nesting isolation);
            // a step inside a *hosted* handler's body belongs to this
            // container and therefore passes, matching the inline lowering. A
            // `subprocess` statement sitting directly in this container
            // passes: its own nearest enclosing container (walking up from
            // its `$container`) is this container. An `on` handler itself
            // never passes as a candidate — it carries no `name`, so
            // `createScopeForNodes` drops it regardless of nesting depth.
            enclosingFlowContainer(node) === container,
        );
        // No outer scope: the reference sees only its own container's steps,
        // so a step of an ancestor container, a sibling container, or another
        // process entirely is unreachable by construction.
        return this.createScopeForNodes(targets);
      }
    }
    return super.getScope(context);
  }
}
