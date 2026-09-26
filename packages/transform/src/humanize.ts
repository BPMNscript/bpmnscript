/**
 * Derives a BPMN `name` from a DSL id. `xmlToIr` drops a `name` equal to
 * `humanize(id)`, so changing this grows redundant labels on round trips.
 */
export function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase: reviewInvoice -> review Invoice
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym: HTTPRequest -> HTTP Request
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
