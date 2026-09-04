// Regex rather than a parser: the tests workspace declares no moddle dependency.

/** Every id carried by a `<bpmn:<tag>>` open tag, in document order. */
export function idsOfTag(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<bpmn:${tag} id="([^"]+)"`, 'g'))].map(
    (m) => m[1]!,
  );
}

/** Every `bpmn:message` root in the document, in document order. */
export function messageRoots(xml: string): { id: string; name: string }[] {
  return [...xml.matchAll(/<bpmn:message id="([^"]+)" name="([^"]+)"/g)].map(
    (m) => ({ id: m[1]!, name: m[2]! }),
  );
}

/** Every `bpmn:error` root carrying `errorCode`, with the message it declares. */
export function errorRoots(
  xml: string,
  errorCode: string,
): { id: string; message: string }[] {
  const pattern = new RegExp(
    `<bpmn:error id="([^"]+)"[^>]*errorCode="${errorCode}"[^>]*operaton:errorMessage="([^"]+)"`,
    'g',
  );
  return [...xml.matchAll(pattern)].map((m) => ({ id: m[1]!, message: m[2]! }));
}

// The block regex closes on a back-reference to its own tag, so several catch
// sites in one document are read independently.
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
