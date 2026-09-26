/**
 * What a host shows a user for a file it cannot convert, plus the checks that
 * catch input no BPMN parser can do anything with. The CLI and the VS Code
 * extension both put these strings in front of a person, so they carry no host
 * wording: a caller adds what it wants around them.
 */

// `moddle-xml`'s one message for a root that resolves to no registered type;
// it never says what it found.
const WRONG_ROOT_MESSAGE = 'failed to parse document as <bpmn:Definitions>';
const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

/** The message for input that is empty, as opposed to merely not XML. */
export const EMPTY_INPUT_MESSAGE = 'the file is empty';

/** The message for a source that parses but declares no process. */
export const NO_PROCESS_MESSAGE = 'the file has no process';

function describeRoot(xml: string): string {
  const tag = /<([\w:]+)/.exec(xml)?.[1];
  if (tag === undefined) return '';
  // A greedy `[^>]*` backtracks from the tag's end, so it lands on the last
  // xmlns declared on the root, not the one for the root's own prefix.
  const colon = tag.indexOf(':');
  const decl = colon === -1 ? 'xmlns' : `xmlns:${tag.slice(0, colon)}`;
  const uri = new RegExp(`<${tag}[^>]*?\\s${decl}="([^"]+)"`).exec(xml)?.[1];
  const found = uri === undefined ? '' : `; found ${decl}=${uri}`;
  return ` (root element is <${tag}>; expected <bpmn:definitions> in namespace ${BPMN_NAMESPACE}${found})`;
}

function printablePreview(text: string): string {
  return text.slice(0, 200).replace(/\p{C}/gu, '').slice(0, 40);
}

/**
 * `saxen`'s parse errors quote the unparsed remainder of the document after a
 * newline: megabytes for a large or binary file, control characters included.
 */
export function readableParseError(message: string, xml: string): string {
  const firstLine = message.split('\n')[0];
  const capped = (
    firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine
  ).replace(/\p{C}/gu, '');
  return capped === WRONG_ROOT_MESSAGE ? capped + describeRoot(xml) : capped;
}

/**
 * Why `xml` cannot be a BPMN document, before a parser quotes it back in full,
 * or undefined when it is worth parsing.
 */
export function xmlInputProblem(xml: string): string | undefined {
  // `trim` treats a leading BOM as whitespace (ECMA-262 WhiteSpace includes
  // U+FEFF), so neither check needs a BOM strip.
  if (xml.trim() === '') return EMPTY_INPUT_MESSAGE;
  if (!xml.trimStart().startsWith('<')) {
    return `not an XML document (starts with "${printablePreview(xml.trimStart())}")`;
  }
  return undefined;
}
