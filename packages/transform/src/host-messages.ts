/**
 * User-facing messages for unconvertible files, shared by CLI and VS Code, so
 * they carry no host wording.
 */

// `moddle-xml`'s message for a root of no registered type; it never says what it found.
const WRONG_ROOT_MESSAGE = 'failed to parse document as <bpmn:Definitions>';
const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

export const EMPTY_INPUT_MESSAGE = 'the file is empty';

export const NO_PROCESS_MESSAGE = 'the file has no process';

function describeRoot(xml: string): string {
  const tag = /<([\w:]+)/.exec(xml)?.[1];
  if (tag === undefined) return '';
  // Not one regex: a greedy `[^>]*` lands on the root's last xmlns, not the
  // one for its own prefix.
  const colon = tag.indexOf(':');
  const decl = colon === -1 ? 'xmlns' : `xmlns:${tag.slice(0, colon)}`;
  const uri = new RegExp(`<${tag}[^>]*?\\s${decl}="([^"]+)"`).exec(xml)?.[1];
  const found = uri === undefined ? '' : `; found ${decl}=${uri}`;
  return ` (root element is <${tag}>; expected <bpmn:definitions> in namespace ${BPMN_NAMESPACE}${found})`;
}

function printablePreview(text: string): string {
  return text.slice(0, 200).replace(/\p{C}/gu, '').slice(0, 40);
}

/** `saxen` quotes the whole unparsed remainder, megabytes and control characters included. */
export function readableParseError(message: string, xml: string): string {
  const firstLine = message.split('\n')[0];
  const capped = (
    firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine
  ).replace(/\p{C}/gu, '');
  return capped === WRONG_ROOT_MESSAGE ? capped + describeRoot(xml) : capped;
}

export function xmlInputProblem(xml: string): string | undefined {
  // `trim` strips a leading BOM (U+FEFF is ECMA-262 WhiteSpace).
  if (xml.trim() === '') return EMPTY_INPUT_MESSAGE;
  if (!xml.trimStart().startsWith('<')) {
    return `not an XML document (starts with "${printablePreview(xml.trimStart())}")`;
  }
  return undefined;
}
