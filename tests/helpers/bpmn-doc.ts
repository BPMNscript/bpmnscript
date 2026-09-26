/** One `<bpmn:definitions>` document: `roots` sit before the process, `body` inside it. */
export function bpmnDoc(body: string, roots = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
    'xmlns:operaton="http://operaton.org/schema/1.0/bpmn" targetNamespace="http://test">\n' +
    roots +
    `  <bpmn:process id="p" isExecutable="true" operaton:historyTimeToLive="P30D">\n${body}\n  </bpmn:process>\n` +
    '</bpmn:definitions>'
  );
}
