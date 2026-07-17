/**
 * Public API of the `@bpmn-script/transform` package.
 *
 * All transforms are exported here: IR types, IR → XML, XML → IR,
 * AST → IR, and IR → DSL.
 *
 * Note on `bpmn-auto-layout` version: this package depends on
 * `bpmn-auto-layout@^1.2.0` rather than `0.3.x`.
 * `bpmn-auto-layout@0.3.x` pulls `bpmn-moddle@^8`, which conflicts with
 * our hard-locked `bpmn-moddle@^10`. Version 1.x uses `bpmn-moddle@^10`
 * and exposes a flat `layoutProcess(xml)` named export (instead of the
 * `new BpmnAutoLayout().layoutProcess(xml)` constructor API of 0.x).
 */

export type {
  BpmnProcess,
  FlowElement,
  StartEvent,
  EndEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  ExclusiveGateway,
  ParallelGateway,
  SequenceFlow,
} from './ir/types.js';

export {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  resolveCollision,
} from './synthesize-ids.js';

export { parseJuel, renderRawFallback } from './juel.js';
export type { JuelNode, Accessor, BinaryOp, ExprResult } from './juel.js';

export { irToXml, type IrToXmlOptions } from './ir-to-xml.js';
export { xmlToIr } from './xml-to-ir.js';
export type { ImportWarning, ImportWarningCategory } from './xml-to-ir.js';
export {
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedServiceTaskFormError,
  UnsupportedEventDefinitionError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedCollaborationError,
} from './errors.js';

export { astToIr } from './ast-to-ir.js';
export { irToDsl } from './ir-to-dsl.js';

/**
 * Runtime-visible list of all IR type names exported from this package.
 * Useful for introspection and validates that the module loaded correctly.
 */
export const IR_TYPE_NAMES = [
  'BpmnProcess',
  'FlowElement',
  'StartEvent',
  'EndEvent',
  'UserTask',
  'ServiceTask',
  'ScriptTask',
  'ExclusiveGateway',
  'ParallelGateway',
  'SequenceFlow',
] as const;
