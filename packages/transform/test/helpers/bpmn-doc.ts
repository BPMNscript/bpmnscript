/**
 * Tagged templates that wrap a BPMN fragment in the `<bpmn:definitions>`
 * boilerplate the `xmlToIr` fixtures all share.
 *
 * `bpmnDoc`, `operatonDoc`, `camundaDoc` and `dualDoc` also supply the
 * `<bpmn:process id="p">` element, so the template holds only the process
 * content. `bpmnDefs` and `operatonDefs` stop at `<bpmn:definitions>`, for
 * fixtures that declare root-level elements (messages, signals, errors) or a
 * non-default process.
 *
 * The namespace a fixture pins stays visible in the fragment, where the
 * prefixed attribute or element is written: only the declaration moves here.
 */

const NS_BPMN = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';
const NS_OPERATON = 'xmlns:operaton="http://operaton.org/schema/1.0/bpmn"';
const NS_CAMUNDA = 'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';

const head = (...namespaces: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${[...namespaces, 'targetNamespace="http://test"'].join('\n                  ')}>`;

const HEAD_BPMN = head(NS_BPMN);
const HEAD_OPERATON = head(NS_BPMN, NS_OPERATON);
const HEAD_CAMUNDA = head(NS_BPMN, NS_CAMUNDA);
const HEAD_DUAL = head(NS_BPMN, NS_OPERATON, NS_CAMUNDA);

const PROCESS_OPEN = '  <bpmn:process id="p" isExecutable="true">';
const PROCESS_CLOSE = '  </bpmn:process>';
const DEFINITIONS_CLOSE = '</bpmn:definitions>';

export type XmlTag = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => string;

const wrap =
  (before: string, after: string): XmlTag =>
  (strings, ...values) =>
    `${before}\n${strings.reduce((acc, part, i) => acc + String(values[i - 1]) + part)}\n${after}`;

const doc = (headText: string): XmlTag =>
  wrap(
    `${headText}\n${PROCESS_OPEN}`,
    `${PROCESS_CLOSE}\n${DEFINITIONS_CLOSE}`,
  );

export const bpmnDefs = wrap(HEAD_BPMN, DEFINITIONS_CLOSE);
export const operatonDefs = wrap(HEAD_OPERATON, DEFINITIONS_CLOSE);
export const camundaDefs = wrap(HEAD_CAMUNDA, DEFINITIONS_CLOSE);
export const dualDefs = wrap(HEAD_DUAL, DEFINITIONS_CLOSE);

export const bpmnDoc = doc(HEAD_BPMN);
export const operatonDoc = doc(HEAD_OPERATON);
/** Declares only the deprecated `camunda:` prefix, for the alias fixtures. */
export const camundaDoc = doc(HEAD_CAMUNDA);
/** Declares both prefixes, for fixtures that write one against the other. */
export const dualDoc = doc(HEAD_DUAL);

/** One `<bpmn:extensionElements>` wrapper around the given children. */
export const extensionElements = (children: string): string =>
  `\n      <bpmn:extensionElements>\n${children}\n      </bpmn:extensionElements>\n    `;

interface OneNodeOptions {
  /** The node's id, which the two sequence flows also name. Defaults to `T`. */
  id?: string;
  /** Extra attributes on the node's opening tag. */
  attrs?: string;
  /** The node's children: an extension block, a script body. */
  children?: string;
  /** The `<bpmn:definitions>` wrapper. Defaults to {@link operatonDoc}. */
  doc?: XmlTag;
}

/**
 * `S -> node -> E`: one flow node of the given tag between a start and an end
 * event, the shape nearly every single-element import fixture wants.
 */
export const oneNodeDoc = (
  tag: string,
  {
    id = 'T',
    attrs = '',
    children = '',
    doc: wrapper = operatonDoc,
  }: OneNodeOptions = {},
): string =>
  wrapper`    <bpmn:startEvent id="S" />
    <bpmn:${tag} id="${id}" ${attrs}>${children}</bpmn:${tag}>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="${id}" />
    <bpmn:sequenceFlow id="F2" sourceRef="${id}" targetRef="E" />`;

interface HandlerOptions {
  /** The event sub-process id. Defaults to `Handler`. */
  id?: string;
  /** Extra attributes on the trigger start event. */
  startAttrs?: string;
  /**
   * The handler body written after the trigger start. Defaults to an end event
   * the start flows into; `''` leaves the handler holding only its start.
   */
  body?: string;
  /** Root-level declarations (errors, messages, signals) before the process. */
  roots?: string;
  /** The `<bpmn:definitions>` wrapper. Defaults to {@link bpmnDefs}. */
  defs?: XmlTag;
}

const HANDLER_BODY = `      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
`;

/**
 * `S -> E` with one event sub-process alongside, whose trigger start `HStart`
 * carries the given event definition: the shape every handler-import fixture
 * wants.
 */
export const handlerDoc = (
  definition: string,
  {
    id = 'Handler',
    startAttrs = '',
    body = HANDLER_BODY,
    roots = '',
    defs = bpmnDefs,
  }: HandlerOptions = {},
): string =>
  defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="${id}" triggeredByEvent="true">
      <bpmn:startEvent id="HStart" ${startAttrs}>
        ${definition}
      </bpmn:startEvent>
${body}    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;
