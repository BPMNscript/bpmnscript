/**
 * Boundary-explanation linker for `goto` and for an `on` handler's host.
 *
 * Both references are container-scoped, so naming a step that lives in another
 * flow container fails to resolve and Langium's stock message, "Could not
 * resolve reference to Statement named 'X'.", reads as "X doesn't exist" when X
 * does exist. This linker replaces that message with a boundary explanation
 * whenever the name is found elsewhere in the enclosing process; every other
 * case delegates to `super`.
 *
 * Replacing rather than adding keeps it at one diagnostic. A validator could
 * not do the job anyway: it only ever sees a `goto` whose target already
 * resolved.
 */

import {
  AstUtils,
  DefaultLinker,
  type AstNode,
  type AstNodeDescription,
  type LinkingError,
  type ReferenceInfo,
} from 'langium';
import {
  isCallActivity,
  isEmitStatement,
  isEndEvent,
  isGotoStatement,
  isOnHandler,
  isProcess,
  isScriptTask,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isThrowStatement,
  isUserTask,
  type CallActivity,
  type EmitStatement,
  type EndEvent,
  type OnHandler,
  type ScriptTask,
  type ServiceTask,
  type StartEvent,
  type SubProcess,
  type ThrowStatement,
  type UserTask,
} from './generated/ast.js';
import {
  enclosingFlowContainer,
  type FlowContainer,
} from './bpmn-script-scope-provider.js';

/**
 * The `Statement` subtypes that carry a `name` and are therefore valid `goto`
 * targets. A `ThrowStatement`/`EmitStatement` name is optional (synthesised
 * when omitted), so an unnamed one is never a target.
 */
type NamedStatement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | SubProcess
  | CallActivity
  | (ThrowStatement & { name: string })
  | (EmitStatement & { name: string });

function isNamedStatement(node: AstNode): node is NamedStatement {
  return (
    isStartEvent(node) ||
    isEndEvent(node) ||
    isUserTask(node) ||
    isServiceTask(node) ||
    isScriptTask(node) ||
    isSubProcess(node) ||
    isCallActivity(node) ||
    ((isThrowStatement(node) || isEmitStatement(node)) &&
      node.name !== undefined)
  );
}

/**
 * The first named statement in `process` with this name, at any container or
 * nesting depth. First match wins: duplicate names are a validator error.
 */
function findNamedStatement(
  process: AstNode,
  name: string,
): NamedStatement | undefined {
  for (const node of AstUtils.streamAst(process)) {
    if (isNamedStatement(node) && node.name === name) {
      return node;
    }
  }
  return undefined;
}

/** The handler's header as an author would write it, used in place of a name. */
function handlerHeader(handler: OnHandler): string {
  return handler.code
    ? `on ${handler.trigger} "${handler.code}"`
    : `on ${handler.trigger}`;
}

/** A handler referred to by its header: `the 'on error "X"' handler`. */
function handlerPhrase(handler: OnHandler): string {
  const article = handler.code ? 'the' : 'an';
  return `${article} '${handlerHeader(handler)}' handler`;
}

/** Whether crossing this location involves an event-handler boundary rather
 * than only a sub-process one, which decides the trailing boundary sentence. */
interface Location {
  phrase: string;
  crossesHandler: boolean;
}

/**
 * Describe where `target` lives relative to `sourceContainer`, the flow
 * container the unresolved reference sits in. Only called once the two
 * containers are known to differ, so exactly one branch applies.
 *
 * A handler carrying a host is never reported here: it is transparent to the
 * container walk, so it is neither a container a target can sit in nor one a
 * reference can sit in.
 */
function locateTarget(
  target: NamedStatement,
  sourceContainer: FlowContainer,
): Location {
  const targetContainer = enclosingFlowContainer(target);
  if (targetContainer && isSubProcess(targetContainer)) {
    return {
      phrase: `inside subprocess '${targetContainer.name}'`,
      crossesHandler: false,
    };
  }
  if (targetContainer && isOnHandler(targetContainer)) {
    return {
      phrase: `inside ${handlerPhrase(targetContainer)}`,
      crossesHandler: true,
    };
  }
  // The target lives at process level; since it did not resolve, the
  // reference itself must be inside a sub-process or a handler body.
  if (isOnHandler(sourceContainer)) {
    return {
      phrase: `outside ${handlerPhrase(sourceContainer)}`,
      crossesHandler: true,
    };
  }
  return {
    phrase: `outside subprocess '${sourceContainer.name}'`,
    crossesHandler: false,
  };
}

/**
 * Upgrades the unresolved-`goto`-target and unresolved-handler-host messages to
 * a boundary explanation.
 */
export class BpmnScriptLinker extends DefaultLinker {
  override createLinkingError(
    refInfo: ReferenceInfo,
    targetDescription?: AstNodeDescription,
  ): LinkingError {
    const source = refInfo.container;
    const isHost = isOnHandler(source) && refInfo.property === 'host';
    const isGotoTarget =
      isGotoStatement(source) && refInfo.property === 'target';
    if (isHost || isGotoTarget) {
      const process = AstUtils.getContainerOfType(source, isProcess);
      const target = process
        ? findNamedStatement(process, refInfo.reference.$refText)
        : undefined;
      const sourceContainer = enclosingFlowContainer(source);
      if (target && sourceContainer) {
        const { phrase, crossesHandler } = locateTarget(
          target,
          sourceContainer,
        );
        const boundary = isHost
          ? `a boundary event attaches to an activity in its own scope.`
          : crossesHandler
            ? `a goto cannot cross an event handler boundary: an event handler's steps run only when its event fires.`
            : `a goto cannot cross a sub-process boundary.`;
        return {
          info: refInfo,
          message: `'${refInfo.reference.$refText}' is ${phrase}; ${boundary}`,
        };
      }
    }
    return super.createLinkingError(refInfo, targetDescription);
  }
}
