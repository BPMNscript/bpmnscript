import { describe, it, expect } from 'vitest';

import type { FlowContainer, ListenerBinding } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { describeDiContainment } from './helpers/di-bounds.js';
import { allElements } from './helpers/ir-query.js';

const rt = roundTripFixture('listeners', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

// Exact body of the fixture's inline-script listener, trailing newline included.
const SCRIPT_BODY = 'task.setVariable("assessmentRevised", true);\n';

// The handler header has no id slot, so this id is synthesized from the
// statement's position.
const WITHDRAWAL_HANDLER = 'EventSubProcess_claim-settlement_5';

// `<carrier> <event> <binding>`, in the order a depth-first walk reaches them.
const EXPECTED_LISTENERS = [
  'ValidateClaim start class=com.example.claims.OpenAuditTrail',
  'ValidateClaim end expression=${auditTrail.close(execution)}',
  'AssessDamage start delegateExpression=${assessmentTracker}',
  'InspectVehicle create class=com.example.claims.NotifyAssessor',
  'InspectVehicle assign expression=${assessorRoster.record(task)}',
  'InspectVehicle complete delegateExpression=${assessmentRecorder}',
  `InspectVehicle update script=javascript ${JSON.stringify(SCRIPT_BODY)}`,
  'InspectVehicle delete class=com.example.claims.ReleaseAssessor',
  'InspectVehicle timeout duration PT8H delegateExpression=${assessmentEscalation}',
  'ClaimSettled end class=com.example.claims.ArchiveClaim',
  `${WITHDRAWAL_HANDLER} start class=com.example.claims.LogWithdrawal`,
];

function bindingSignature(binding: ListenerBinding): string {
  switch (binding.kind) {
    case 'class':
      return `class=${binding.className}`;
    case 'expression':
      return `expression=${binding.expression}`;
    case 'delegateExpression':
      return `delegateExpression=${binding.expression}`;
    case 'script':
      return `script=${binding.format} ${JSON.stringify(binding.code)}`;
  }
}

// Execution listeners come before a user task's task listeners on the same
// carrier, the order both the serializer and the printer emit.
function listenerSignatures(container: FlowContainer): string[] {
  const signatures: string[] = [];
  for (const element of allElements(container)) {
    const executionListeners =
      'executionListeners' in element ? (element.executionListeners ?? []) : [];
    for (const listener of executionListeners) {
      signatures.push(
        `${element.id} ${listener.event} ${bindingSignature(listener.binding)}`,
      );
    }
    if (element.kind !== 'userTask') {
      continue;
    }
    for (const listener of element.taskListeners ?? []) {
      const timer =
        listener.timer !== undefined
          ? ` ${listener.timer.timerKind} ${listener.timer.expression}`
          : '';
      signatures.push(
        `${element.id} ${listener.event}${timer} ${bindingSignature(listener.binding)}`,
      );
    }
  }
  return signatures;
}

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it('every listener keeps its carrier, event, and binding at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(listenerSignatures(ir), `listeners differ in ${label}`).toEqual(
        EXPECTED_LISTENERS,
      );
    }
  });

  it('the inline-script listener keeps its body and language tag through the decompile', () => {
    expect(rt.dslPrime).toContain('```javascript\n' + SCRIPT_BODY + '```');
  });
});

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('the timeout listener carries its timer as a bpmn:timerEventDefinition child', () => {
    expect(rt.frozenXml).toContain(
      [
        '<operaton:taskListener event="timeout" delegateExpression="${assessmentEscalation}">',
        '  <bpmn:timerEventDefinition>',
        '    <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT8H</bpmn:timeDuration>',
        '  </bpmn:timerEventDefinition>',
        '</operaton:taskListener>',
      ].join('\n          '),
    );
  });

  it('the inline-script listener writes its body verbatim under its language tag', () => {
    expect(rt.frozenXml).toContain(
      `<operaton:script scriptFormat="javascript">${SCRIPT_BODY}</operaton:script>`,
    );
  });

  it('a listener binding is written unprefixed on its already-qualified element', () => {
    expect(rt.frozenXml).toContain(
      '<operaton:executionListener event="start" class="com.example.claims.OpenAuditTrail" />',
    );
  });
});

// The nested shapes are named so the walk cannot pass on an empty tree.
describeDiContainment(rt, [
  'AssessDamage',
  'InspectVehicle',
  WITHDRAWAL_HANDLER,
  'CancelSettlement',
]);
