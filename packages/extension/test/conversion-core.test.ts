import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from '../src/extension/conversion-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-no-binding.bpmn',
);

for (const [label, p] of [
  ['invoice-approval.bpmnscript', INVOICE_APPROVAL_SRC],
  ['invoice-approval-generated.bpmn', GOLDEN_GENERATED_BPMN],
  ['bad-service-task-no-binding.bpmn', BAD_SERVICE_TASK_BPMN],
] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture not found: ${label} at ${p}`);
  }
}

describe('compileDslToBpmn — invoice-approval golden fixture', () => {
  it('compiles to ok:true; output contains bpmn:definitions; re-imports via xmlToIr with process id invoice-approval', async () => {
    const source = fs.readFileSync(INVOICE_APPROVAL_SRC, 'utf-8');

    const result = await compileDslToBpmn(
      source,
      'invoice-approval.bpmnscript',
      '0.0.1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.output).toContain('bpmn:definitions');

    const { ir } = await xmlToIr(result.output);
    expect(ir.id).toBe('invoice-approval');
  });
});

describe('compileDslToBpmn — type-mismatch validation error', () => {
  it('returns ok:false, kind:validation, diagnostics.length >= 1, each with 0-based line and non-empty message', async () => {
    // String `name` in a numeric comparison: a severity-1 diagnostic.
    const source = `process p {
  var name: string
  if (name > 1000) { user A }
}
`;

    const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.kind).toBe('validation');
    if (result.kind !== 'validation') return;

    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);

    for (const d of result.diagnostics) {
      // 0-based, LSP convention.
      expect(d.line).toBeGreaterThanOrEqual(0);
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.severity).toBe(1);
    }
  });
});

describe('compileDslToBpmn — undeclared-variable warning does not block', () => {
  it('returns ok:true for a source whose only diagnostic is an undeclared-variable warning', async () => {
    // Uses `amount` without declaring it: severity 2, which must not block.
    const source = `process p { if (amount > 1000) { user A } }`;

    const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.length).toBeGreaterThan(0);
    }
  });
});

describe('decompileBpmnToDsl — invoice-approval-generated golden fixture', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it('returns ok:true; output re-parses through Langium with zero parser errors', async () => {
    const xml = fs.readFileSync(GOLDEN_GENERATED_BPMN, 'utf-8');

    const result = await decompileBpmnToDsl(
      xml,
      'invoice-approval-generated.bpmn',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = await parse(result.output);
    expect(doc.parseResult.parserErrors).toHaveLength(0);

    expect(result.warnings).toEqual([]);
  });
});

// `formRef` and the lane are both dropped without loss of behaviour, so
// `xmlToIr` warns instead of refusing.
const LANE_AND_ASYNC_ATTR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="warns" isExecutable="true">
    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Ops" name="Ops">
        <bpmn:flowNodeRef>S</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>AsyncTask</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>E</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="AsyncTask" name="Async Task"
                   operaton:assignee="alice" operaton:asyncBefore="true"
                   operaton:formRef="review-form" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('decompileBpmnToDsl — surfaces import warnings for dropped content', () => {
  it('returns ok:true with populated warnings naming the dropped attribute, the lane, and their element ids', async () => {
    const result = await decompileBpmnToDsl(
      LANE_AND_ASYNC_ATTR_BPMN,
      'warns.bpmn',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.warnings.length).toBeGreaterThanOrEqual(2);

    const attrWarning = result.warnings.find(
      (w) => w.category === 'extensionAttribute',
    );
    expect(attrWarning).toBeDefined();
    expect(attrWarning?.message).toContain('formRef');
    expect(attrWarning?.elementId).toBe('AsyncTask');

    const laneWarning = result.warnings.find((w) => w.category === 'lane');
    expect(laneWarning).toBeDefined();
    expect(laneWarning?.elementId).toBe('Lane_Ops');
  });
});

describe('decompileBpmnToDsl — bad-service-task-no-binding.bpmn', () => {
  it('returns ok:false, kind:unsupported; message mentions the missing execution discriminator and BadService_1', async () => {
    const xml = fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8');

    const result = await decompileBpmnToDsl(
      xml,
      'bad-service-task-no-binding.bpmn',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;

    expect(result.message).toContain('BadService_1');
    expect(result.message).toContain('no execution discriminator');
  });
});

const TIMER_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="timer" isExecutable="true">
    <bpmn:startEvent id="TimerStart">
      <bpmn:timerEventDefinition id="td">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="TimerStart" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('decompileBpmnToDsl — timer-start.bpmn (new refusal subclass)', () => {
  it('returns ok:false, kind:unsupported; message mentions the timer trigger and TimerStart', async () => {
    const result = await decompileBpmnToDsl(
      TIMER_START_BPMN,
      'timer-start.bpmn',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;

    expect(result.message).toContain('TimerStart');
    expect(result.message).toContain('timer');
  });
});

describe('swapExtension', () => {
  it('strips the final extension and appends the new one, preserving dotted basenames', () => {
    expect(swapExtension('/a/b/my.invoice.bpmnscript', '.bpmn')).toBe(
      '/a/b/my.invoice.bpmn',
    );
  });

  it('swaps .bpmn to .bpmnscript', () => {
    expect(swapExtension('/a/b/x.bpmn', '.bpmnscript')).toBe(
      '/a/b/x.bpmnscript',
    );
  });
});
