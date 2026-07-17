/**
 * Boundary-explanation linker for `goto`.
 *
 * The container-scoped `goto` resolution ({@link BpmnScriptScopeProvider})
 * means a `goto` whose target lies in a different flow container — the
 * process instead of a sub-process, another sub-process, or a nested one — is
 * *unresolved*. Langium's stock linker message for that case, "Could not
 * resolve reference to Statement named 'X'.", reads as "X doesn't exist" when
 * X *does* exist, just across a `subprocess` boundary — the most likely
 * authoring mistake with the new construct, and inline IDE errors are a core
 * value of the DSL.
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
  isEndEvent,
  isExternalTask,
  isGotoStatement,
  isProcess,
  isScriptTask,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isUserTask,
  type EndEvent,
  type ExternalTask,
  type ScriptTask,
  type ServiceTask,
  type StartEvent,
  type SubProcess,
  type UserTask,
} from './generated/ast.js';
import {
  enclosingFlowContainer,
  type FlowContainer,
} from './bpmn-script-scope-provider.js';

/**
 * The concrete `Statement` subtypes that carry a `name` and are therefore
 * valid `goto` targets — mirrors the validator's `NamedStatement` set, plus
 * `SubProcess` (a sub-process's own name is a goto target too, per the
 * grammar's naming convention).
 */
type NamedStatement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ExternalTask
  | ScriptTask
  | SubProcess;

function isNamedStatement(node: AstNode): node is NamedStatement {
  return (
    isStartEvent(node) ||
    isEndEvent(node) ||
    isUserTask(node) ||
    isServiceTask(node) ||
    isExternalTask(node) ||
    isScriptTask(node) ||
    isSubProcess(node)
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
 * Describe where `target` lives relative to `gotoContainer`, the flow
 * container the `goto` itself sits in. Only called once the caller has
 * already established the two containers differ (the scope provider would
 * have resolved a same-container target), so exactly one of the two branches
 * below applies: the target is inside some sub-process (which cannot be
 * `gotoContainer`, since that would have resolved), or the target sits at
 * process level while the goto is inside a sub-process.
 */
function locationPhrase(
  target: NamedStatement,
  gotoContainer: FlowContainer,
): string {
  const targetContainer = enclosingFlowContainer(target);
  if (targetContainer && isSubProcess(targetContainer)) {
    return `inside subprocess '${targetContainer.name}'`;
  }
  // The target lives at process level; since it did not resolve, the goto
  // itself must be inside a sub-process (`Process` and `SubProcess` both
  // expose `name`, so no further narrowing is needed to read it).
  return `outside subprocess '${gotoContainer.name}'`;
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
        return {
          info: refInfo,
          message: `'${refInfo.reference.$refText}' is ${locationPhrase(target, gotoContainer)}; a goto cannot cross a sub-process boundary.`,
        };
      }
    }
    return super.createLinkingError(refInfo, targetDescription);
  }
}
