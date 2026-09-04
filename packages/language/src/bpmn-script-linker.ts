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

function handlerHeader(handler: OnHandler): string {
  return handler.code
    ? `on ${handler.trigger} "${handler.code}"`
    : `on ${handler.trigger}`;
}

function handlerPhrase(handler: OnHandler): string {
  const article = handler.code ? 'the' : 'an';
  return `${article} '${handlerHeader(handler)}' handler`;
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
