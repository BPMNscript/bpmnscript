// Regex rather than a parser: the tests workspace declares no moddle dependency.
// The block regex closes on a back-reference to its own tag, so several catch
// sites in one document are read independently.
export function definitionRefOf(
  xml: string,
  elementId: string,
  definition: 'error' | 'escalation' | 'message' | 'signal',
): string | undefined {
  const block = new RegExp(
    `<bpmn:(\\w+Event) id="${elementId}"[^>]*>([\\s\\S]*?)</bpmn:\\1>`,
  ).exec(xml);
  if (block === null) return undefined;
  return new RegExp(
    `<bpmn:${definition}EventDefinition\\b[^>]*\\b${definition}Ref="([^"]+)"`,
  ).exec(block[2]!)?.[1];
}
