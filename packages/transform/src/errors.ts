/**
 * Error classes raised by the transform package.
 *
 * Co-located in a dedicated module so that consumers (CLI, tests, other
 * transforms) can `import { UnsupportedElementError } from
 * '@bpmn-script/transform'` without pulling in the parser.
 */

/**
 * Thrown by {@link xmlToIr} when a BPMN service task uses an execution
 * discriminator that the IR cannot represent.
 *
 * Only the Java-class pattern (`operaton:class` or the deprecated
 * `camunda:class` alias) is supported. Tasks using `operaton:expression`,
 * `operaton:delegateExpression`, `operaton:type`, or no discriminator at
 * all are refused on import so silent semantic loss is impossible.
 *
 * The error message names the offending construct so callers can surface
 * a useful diagnostic to the user.
 */
export class UnsupportedServiceTaskFormError extends Error {
  /** The BPMN id of the service task that triggered the error. */
  readonly serviceTaskId: string;
  /**
   * The detected execution discriminator (e.g. `operaton:expression`), or
   * the string `"no execution discriminator"` when the task carries none
   * of the recognised forms.
   */
  readonly construct: string;

  constructor(serviceTaskId: string, construct: string) {
    super(
      `Service task '${serviceTaskId}' uses unsupported execution form: ${construct}. ` +
        'Only operaton:class (or the deprecated camunda:class alias) is supported.',
    );
    this.name = 'UnsupportedServiceTaskFormError';
    this.serviceTaskId = serviceTaskId;
    this.construct = construct;
  }
}

/**
 * Thrown by {@link xmlToIr} when the input BPMN contains a flow element
 * kind that lies outside the supported subset.
 *
 * The supported subset is `bpmn:startEvent`, `bpmn:endEvent`,
 * `bpmn:userTask`, `bpmn:serviceTask`, `bpmn:exclusiveGateway`, and
 * `bpmn:sequenceFlow`. Anything else (`bpmn:parallelGateway`,
 * `bpmn:scriptTask`, `bpmn:intermediateCatchEvent`, `bpmn:subProcess`,
 * `bpmn:callActivity`, etc.) raises this error so unsupported workflows
 * fail loudly at import.
 */
export class UnsupportedElementError extends Error {
  /** The fully-qualified BPMN type name, e.g. `bpmn:ParallelGateway`. */
  readonly qname: string;
  /** The BPMN `id` of the offending element, when available. */
  readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      `Unsupported BPMN element ${qname}` +
        (elementId ? ` (id='${elementId}')` : '') +
        '. Supported elements are start/end events, user tasks, service tasks ' +
        '(with operaton:class), exclusive gateways, and sequence flows.',
    );
    this.name = 'UnsupportedElementError';
    this.qname = qname;
    this.elementId = elementId;
  }
}
