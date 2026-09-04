/** `bpmn-moddle` and `bpmn-auto-layout` ship no `.d.ts` files of their own. */

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
