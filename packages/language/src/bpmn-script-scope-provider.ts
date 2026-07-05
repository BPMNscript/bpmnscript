/**
 * Process-scoped cross-reference resolution for `goto`.
 *
 * A `goto target=[Statement:ID]` may only jump to a step *within the same
 * process*. Langium's stock scope provider makes a named step visible only to
 * references whose own container chain passes through that step's block (classic
 * block-lexical visibility), which is wrong for `goto` in two ways:
 *
 *   1. A step nested inside a `parallel`/`if`/`while` block is invisible to a
 *      `goto` positioned outside that block, so a legitimate whole-process jump
 *      target cannot resolve at all — and the "goto into a parallel branch"
 *      validator can never see a resolved target to flag.
 *   2. Nothing structurally guarantees a `goto` cannot reach into a *different*
 *      process should the global index ever start exporting step names.
 *
 * This provider replaces the scope for the `goto` target reference with the set
 * of every named step in the *enclosing process*, regardless of block nesting,
 * and with no global fall-through. A `goto` therefore resolves to any step of
 * its own process and to nothing outside it. Every other cross-reference keeps
 * Langium's default scope.
 *
 * The `NameProvider` still keys on the AST `name` property (see the grammar's
 * naming-convention comment); this provider only *narrows the candidate set*, it
 * does not change the key — so no custom `NameProvider` is needed.
 */

import {
  AstUtils,
  DefaultScopeProvider,
  type ReferenceInfo,
  type Scope,
} from 'langium';
import { isGotoStatement, isProcess } from './generated/ast.js';

/**
 * Restricts `goto` resolution to the enclosing process; delegates every other
 * cross-reference to {@link DefaultScopeProvider}.
 */
export class BpmnScriptScopeProvider extends DefaultScopeProvider {
  /**
   * @param context The cross-reference for which a scope is requested.
   * @returns For the `goto` target reference, the named steps of the enclosing
   *   process (any nesting depth, no outer scope); otherwise the default scope.
   */
  override getScope(context: ReferenceInfo): Scope {
    // Only the `goto` target reference is process-scoped; delegate the rest.
    if (isGotoStatement(context.container) && context.property === 'target') {
      const process = AstUtils.getContainerOfType(context.container, isProcess);
      if (process) {
        // The reference type is `Statement`; keep only the named descendants
        // that are goto-targetable (its `Statement` subtypes), so process-scope
        // declarations such as `var` (which also carry a `name`) never pollute
        // the goto scope. `createScopeForNodes` drops the ones without a name.
        const referenceType = this.reflection.getReferenceType(context);
        const targets = AstUtils.streamAllContents(process).filter((node) =>
          this.reflection.isSubtype(node.$type, referenceType),
        );
        // No outer scope: a goto sees only its own process's steps, so a step of
        // any other process is unreachable by construction.
        return this.createScopeForNodes(targets);
      }
    }
    return super.getScope(context);
  }
}
