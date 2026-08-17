/**
 * Container-scoped cross-reference resolution for `goto` and for an `on`
 * handler's host. Both see every named step of their own flow container (the
 * nearest enclosing `process`, `subprocess`, or handler body) at any block
 * nesting depth, and nothing outside it. Every other cross-reference keeps
 * Langium's default scope.
 *
 * Langium's stock block-lexical visibility is wrong for `goto` twice over: a
 * step nested in a `parallel`/`if`/`while` block would be invisible to a `goto`
 * outside that block even though the jump is legal, and nothing would stop a
 * jump into a different container. BPMN forbids a sequence flow from crossing a
 * sub-process boundary (an event handler being a kind of sub-process, this
 * includes it too), so `goto` must not synthesize one. A cross-boundary `goto`
 * therefore fails to resolve, and `bpmn-script-linker.ts` upgrades the
 * resulting diagnostic to a boundary explanation.
 *
 * A handler's host gets the same treatment for the same BPMN reason: an event
 * attached to a step is a flow element of the container that step belongs to.
 * The candidate set stays at "the named steps of this container" rather than
 * being narrowed to activities, so a host naming a step that cannot carry an
 * attached event still resolves and the validator can say what the step
 * actually is.
 *
 * A handler that carries a host is transparent to the container walk: it lowers
 * inline into the container its host lives in rather than wrapping its body in
 * a container of its own, so its steps and the surrounding main flow share one
 * container and one sequence-flow scope.
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
 * The containers a `goto` target or a handler host can live in. A handler body
 * counts as a full BPMN container for every container-scoped rule.
 */
export type FlowContainer = Process | SubProcess | OnHandler;

export function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node) || isOnHandler(node);
}

/**
 * The flow container `node` itself lives in. The walk starts at
 * `node.$container` so a node that is a container in its own right, as a
 * `SubProcess` statement is, does not short-circuit it.
 *
 * A handler carrying a host is skipped rather than returned: its body compiles
 * into the container its host lives in, not into a container of its own.
 */
export function enclosingFlowContainer(
  node: AstNode,
): FlowContainer | undefined {
  let container = AstUtils.getContainerOfType(node.$container, isFlowContainer);
  while (container && isOnHandler(container) && container.host !== undefined) {
    container = AstUtils.getContainerOfType(
      container.$container,
      isFlowContainer,
    );
  }
  return container;
}

/** The two cross-references resolved against the enclosing flow container. */
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
            // one, which isolates a nested `subprocess` or host-less handler
            // body. A step inside a hosted handler's body passes, matching the
            // inline lowering.
            enclosingFlowContainer(node) === container,
        );
        // No outer scope: an ancestor container, a sibling container, or
        // another process entirely is unreachable by construction.
        return this.createScopeForNodes(targets);
      }
    }
    return super.getScope(context);
  }
}
