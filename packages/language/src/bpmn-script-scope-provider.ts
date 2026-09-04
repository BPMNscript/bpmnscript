/**
 * Container-scoped resolution for `goto` and for an `on` handler's host: both
 * see every named step of their own flow container at any nesting depth and
 * nothing outside it. Every other cross-reference keeps Langium's default.
 *
 * Langium's stock block-lexical visibility is wrong for `goto` twice over: a
 * step nested in a `parallel`/`if`/`while` block would be invisible to a legal
 * `goto` outside it, and nothing would stop a jump into a different container.
 * BPMN forbids a sequence flow from crossing a subprocess boundary, an event
 * handler included, so a cross-boundary `goto` must fail to resolve;
 * `bpmn-script-linker.ts` turns that into a boundary explanation.
 *
 * The host candidates stay at "the named steps of this container" rather than
 * narrowing to activities, so a host naming a step that cannot carry an
 * attached event still resolves and the validator can say what it is.
 */

import {
  AstUtils,
  DefaultScopeProvider,
  type AstNode,
  type ReferenceInfo,
  type Scope,
} from 'langium';
import {
  isBusinessRuleTask,
  isCallActivity,
  isEmitStatement,
  isEndEvent,
  isGenericTask,
  isGotoStatement,
  isOnHandler,
  isProcess,
  isReceiveTask,
  isScriptTask,
  isSendTask,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isThrowStatement,
  isUserTask,
  type BusinessRuleTask,
  type CallActivity,
  type EmitStatement,
  type EndEvent,
  type GenericTask,
  type OnHandler,
  type Process,
  type ReceiveTask,
  type ScriptTask,
  type SendTask,
  type ServiceTask,
  type StartEvent,
  type SubProcess,
  type ThrowStatement,
  type UserTask,
} from './generated/ast.js';

/**
 * The `Statement` subtypes carrying a `name`, so the valid `goto` targets and
 * handler hosts. A `throw`/`emit` name is optional (the id is synthesized when
 * omitted), so an unnamed one is neither referenceable nor able to collide.
 */
export type NamedStatement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | GenericTask
  | SendTask
  | ReceiveTask
  | BusinessRuleTask
  | SubProcess
  | CallActivity
  | (ThrowStatement & { name: string })
  | (EmitStatement & { name: string });

export function isNamedStatement(node: AstNode): node is NamedStatement {
  return (
    isStartEvent(node) ||
    isEndEvent(node) ||
    isUserTask(node) ||
    isServiceTask(node) ||
    isScriptTask(node) ||
    isGenericTask(node) ||
    isSendTask(node) ||
    isReceiveTask(node) ||
    isBusinessRuleTask(node) ||
    isSubProcess(node) ||
    isCallActivity(node) ||
    ((isThrowStatement(node) || isEmitStatement(node)) &&
      node.name !== undefined)
  );
}

/** A handler body counts as a full BPMN container for every container-scoped rule. */
export type FlowContainer = Process | SubProcess | OnHandler;

export function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node) || isOnHandler(node);
}

/**
 * The flow container `node` lives in. The walk starts at `node.$container` so a
 * node that is itself a container does not short-circuit it. A handler carrying
 * a host is skipped: its body compiles into its host's container, so its steps
 * and the surrounding main flow share one sequence-flow scope.
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

function isContainerScoped(context: ReferenceInfo): boolean {
  return (
    (isGotoStatement(context.container) && context.property === 'target') ||
    (isOnHandler(context.container) && context.property === 'host')
  );
}

export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  override getScope(context: ReferenceInfo): Scope {
    if (isContainerScoped(context)) {
      // From the reference's container, not the node itself: a handler naming
      // a host is a container, and a scope taken from it would offer the
      // handler's own body instead of its host's surroundings.
      const container = enclosingFlowContainer(context.container);
      if (container) {
        // The reference type is `Statement`, so process-scope declarations
        // such as `var`, which also carry a `name`, are filtered out here.
        const referenceType = this.reflection.getReferenceType(context);
        const targets = AstUtils.streamAllContents(container).filter(
          (node) =>
            this.reflection.isSubtype(node.$type, referenceType) &&
            // Only where this container is the candidate's own nearest one,
            // isolating a nested `subprocess` or host-less handler body.
            enclosingFlowContainer(node) === container,
        );
        // No outer scope: anything beyond this container is unreachable.
        return this.createScopeForNodes(targets);
      }
    }
    return super.getScope(context);
  }
}
