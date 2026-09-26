import { it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { allElements } from './helpers/ir-query.js';

const rt = roundTripFixture('documentation', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

const PROCESS_TEXT =
  'Runs once for each supplier the buying team wants to trade with.';

const CARRIED: Record<string, string> = {
  ApplicationReceived:
    'The supplier fills this in on the portal before anything else happens.',
  RecordApplication: '${supplierId} is the reference every later step quotes.',
  ReviewApplication:
    'Two buyers must agree before the application moves on.\nEscalate to the buying lead when they do not.',
  ScreenSanctions:
    'The screening batch reads "C:\\onboarding\\watchlist.csv" from the compliance host.',
  ScoreRisk:
    'The score weighs the country of registration against the contract value.',
  RequestReferences:
    'Three referees are asked at once, and two answers are enough.',
  AwaitReferences: 'The portal posts each answer back as it arrives.',
  GradeSupplier: 'The grade decides the payment terms the contract may offer.',
  ArrangeAudit:
    'An audit is booked with the supplier before the first order goes out.',
  SetUpAccount:
    'Everything the finance system needs before the supplier can invoice.',
  SupplierOnboarded:
    'The supplier may be named on a purchase order from here on.',
};

const PRINTED_SETTINGS = [
  'process supplier-onboarding(label: "Supplier onboarding", documentation: "Runs once for each supplier the buying team wants to trade with.") {',
  '  start ApplicationReceived(label: "Application received", documentation: "The supplier fills this in on the portal before anything else happens.") {',
  '  step RecordApplication(documentation: "\\${supplierId} is the reference every later step quotes.")',
  '  user ReviewApplication(label: "Review the application", documentation: "Two buyers must agree before the application moves on.\\nEscalate to the buying lead when they do not.")',
  '  service ScreenSanctions(label: "Screen against the sanctions lists", documentation: "The screening batch reads \\"C:\\\\onboarding\\\\watchlist.csv\\" from the compliance host.", class: "com.example.onboarding.SanctionsScreeningDelegate")',
  '  script ScoreRisk(label: "Score the country risk", documentation: "The score weighs the country of registration against the contract value.", resultVariable: "riskScore") ```groovy',
  '  send RequestReferences(label: "Ask the named referees", documentation: "Three referees are asked at once, and two answers are enough.", class: "com.example.onboarding.ReferenceRequestDelegate")',
  '  receive AwaitReferences(label: "Wait for the references", documentation: "The portal posts each answer back as it arrives.", message: "ReferencesReturned")',
  '  decide GradeSupplier(label: "Grade the supplier", documentation: "The grade decides the payment terms the contract may offer.", decision: "supplierGrade", binding: latest, resultVariable: "supplierGrade")',
  '    call ArrangeAudit(label: "Arrange an on-site audit", documentation: "An audit is booked with the supplier before the first order goes out.", process: "supplier-audit") {',
  '  subprocess SetUpAccount(label: "Set up the account", documentation: "Everything the finance system needs before the supplier can invoice.") {',
  '  end SupplierOnboarded(label: "Supplier onboarded", documentation: "The supplier may be named on a purchase order from here on.")',
];

function carriedDocumentation(
  container: FlowContainer,
): Record<string, string> {
  return Object.fromEntries(
    allElements(container).flatMap((fe) =>
      'documentation' in fe && fe.documentation !== undefined
        ? [[fe.id, fe.documentation]]
        : [],
    ),
  );
}

it("keeps every carrier's text at every hop and prints each label ahead of its escaped documentation", () => {
  for (const [label, ir] of rt.hops) {
    expect(carriedDocumentation(ir), label).toEqual(CARRIED);
    expect(ir.documentation, label).toBe(PROCESS_TEXT);
  }
  expect(
    rt.dslPrime.split('\n').filter((line) => line.includes('documentation:')),
  ).toEqual(PRINTED_SETTINGS);
});
