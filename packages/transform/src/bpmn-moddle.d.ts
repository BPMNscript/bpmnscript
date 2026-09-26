declare module 'bpmn-moddle' {
  // Moddle attaches properties dynamically from its JSON schemas.
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
  export function layoutProcess(xml: string): Promise<string>;
}

declare module 'saxen' {
  /** Both counted from zero. */
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

  /** Entities still encoded; `decodeEntities` resolves them. */
  export type TextHandler = (
    value: string,
    decodeEntities: (text: string) => string,
    getContext: () => ParseContext,
  ) => void;

  export type CDataHandler = (
    value: string,
    getContext: () => ParseContext,
  ) => void;

  export class Parser {
    on(event: 'openTag', handler: OpenTagHandler): void;
    on(event: 'closeTag', handler: CloseTagHandler): void;
    on(event: 'text', handler: TextHandler): void;
    on(event: 'cdata', handler: CDataHandler): void;
    parse(xml: string): void;
  }
}
