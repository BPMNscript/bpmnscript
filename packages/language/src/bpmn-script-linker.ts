/**
 * Boundary-explanation linker for `goto`.
 *
 * The container-scoped `goto` resolution ({@link BpmnScriptScopeProvider})
 * means a `goto` whose target lies in a different flow container — the
 * process instead of a sub-process, another sub-process, a nested one, or an
 * `on` handler body (in either direction) — is *unresolved*. Langium's stock
 * linker message for that case, "Could not resolve reference to Statement
 * named 'X'.", reads as "X doesn't exist" when X *does* exist, just across a
 * container boundary — the most likely authoring mistake with the new
 * construct, and inline IDE errors are a core value of the DSL.
 *
 * This linker overrides {@link DefaultLinker.createLinkingError}, the single
 * hook every unresolved-reference path in `DefaultLinker` already funnels
 * through, and *replaces* the generic message with a boundary explanation
 * when the goto's target name exists elsewhere in the enclosing process — one
 * message replacing another is exactly one diagnostic, by construction. Every
 * other case (the name exists nowhere, or the reference is not a `goto`
 * target) delegates to `super`, so the generic message stays byte-identical.
 *
 * A validator rule cannot do this instead: `checkGotoStatement` only sees a
 * `goto` once its `target` is *resolved* (it reads `goto.target.ref`, guarded
 * by `if (target)`), so a validator addressing the unresolved case would
 * either never fire (guarded, same as today) or read `target.ref` unguarded
 * and stack a second diagnostic on top of the linker's — the double-error
 * trap this design sidesteps by replacing rather than adding.
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
  isExternalTask,
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
  type ExternalTask,
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
 * The concrete `Statement` subtypes that carry a `name` and are therefore
 * valid `goto` targets — mirrors the validator's `NamedStatement` set:
 * `SubProcess` and `CallActivity` (their own names are goto targets too), and
 * `ThrowStatement`/`EmitStatement`, whose `name` is *optional* (synthesised
 * when omitted), so an unnamed throw/emit is skipped by the `name` guard below
 * and is never a goto target.
 */
type NamedStatement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ExternalTask
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
    isExternalTask(node) ||
    isScriptTask(node) ||
    isSubProcess(node) ||
    isCallActivity(node) ||
    ((isThrowStatement(node) || isEmitStatement(node)) &&
      node.name !== undefined)
  );
}

/**
 * The first named statement in `process` (any container, any nesting depth)
 * whose name is `name`, or `undefined` if none exists. First match wins —
 * duplicate names are themselves a validator error, so this never needs to
 * disambiguate.
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

/**
 * The handler's header as an author would write it — `on <trigger>` for a
 * catch-all, `on <trigger> "<code>"` for a coded one — used in place of a
 * name, since a handler has none.
 */
function handlerHeader(handler: OnHandler): string {
  return handler.code
    ? `on ${handler.trigger} "${handler.code}"`
    : `on ${handler.trigger}`;
}

/**
 * A handler referred to by its header: `the 'on error "X"' handler` for a
 * coded one, `an 'on error' handler` for a catch-all.
 */
function handlerPhrase(handler: OnHandler): string {
  const article = handler.code ? 'the' : 'an';
  return `${article} '${handlerHeader(handler)}' handler`;
}

/** Whether crossing this location involves an event-handler boundary rather
 * than (only) a sub-process one — decides the trailing boundary sentence. */
interface Location {
  phrase: string;
  crossesHandler: boolean;
}

/**
 * Describe where `target` lives relative to `gotoContainer`, the flow
 * container the `goto` itself sits in. Only called once the caller has
 * already established the two containers differ (the scope provider would
 * have resolved a same-container target), so exactly one of the branches
 * below applies: the target is inside some sub-process or handler body
 * (neither of which can be `gotoContainer`, since that would have resolved),
 * or the target sits at process level while the goto is inside a sub-process
 * or a handler body.
 */
function locateTarget(
  target: NamedStatement,
  gotoContainer: FlowContainer,
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
  // The target lives at process level; since it did not resolve, the goto
  // itself must be inside a sub-process or a handler body.
  if (isOnHandler(gotoContainer)) {
    return {
      phrase: `outside ${handlerPhrase(gotoContainer)}`,
      crossesHandler: true,
    };
  }
  return {
    phrase: `outside subprocess '${gotoContainer.name}'`,
    crossesHandler: false,
  };
}

/**
 * `DefaultLinker` subclass that upgrades the unresolved-`goto`-target message
 * to a boundary explanation (see module docstring).
 */
export class BpmnScriptLinker extends DefaultLinker {
  override createLinkingError(
    refInfo: ReferenceInfo,
    targetDescription?: AstNodeDescription,
  ): LinkingError {
    if (isGotoStatement(refInfo.container) && refInfo.property === 'target') {
      const goto = refInfo.container;
      const process = AstUtils.getContainerOfType(goto, isProcess);
      const target = process
        ? findNamedStatement(process, refInfo.reference.$refText)
        : undefined;
      const gotoContainer = enclosingFlowContainer(goto);
      if (target && gotoContainer) {
        const { phrase, crossesHandler } = locateTarget(target, gotoContainer);
        const boundary = crossesHandler
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
