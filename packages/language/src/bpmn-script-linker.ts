/**
 * Rewords Langium's resolution failure, which names the grammar type: the
 * boundary a `goto` or host crosses, or how to declare a missing code. A
 * validator cannot, since it only sees resolved references.
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
import { diagnosticText, printName } from './vocabulary.js';

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

function handlerPhrase(handler: OnHandler): string | undefined {
  if (handler.trigger === undefined) return undefined;

  const code = payloadTextOf(handler.items);
  const header = code
    ? `on ${handler.trigger}(${code})`
    : `on ${handler.trigger}`;
  const article = code ? 'the' : 'an';
  return `${article} '${header}' handler`;
}

function declaredCodeKind(source: AstNode, name: string): string | undefined {
  const process = AstUtils.getContainerOfType(source, isProcess);
  const decls = process?.decls.filter(isCodeDecl) ?? [];
  return decls.find((decl) => decl.name === name)?.kind;
}

interface Location {
  phrase: string;
  crossesHandler: boolean;
}

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
  // It did not resolve, so the reference sits inside a subprocess or handler body.
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
    const name = refInfo.reference.$refText;
    const codeTrigger = codeTriggerOf(source);
    if (codeTrigger !== undefined) {
      // Advising a second declaration under the other kind would lead to the duplicate-name error.
      const declaredKind = declaredCodeKind(source, name);
      const message =
        declaredKind === undefined
          ? diagnosticText(
              `'${name}' is not declared`,
              `help: add '${codeTrigger} ${printName(name)}' to the process`,
            )
          : `'${name}' is declared as an ${declaredKind}, not an ${codeTrigger}`;
      return { info: refInfo, message };
    }
    const isHost = isOnHandler(source) && refInfo.property === 'host';
    const isGotoTarget =
      isGotoStatement(source) && refInfo.property === 'target';
    if (isHost || isGotoTarget) {
      const process = AstUtils.getContainerOfType(source, isProcess);
      const target = process ? findNamedStatement(process, name) : undefined;
      if (process && !target) {
        const message = isHost
          ? `no step named '${name}' in this process to attach to`
          : `no step named '${name}' in this process`;
        return { info: refInfo, message };
      }
      const sourceContainer = enclosingFlowContainer(source);
      const located =
        target && sourceContainer
          ? locateTarget(target, sourceContainer)
          : undefined;
      if (located) {
        const { phrase, crossesHandler } = located;
        const boundary = isHost
          ? ['note: a boundary event attaches to an activity in its own scope']
          : crossesHandler
            ? [
                'note: a goto cannot cross an event handler boundary',
                "note: an event handler's steps run only when its event fires",
              ]
            : ['note: a goto cannot cross a subprocess boundary'];
        return {
          info: refInfo,
          message: diagnosticText(`'${name}' is ${phrase}`, ...boundary),
        };
      }
    }
    // Langium's own wording names the grammar type the reference expects.
    return {
      ...super.createLinkingError(refInfo, targetDescription),
      message: `nothing named '${name}' is in reach here`,
    };
  }
}
