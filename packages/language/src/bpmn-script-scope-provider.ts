/**
 * A `goto` or handler host sees every named step of its own flow container at
 * any depth and nothing outside; Langium's block-lexical default would hide a
 * nested step and allow jumps into another container. A code reference sees
 * only its process's declarations of its kind; the precomputed scopes would
 * resolve `if (PAYMENT_DECLINED)` and offer codes in every expression.
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
 * An unnamed `throw`/`emit`/`await` gets a synthesized id, so it cannot be
 * referenced or collide.
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

export type FlowContainer = Process | SubProcess | OnHandler;

function isFlowContainer(node: AstNode): node is FlowContainer {
  return isProcess(node) || isSubProcess(node) || isOnHandler(node);
}

/**
 * Starts at `node.$container`. A hosted handler is skipped: its body compiles
 * into its host's container.
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

/** All four cross-references sit under a `Process`, so neither branch falls back to the default. */
export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  override getScope(context: ReferenceInfo): Scope {
    if (isVarRef(context.container) || isErrorMapping(context.container)) {
      // Never the default scope, which would resolve against both kinds.
      const trigger = codeTriggerOf(context.container);
      if (trigger === undefined) return EMPTY_SCOPE;
      // No outer scope: `escalation(X)` naming an error must fail, not become a second root.
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
    // From the reference's container: a handler is itself a container.
    const container = enclosingFlowContainer(context.container)!;
    // The reference type `Statement` filters out `var`s, which carry a `name` too.
    const referenceType = this.reflection.getReferenceType(context);
    const targets = AstUtils.streamAllContents(container).filter(
      (node) =>
        this.reflection.isSubtype(node.$type, referenceType) &&
        // Isolates a nested `subprocess` or host-less handler body.
        enclosingFlowContainer(node) === container,
    );
    return this.createScopeForNodes(targets);
  }
}
