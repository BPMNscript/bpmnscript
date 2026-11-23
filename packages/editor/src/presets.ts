/** An example a playground offers: a BPMNscript source to open, or a BPMN file to import. */
export type Preset = {
  id: string;
  kind: 'source' | 'bpmn';
  /** Path inside the BPMNscript repo; a site copies the file and serves it itself. */
  path: string;
};

const ex = 'examples/spring-boot/processes/';
const src = (id: string): Preset => ({
  id,
  kind: 'source',
  path: `${ex}${id}.bpmnscript`,
});
const bpmn = (id: string, path: string): Preset => ({ id, kind: 'bpmn', path });

export const PRESETS: readonly Preset[] = [
  src('invoice-approval'),
  src('loan-approval'),
  src('parallel-approval'),
  src('compensating-saga'),
  src('support-ticket'),
  src('order-handling'),
  bpmn('invoice-handwritten', 'tests/golden/invoice-approval-handwritten.bpmn'),
  bpmn('invoice-receipt', 'tests/fixtures/invoice-receipt.bpmn'),
  bpmn('error-start', 'tests/fixtures/error-start.bpmn'),
  bpmn('service-no-binding', 'tests/golden/bad-service-task-no-binding.bpmn'),
];

export const DEFAULT_PRESET = 'invoice-approval';
