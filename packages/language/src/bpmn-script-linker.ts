/**
 * Boundary-explanation linker for `goto` and for an `on` handler's host: where
 * the name exists elsewhere in the process, Langium's stock "Could not resolve
 * reference" is replaced by a message naming the boundary that was crossed.
 * Replacing rather than adding keeps it at one diagnostic, and a validator
 * could not do the job: it only ever sees a `goto` that already resolved.
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
  isGotoStatement,
  isOnHandler,
  isProcess,
  isSubProcess,
  type OnHandler,
} from './generated/ast.js';
import {
  enclosingFlowContainer,
  isNamedStatement,
  type FlowContainer,
  type NamedStatement,
} from './bpmn-script-scope-provider.js';

/** First match wins: duplicate names are a validator error. */
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

/**
 * `undefined` when error recovery left the trigger empty. The enrichment names
 * the boundary it crossed, so with nothing to name it stands down and the
 * stock unresolved-reference message runs instead.
 */
function handlerPhrase(handler: OnHandler): string | undefined {
  if (handler.trigger === undefined) return undefined;

  const header = handler.code
    ? `on ${handler.trigger} "${handler.code}"`
    : `on ${handler.trigger}`;
  const article = handler.code ? 'the' : 'an';
  return `${article} '${header}' handler`;
}

/** `crossesHandler` picks the trailing boundary sentence. */
interface Location {
  phrase: string;
  crossesHandler: boolean;
}

/**
 * Where `target` lives relative to `sourceContainer`. Only called once the two
 * containers are known to differ, so exactly one branch applies. A handler
 * carrying a host is never reported: it is transparent to the container walk.
 */
function locateTarget(
  target: NamedStatement,
  sourceContainer: FlowContainer,
): Location | undefined {
  const targetContainer = enclosingFlowContainer(target);
  if (targetContainer && isSubProcess(targetContainer)) {
    return subprocessLocation(targetContainer.name, 'inside');
  }
  if (targetContainer && isOnHandler(targetContainer)) {
    return handlerLocation(targetContainer, 'inside');
  }
  // The target lives at process level; since it did not resolve, the
  // reference itself must be inside a subprocess or a handler body.
  if (isOnHandler(sourceContainer)) {
    return handlerLocation(sourceContainer, 'outside');
  }
  return subprocessLocation(sourceContainer.name, 'outside');
}

function subprocessLocation(
  name: string | undefined,
  side: 'inside' | 'outside',
): Location | undefined {
  return name === undefined
    ? undefined
    : { phrase: `${side} subprocess '${name}'`, crossesHandler: false };
}

function handlerLocation(
  handler: OnHandler,
  side: 'inside' | 'outside',
): Location | undefined {
  const phrase = handlerPhrase(handler);
  return phrase === undefined
    ? undefined
    : { phrase: `${side} ${phrase}`, crossesHandler: true };
}

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
      const located =
        target && sourceContainer
          ? locateTarget(target, sourceContainer)
          : undefined;
      if (located) {
        const { phrase, crossesHandler } = located;
        const boundary = isHost
          ? `a boundary event attaches to an activity in its own scope.`
          : crossesHandler
            ? `a goto cannot cross an event handler boundary: an event handler's steps run only when its event fires.`
            : `a goto cannot cross a subprocess boundary.`;
        return {
          info: refInfo,
          message: `'${refInfo.reference.$refText}' is ${phrase}; ${boundary}`,
        };
      }
    }
    return super.createLinkingError(refInfo, targetDescription);
  }
}
