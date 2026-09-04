// Regex rather than a parser: the tests workspace declares no moddle dependency.
// The block regex closes on a back-reference to its own tag, so several catch
// sites in one document are read independently.
/** Every `bpmn:message` root in the document, in document order. */
export function messageRoots(xml: string): { id: string; name: string }[] {
  return [...xml.matchAll(/<bpmn:message id="([^"]+)" name="([^"]+)"/g)].map(
    (m) => ({ id: m[1]!, name: m[2]! }),
  );
}

export function definitionRefOf(
  xml: string,
  elementId: string,
  definition: 'error' | 'escalation' | 'message' | 'signal',
): string | undefined {
  const id = elementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(
    `<bpmn:(\\w+Event)[^>]*?\\sid="${id}"[^>]*>([\\s\\S]*?)</bpmn:\\1>`,
  ).exec(xml);
  if (block === null) return undefined;
  return new RegExp(
    `<bpmn:${definition}EventDefinition\\b[^>]*\\b${definition}Ref="([^"]+)"`,
  ).exec(block[2]!)?.[1];
}
