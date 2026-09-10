/**
 * `bpmn-moddle`, `bpmn-auto-layout` and `saxen` ship no `.d.ts` files of their
 * own.
 */

declare module 'bpmn-moddle' {
  // Moddle attaches properties dynamically, keyed by the `name` in each
  // `*-moddle.json` schema entry, so `any` is the honest type here. The IR in
  // `./ir/types.ts` is the only typed contract in this package.
  export type ModdleElement = any;

  export interface BpmnModdleInstance {
    create(typeName: string, attrs?: Record<string, unknown>): any;
    toXML(
      element: ModdleElement,
      options?: { format?: boolean; preamble?: boolean },
    ): Promise<{ xml: string }>;
    fromXML(
      xmlStr: string,
      typeName?: string,
      options?: Record<string, unknown>,
    ): Promise<{
      rootElement: ModdleElement;
      references: unknown[];
      warnings: Error[];
      elementsById: Record<string, ModdleElement>;
    }>;
  }

  export interface BpmnModdleConstructor {
    new (
      additionalPackages?: Record<string, unknown>,
      options?: { strict?: boolean },
    ): BpmnModdleInstance;
  }

  export const BpmnModdle: BpmnModdleConstructor;
}

declare module 'bpmn-auto-layout' {
  /** Returns the XML with `bpmndi:` diagram-interchange elements injected. */
  export function layoutProcess(xml: string): Promise<string>;
}

declare module 'saxen' {
  /** The source position the parser has reached, both counted from zero. */
  export interface ParseContext {
    line: number;
    column: number;
  }

  export type OpenTagHandler = (
    elementName: string,
    getAttrs: () => Record<string, string>,
    decodeEntities: boolean,
    selfClosing: boolean,
    getContext: () => ParseContext,
  ) => void;

  export type CloseTagHandler = (
    elementName: string,
    decodeEntities: boolean,
    selfClosing: boolean,
    getContext: () => ParseContext,
  ) => void;

  export class Parser {
    on(event: 'openTag', handler: OpenTagHandler): void;
    on(event: 'closeTag', handler: CloseTagHandler): void;
    parse(xml: string): void;
  }
}
