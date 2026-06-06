/**
 * Full test suite for the AST → IR transform.
 *
 * Unit-level tests: they parse BpmnScript DSL source via the Langium grammar
 * and assert the resulting IR produced by `astToIr`.
 *
 * Test cases:
 *   1. Canonical invoice-approval source produces the canonical IR (deep equality).
 *   2. Gateway with `default: X` produces IR with `defaultFlowId` set to the
 *      flow's id.
 *   3. Optional fields (name, formKey) absent in DSL → absent in IR.
 *   4. Empty model (no process) throws with a message about 'no process definitions'.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr } from '../src/ast-to-ir.js';
import type {
  BpmnProcess,
  ExclusiveGateway,
  UserTask,
} from '../src/ir/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const DSL_PATH = resolve(
  here,
  '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

/**
 * The canonical IR produced by `astToIr` when parsing `invoice-approval.bpmnscript`.
 *
 * Key invariants of this object:
 *   - Sequence flow IDs are auto-generated from source/target ids (unnamed flows
 *     use the pattern `Flow_<sourceId>_<targetId>`).
 *   - The flow tagged `as: AutoApprovePath` in the DSL keeps that id.
 *   - Start event and end event carry NO `name` (the DSL does not give them labels).
 *   - The gateway `defaultFlowId` points to `AutoApprovePath`.
 *   - `conditionExpression` is the raw body with literal `>` (not XML-escaped).
 */
const CANONICAL_IR: BpmnProcess = {
  id: 'invoice-approval',
  name: 'Invoice Approval',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'ReviewStart' },
    {
      kind: 'userTask',
      id: 'ReviewInvoice',
      name: 'Review invoice',
      assignee: 'demo',
    },
    {
      kind: 'exclusiveGateway',
      id: 'AmountCheck',
      name: 'Amount > 1000?',
      defaultFlowId: 'AutoApprovePath',
    },
    {
      kind: 'userTask',
      id: 'SeniorApproval',
      name: 'Senior approval',
      assignee: 'manager',
    },
    {
      kind: 'serviceTask',
      id: 'AutoApprove',
      name: 'Auto-approve',
      javaClass: 'com.example.invoice.AutoApproveDelegate',
    },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_ReviewStart_ReviewInvoice',
      sourceRef: 'ReviewStart',
      targetRef: 'ReviewInvoice',
    },
    {
      id: 'Flow_ReviewInvoice_AmountCheck',
      sourceRef: 'ReviewInvoice',
      targetRef: 'AmountCheck',
    },
    {
      id: 'Flow_AmountCheck_SeniorApproval',
      conditionExpression: '${amount > 1000}',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
    },
    {
      id: 'AutoApprovePath',
      sourceRef: 'AmountCheck',
      targetRef: 'AutoApprove',
    },
    {
      id: 'Flow_SeniorApproval_Done',
      sourceRef: 'SeniorApproval',
      targetRef: 'Done',
    },
    {
      id: 'Flow_AutoApprove_Done',
      sourceRef: 'AutoApprove',
      targetRef: 'Done',
    },
  ],
};

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── 1. Canonical IR deep equality ────────────────────────────────────────────

describe('astToIr — canonical invoice-approval', () => {
  it('produces the canonical IR (deep equality)', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    expect(doc.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(doc.parseResult.value);

    expect(ir).toEqual(CANONICAL_IR);
  });

  it('id equals "invoice-approval"', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.id).toBe('invoice-approval');
  });

  it('name equals "Invoice Approval"', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.name).toBe('Invoice Approval');
  });

  it('isExecutable is always true', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.isExecutable).toBe(true);
  });

  it('produces exactly 6 flow elements', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.flowElements).toHaveLength(6);
  });

  it('produces exactly 6 sequence flows', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 2. Gateway defaultFlowId ─────────────────────────────────────────────────

describe('astToIr — gateway default flow', () => {
  it('gateway with default: X produces IR with defaultFlowId set to the flow id', async () => {
    const source = `
process p {
  start S
  gateway G "Check" default: myDefault
  user T "Task" assignee: "alice"
  end E

  S -> G
  G -> T when: "\${x > 0}"
  G -> E as: myDefault
  T -> E
}
`.trim();

    const doc = await parse(source);
    expect(doc.parseResult.parserErrors).toHaveLength(0);
    const ir = astToIr(doc.parseResult.value);

    const gw = ir.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.kind === 'exclusiveGateway',
    );
    expect(gw).toBeDefined();
    expect(gw!.defaultFlowId).toBe('myDefault');
  });

  it('canonical gateway has defaultFlowId = "AutoApprovePath"', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const gw = ir.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.kind === 'exclusiveGateway',
    );
    expect(gw).toBeDefined();
    expect(gw!.defaultFlowId).toBe('AutoApprovePath');
  });

  it('gateway without default: produces IR without defaultFlowId', async () => {
    const source = `
process p {
  start S
  gateway G
  end E

  S -> G
  G -> E
}
`.trim();

    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const gw = ir.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.kind === 'exclusiveGateway',
    );
    expect(gw).toBeDefined();
    expect(gw!.defaultFlowId).toBeUndefined();
  });
});

// ── 3. Optional fields absent in DSL → absent in IR ─────────────────────────

describe('astToIr — optional field absence', () => {
  it('user task without assignee has no assignee in IR', async () => {
    const source = `
process p {
  start S
  user T "My Task"
  end E

  S -> T
  T -> E
}
`.trim();

    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const task = ir.flowElements.find(
      (fe): fe is UserTask => fe.kind === 'userTask',
    );
    expect(task).toBeDefined();
    expect(task!.assignee).toBeUndefined();
  });

  it('user task without formKey has no formKey in IR', async () => {
    const source = `
process p {
  start S
  user T "My Task" assignee: "alice"
  end E

  S -> T
  T -> E
}
`.trim();

    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const task = ir.flowElements.find(
      (fe): fe is UserTask => fe.kind === 'userTask',
    );
    expect(task).toBeDefined();
    expect(task!.formKey).toBeUndefined();
  });

  it('start event and end event in canonical source have no name in IR', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const start = ir.flowElements.find((fe) => fe.kind === 'startEvent');
    const end = ir.flowElements.find((fe) => fe.kind === 'endEvent');
    expect(start?.name).toBeUndefined();
    expect(end?.name).toBeUndefined();
  });

  it('flow node without label has no name in IR', async () => {
    const source = `
process p {
  start S
  user T
  end E

  S -> T
  T -> E
}
`.trim();

    const doc = await parse(source);
    const ir = astToIr(doc.parseResult.value);

    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.name).toBeUndefined();
  });
});

// ── 4. Empty model throws ────────────────────────────────────────────────────

describe('astToIr — empty model error', () => {
  it('throws when the model contains no process definitions', async () => {
    // An empty document produces a Model with an empty processes array.
    const doc = await parse('');

    expect(() => astToIr(doc.parseResult.value)).toThrow(
      /no process definitions/i,
    );
  });
});
