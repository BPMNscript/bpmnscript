/**
 * A `goto` and an `on` handler's host see every named step of their own flow
 * container at any nesting depth and nothing outside it. A code reference, an
 * event's payload or the code slot of an `error ... when` mapping, sees the
 * process's declarations of its own kind in a code position and nothing
 * anywhere else.
 *
 * Langium's block-lexical default is wrong for `goto` twice over: a step
 * nested in a `parallel`/`if`/`while` block would be invisible to a legal
 * `goto` outside it, and nothing would stop a jump into another container,
 * which BPMN forbids for a subprocess and an event handler alike. The host
 * candidates are not narrowed to activities, so a host naming a step that
 * cannot carry an attached event still resolves and the validator can say
 * what it is. Langium's precomputed scopes are not consulted for a code
 * reference: they would resolve `if (PAYMENT_DECLINED)` to the declaration
 * and offer every code as a completion wherever an expression is legal.
 */

import {
  AstUtils,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type AstNode,
  type ReferenceInfo,
  type Scope,
} from 'langium';
import { codeTriggerOf } from './paren-items.js';
import {
  isBusinessRuleTask,
  isCallActivity,
  isCodeDecl,
  isEmitStatement,
  isEndEvent,
  isErrorMapping,
  isGenericTask,
  isIntermediateCatchEvent,
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
  isVarRef,
  type BusinessRuleTask,
  type CallActivity,
  type EmitStatement,
  type EndEvent,
  type GenericTask,
  type IntermediateCatchEvent,
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
 * The `Statement` subtypes carrying a `name`: the `goto` targets and handler
 * hosts. An unnamed `throw`/`emit`/`await` gets a synthesized id, so it is
 * neither referenceable nor able to collide.
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
  | (EmitStatement & { name: string })
  | (IntermediateCatchEvent & { name: string });

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
      node.name !== undefined) ||
    (isIntermediateCatchEvent(node) && node.name !== undefined)
  );
}

/** A handler body counts as a full BPMN container for every container-scoped rule. */
export type FlowContainer = Process | SubProcess | OnHandler;

function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node) || isOnHandler(node);
}

/**
 * The flow container `node` lives in, starting at `node.$container` so a
 * container does not answer itself. A hosted handler is skipped: its body
 * compiles into its host's container, so its steps and the main flow share one
 * sequence-flow scope.
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

/**
 * The grammar has four cross-references, `VarRef.ref`, `ErrorMapping.code`,
 * `GotoStatement.target` and `OnHandler.host`, and every one of them sits
 * under a `Process` (a completion stand-in hangs off a parsed node), so
 * neither branch has a default to fall back to.
 */
export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  override getScope(context: ReferenceInfo): Scope {
    if (isVarRef(context.container) || isErrorMapping(context.container)) {
      // Never the default scope: it would resolve the name against every
      // declaration of both kinds, so a mapping headed by a word that names no
      // code gets nothing, as a `VarRef` outside a code position does.
      const trigger = codeTriggerOf(context.container);
      if (trigger === undefined) return EMPTY_SCOPE;
      // No outer scope: a declaration of another process, or of the other
      // kind, is out of reach. An error and an escalation are separate event
      // definitions even under one code, so `escalation(X)` naming an error
      // has to fail rather than reach the XML as a second root.
      const process = AstUtils.getContainerOfType(
        context.container,
        isProcess,
      )!;
      return this.createScopeForNodes(
        process.decls.filter(
          (decl) => isCodeDecl(decl) && decl.kind === trigger,
        ),
      );
    }
    // From the reference's container, not the node itself: a handler naming a
    // host is a container, and a scope taken from it would offer the handler's
    // own body instead of its host's surroundings.
    const container = enclosingFlowContainer(context.container)!;
    // The reference type is `Statement`, so process-scope declarations such
    // as `var`, which also carry a `name`, are filtered out here.
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
