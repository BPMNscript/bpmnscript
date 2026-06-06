/**
 * Ambient type declarations for the upstream `bpmn-moddle` and
 * `bpmn-auto-layout` packages, neither of which ship `.d.ts` files.
 *
 * We deliberately type these loosely — the IR is the only typed contract
 * in this layer; everything below is dynamic moddle-element soup.
 */

declare module 'bpmn-moddle' {
  // The shape of an in-memory moddle element. Properties are dynamic;
  // moddle attaches them as own properties keyed by the property `name`
  // in each `*-moddle.json` schema entry. Typed as `any` deliberately —
  // the IR types in `./ir/types.ts` are the only typed contract in this
  // package; everything below this boundary is dynamic moddle soup.
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
  /**
   * Lay out a BPMN 2.0 XML string, injecting `bpmndi:` diagram-interchange
   * elements. Returns a new XML string with DI present.
   */
  export function layoutProcess(xml: string): Promise<string>;
}
