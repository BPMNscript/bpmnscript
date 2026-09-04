// The zero-warning import roundTripFixture registers is the load-bearing
// assertion here: a parameter the importer cannot represent surfaces as an
// extensionAttribute warning, not as a difference in the IR.

import { describe, it, expect } from 'vitest';

import type {
  FlowContainer,
  FlowElement,
  IoValue,
} from '@bpmn-script/transform';

import { describeDiContainment } from './helpers/di-bounds.js';
import { allElements, theOnly } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('input-output', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

const PARAMETER_CARRIERS = [
  'userTask',
  'serviceTask',
  'scriptTask',
  'subProcess',
  'callActivity',
] as const;

type ParameterCarrier = Extract<
  FlowElement,
  { kind: (typeof PARAMETER_CARRIERS)[number] }
>;

function carriesParameters(el: FlowElement): el is ParameterCarrier {
  return (PARAMETER_CARRIERS as readonly string[]).includes(el.kind);
}

// Structural, not the DSL spelling: an expectation written in the printer's own
// output would move whenever the printer does.
function renderValue(value: IoValue): string {
  switch (value.kind) {
    case 'text':
      return JSON.stringify(value.text);
    case 'script':
      return `${value.format}(${JSON.stringify(value.code)})`;
    case 'list':
      return `[${value.items.map(renderValue).join(', ')}]`;
    case 'map':
      return `{${value.entries
        .map(
          (entry) =>
            `${JSON.stringify(entry.key)}: ${renderValue(entry.value)}`,
        )
        .join(', ')}}`;
  }
}

// Keyed by carrier id, so the comparison is blind to the order flow elements
// come back in but strict about the order inside one carrier, which is what the
// engine evaluates.
function parameterSignatures(
  container: FlowContainer,
): Record<string, string[]> {
  const into: Record<string, string[]> = {};
  for (const el of allElements(container)) {
    if (!carriesParameters(el)) continue;
    const signatures = [
      ...(el.inputParameters ?? []).map(
        (p) => `input ${p.name} = ${renderValue(p.value)}`,
      ),
      ...(el.outputParameters ?? []).map(
        (p) => `output ${p.name} = ${renderValue(p.value)}`,
      ),
    ];
    if (signatures.length > 0) into[el.id] = signatures;
  }
  return into;
}

// A handler has no name of its own, so this is the one carrier in the fixture
// whose id is structural rather than authored.
const RECALL_HANDLER_ID = 'EventSubProcess_expense-reimbursement_7';

const EXPECTED_PARAMETERS: Record<string, string[]> = {
  ReviewReceipts: [
    'input receiptHint = "Match every receipt against the trip dates"',
    'input escalationDesk = "expenses-l2"',
    'output reviewNote = "${reviewComment}"',
  ],
  RateAllowance: [
    'input allowanceRule = groovy("def rate = travelDays > 5 ? 40 : 55\\nexecution.setVariable(\\"dailyRate\\", rate)\\n")',
    'output dailyRate = "${dailyRate}"',
  ],
  ConvertAllowance: [
    'input conversionRate = "${euroRate}"',
    'output allowanceInEuro = groovy("allowanceBase * conversionRate\\n")',
  ],
  AuditClaim: [
    'input auditChecks = [{"field": "receipts", "rule": "present"}, {"field": "mileage", "rule": "within-policy"}]',
    'output auditVerdict = "${auditOutcome}"',
  ],
  PayOut: [
    'input payoutChannel = "sepa"',
    'output payoutReceipt = {"start": "${payoutStart}", "lines": ["principal", "vat"]}',
  ],
  [RECALL_HANDLER_ID]: ['input recallReason = "${recallText}"'],
};

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it('every parameter keeps its direction, name, and value shape, in order, at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(parameterSignatures(ir), `parameters differ in ${label}`).toEqual(
        EXPECTED_PARAMETERS,
      );
    }
  });

  it('every map key comes back quoted, keyword-shaped or not', () => {
    expect(rt.dslPrime).toContain('"start": "${payoutStart}"');
    expect(rt.dslPrime).toContain('"lines": ["principal", "vat"]');
    expect(rt.dslPrime).toContain('"field": "receipts"');
  });
});

describe('the call activity keeps its variable mappings and its parameters apart', () => {
  it('both mechanisms survive on the same node at every hop, neither absorbing the other', () => {
    for (const [label, ir] of rt.hops) {
      const call = theOnly(ir, 'callActivity', (c) => c.id === 'PayOut');

      expect(call.inMappings, `in mappings differ in ${label}`).toEqual([
        { kind: 'variable', source: 'claimTotal', target: 'claimTotal' },
      ]);
      expect(call.outMappings, `out mappings differ in ${label}`).toEqual([
        {
          kind: 'variable',
          source: 'paymentReference',
          target: 'paymentReference',
        },
      ]);
      expect(
        call.inputParameters?.map((p) => p.name),
        `input parameters differ in ${label}`,
      ).toEqual(['payoutChannel']);
      expect(
        call.outputParameters?.map((p) => p.name),
        `output parameters differ in ${label}`,
      ).toEqual(['payoutReceipt']);
    }
  });

  it('the frozen call activity serializes both, as siblings under extensionElements', () => {
    const element = /<bpmn:callActivity\b[\s\S]*?<\/bpmn:callActivity>/.exec(
      rt.frozenXml,
    )?.[0];
    expect(element, 'no callActivity in the frozen artifact').toBeDefined();

    expect(element).toContain(
      '<operaton:in source="claimTotal" target="claimTotal" />',
    );
    expect(element).toContain(
      '<operaton:out source="paymentReference" target="paymentReference" />',
    );

    // Variable mappings sit beside the inputOutput block, not inside it. Nested
    // in it they would still be present but would stop being read as mappings.
    const block = /<operaton:inputOutput>[\s\S]*?<\/operaton:inputOutput>/.exec(
      element ?? '',
    )?.[0];
    expect(block, 'no inputOutput block on the call activity').toBeDefined();

    expect(block).toContain('<operaton:inputParameter name="payoutChannel">');
    expect(block).toContain('<operaton:outputParameter name="payoutReceipt">');
    expect(block).not.toContain('<operaton:in source=');
    expect(block).not.toContain('<operaton:out source=');
  });
});

describeDiContainment(rt);
