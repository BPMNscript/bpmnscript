import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type {
  BpmnScriptAstType,
  Model,
  Process,
  SequenceFlow,
} from './generated/ast.js';
import {
  isEndEvent,
  isExclusiveGateway,
  isStartEvent,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';

/**
 * Register the structural BPMN validation checks for the BPMNscript language.
 *
 * Cross-reference resolution errors (unknown source/target ids, unknown
 * `default:` references) are produced automatically by Langium's default
 * linker — they do not need a dedicated check here.
 */
export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkSingleProcess,
    Process: validator.checkProcessStructure,
  };
  registry.register(checks, validator);
}

/**
 * Structural validator for BPMNscript processes.
 *
 * The checks here mirror the static structural rules a BPMN process must
 * satisfy before the AST -> IR -> XML pipeline can produce something an
 * Operaton engine will accept. They complement (rather than replace)
 * Langium's automatic cross-reference linking, which already reports any
 * `->` source/target id or gateway `default:` id that fails to resolve.
 */
export class BpmnScriptValidator {
  /**
   * BPMNscript supports one process per file. The grammar permits several so
   * that a stray second `process` block produces a clear diagnostic here
   * rather than being silently dropped by the AST -> IR transform, which only
   * converts the first process. Every process after the first is flagged.
   */
  checkSingleProcess(model: Model, accept: ValidationAcceptor): void {
    for (const extra of model.processes.slice(1)) {
      accept(
        'error',
        'Only one process is supported per file. ' +
          'Move additional processes into separate files.',
        { node: extra, property: 'name' },
      );
    }
  }

  /**
   * Run every structural check on a Process and report violations via
   * `accept`. Each violation produces exactly one error.
   */
  checkProcessStructure(process: Process, accept: ValidationAcceptor): void {
    this.checkHasStartEvent(process, accept);
    this.checkHasEndEvent(process, accept);
    this.checkNoOrphans(process, accept);
    this.checkGatewayDefaults(process, accept);
  }

  /** Every process must declare at least one start event. */
  private checkHasStartEvent(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    if (!process.nodes.some(isStartEvent)) {
      accept(
        'error',
        `Process '${process.name}' must declare at least one start event.`,
        {
          node: process,
          property: 'name',
        },
      );
    }
  }

  /** Every process must declare at least one end event. */
  private checkHasEndEvent(process: Process, accept: ValidationAcceptor): void {
    if (!process.nodes.some(isEndEvent)) {
      accept(
        'error',
        `Process '${process.name}' must declare at least one end event.`,
        {
          node: process,
          property: 'name',
        },
      );
    }
  }

  /**
   * Every declared flow node must appear as `source` or `target` of at
   * least one sequence flow.
   */
  private checkNoOrphans(process: Process, accept: ValidationAcceptor): void {
    const referenced = new Set<string>();
    for (const flow of process.flows) {
      const sourceName = flow.source.ref?.name;
      const targetName = flow.target.ref?.name;
      if (sourceName) referenced.add(sourceName);
      if (targetName) referenced.add(targetName);
    }
    for (const node of process.nodes) {
      if (!referenced.has(node.name)) {
        accept(
          'error',
          `Flow node '${node.name}' is not connected by any sequence flow.`,
          {
            node,
            property: 'name',
          },
        );
      }
    }
  }

  /**
   * For every gateway with a `default:` reference, the referenced flow
   * must (a) exist (handled by the linker), (b) have its `source` pointing
   * to the gateway itself, and (c) carry no `when:` condition — a default
   * flow is by definition the unconditional branch. Violations of (b) or
   * (c) would silently break runtime semantics, so we refuse them here.
   */
  private checkGatewayDefaults(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of process.nodes) {
      if (!isExclusiveGateway(node)) continue;
      const defaultFlow: SequenceFlow | undefined = node.default?.ref;
      if (!defaultFlow) continue;
      // Guard: only emit the "wrong source" error when the source reference
      // actually resolved. If it is unresolved, the linker has already
      // produced the primary "could not resolve" error and a secondary
      // error here would be misleading noise.
      if (defaultFlow.source.ref && defaultFlow.source.ref.name !== node.name) {
        accept(
          'error',
          `Gateway '${node.name}' default flow '${defaultFlow.name}' must originate from '${node.name}', ` +
            `but originates from '${defaultFlow.source.ref.name}'.`,
          { node, property: 'default' },
        );
      }
      // A default flow is the branch taken when no other condition holds, so
      // it must not itself carry a `when:` condition.
      if (defaultFlow.condition !== undefined) {
        accept(
          'error',
          `Gateway '${node.name}' default flow '${defaultFlow.name}' must not declare a 'when:' condition.`,
          { node: defaultFlow, property: 'condition' },
        );
      }
    }
  }
}
