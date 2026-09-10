/**
 * Boundary-explanation linker for `goto` and for an `on` handler's host: where
 * the name exists elsewhere in the process, Langium's stock "Could not resolve
 * reference" is replaced by a message naming the boundary crossed. A validator
 * could not do the job: it only ever sees a `goto` that already resolved. An
 * undeclared code is reworded here for the same reason.
 *
 * Rewording is all a linker can do. `doLink` stores the error on the reference
 * and lists the reference either way, so whether the error becomes a diagnostic
 * is decided in `bpmn-script-document-validator.ts`.
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
  isCodeDecl,
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
import { codeTriggerOf, payloadTextOf } from './paren-items.js';

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
 * `undefined` when error recovery left the trigger empty: with no boundary to
 * name, the stock unresolved-reference message runs instead.
 */
function handlerPhrase(handler: OnHandler): string | undefined {
  if (handler.trigger === undefined) return undefined;

  const code = payloadTextOf(handler.items);
  const header = code
    ? `on ${handler.trigger}(${code})`
    : `on ${handler.trigger}`;
  const article = code ? 'the' : 'an';
  return `${article} '${header}' handler`;
}

/**
 * The kind a declaration of `name` in the enclosing process was written under,
 * or `undefined` where the process declares no such name.
 */
function declaredCodeKind(source: AstNode, name: string): string | undefined {
  const process = AstUtils.getContainerOfType(source, isProcess);
  const decls = process?.decls.filter(isCodeDecl) ?? [];
  return decls.find((decl) => decl.name === name)?.kind;
}

/** `crossesHandler` picks the trailing boundary sentence. */
interface Location {
  phrase: string;
  crossesHandler: boolean;
}

/**
 * Where `target` lives relative to `sourceContainer`, called once the two are
 * known to differ. A handler carrying a host is never reported: the container
 * walk passes through it.
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
    const codeTrigger = codeTriggerOf(source);
    if (codeTrigger !== undefined) {
      const name = refInfo.reference.$refText;
      // The scope holds this kind's declarations only, so a name declared
      // under the other kind arrives here unresolved. Saying it is undeclared
      // would be false, and advising a second declaration of that name would
      // walk the author into the duplicate-name error.
      const declaredKind = declaredCodeKind(source, name);
      const message =
        declaredKind === undefined
          ? `'${name}' is not declared. Add '${codeTrigger} ${name}' to the process.`
          : `'${name}' is declared as an ${declaredKind}, not an ${codeTrigger}.`;
      return { info: refInfo, message };
    }
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
