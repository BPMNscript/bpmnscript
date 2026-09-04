export type {
  FlowContainer,
  BpmnProcess,
  FlowElement,
  StartEvent,
  EndEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  Task,
  ReceiveTask,
  ExclusiveGateway,
  ParallelGateway,
  InclusiveGateway,
  EventBasedGateway,
  Gateway,
  SubProcess,
  CallActivity,
  VersionBinding,
  CallVariableMapping,
  SequenceFlow,
  EventDefinition,
  IntermediateThrowEvent,
  IntermediateCatchEvent,
  BoundaryEvent,
  EngineAttributes,
  IoMapped,
  LoopCharacteristics,
  Repeatable,
  IoParameter,
  IoValue,
  ListenerBinding,
  ExecutionListener,
  TaskListener,
} from './ir/types.js';

export { isGateway, gatewayDefaultFlowId } from './ir/types.js';

export {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayRaceId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  makeBoundaryEventId,
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
  UnsupportedFormFieldTypeError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedCollaborationError,
  UnsupportedCallActivityError,
  UnsupportedExtensionFormError,
} from './errors.js';

export { astToIr } from './ast-to-ir.js';
export { irToDsl, UNSTRUCTURED_MARKER } from './ir-to-dsl.js';
export type { PrintWarning, PrintWarningCategory } from './ir-to-dsl.js';
