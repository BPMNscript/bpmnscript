/**
 * Tagged templates that wrap a BPMN fragment in the `<bpmn:definitions>`
 * boilerplate the `xmlToIr` fixtures all share.
 *
 * `bpmnDoc` and `operatonDoc` also supply the `<bpmn:process id="p">` element,
 * so the template holds only the process content. `bpmnDefs` and
 * `operatonDefs` stop at `<bpmn:definitions>`, for fixtures that declare
 * root-level elements (messages, signals, errors) or a non-default process.
 *
 * Fixtures whose subject is the extension namespace itself — a `camunda:`
 * prefix alias, an unmapped `operaton:` element — spell their XML out in full
 * instead: routing them through a shared builder would hide what they pin.
 */

const HEAD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">`;

const HEAD_OPERATON = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">`;

const PROCESS_OPEN = '  <bpmn:process id="p" isExecutable="true">';
const PROCESS_CLOSE = '  </bpmn:process>';
const DEFINITIONS_CLOSE = '</bpmn:definitions>';

type XmlTag = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => string;

const wrap =
  (before: string, after: string): XmlTag =>
  (strings, ...values) =>
    `${before}\n${strings.reduce((acc, part, i) => acc + String(values[i - 1]) + part)}\n${after}`;

export const bpmnDefs = wrap(HEAD_BPMN, DEFINITIONS_CLOSE);
export const operatonDefs = wrap(HEAD_OPERATON, DEFINITIONS_CLOSE);

export const bpmnDoc = wrap(
  `${HEAD_BPMN}\n${PROCESS_OPEN}`,
  `${PROCESS_CLOSE}\n${DEFINITIONS_CLOSE}`,
);
export const operatonDoc = wrap(
  `${HEAD_OPERATON}\n${PROCESS_OPEN}`,
  `${PROCESS_CLOSE}\n${DEFINITIONS_CLOSE}`,
);
