import { describe, it, expect } from 'vitest';

import type {
  FieldInjection,
  FlowContainer,
  FlowElement,
  ListenerBinding,
  VersionBinding,
} from '@bpmn-script/transform';

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

// `<carrier> <name>=<value>`, where a listener's carrier is the element and the
// event it fires on. Listed separately from the binding signatures above,
// because those format the binding's own shape and would still match with every
// field gone.
const EXPECTED_FIELDS = [
  'ValidateClaim policyRegister=motor-policies',
  'ValidateClaim settlementCurrency=${claim.currency}',
  'ValidateClaim start auditCategory=claim-validation',
  'InspectVehicle complete reviewedBy=${task.assignee}',
];

// Every binding an element or a listener can hold, so the walk below reaches
// each one without asking what kind of element it came off.
type AnyBinding =
  | ListenerBinding
  | VersionBinding
  | NonNullable<Extract<FlowElement, { kind: 'serviceTask' }>['binding']>;

// Only the two kinds Operaton injects into declare the slot at all, which is
// what makes a field on any other binding unrepresentable rather than refused.
function fieldsOf(binding: AnyBinding): FieldInjection[] {
  return binding.kind === 'class' || binding.kind === 'delegateExpression'
    ? (binding.fields ?? [])
    : [];
}

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

// A binding and what names it: an element's own, then its execution
// listeners', then a user task's task listeners', which is the order both the
// serializer and the printer emit. Both contracts below read this one walk, so
// a carrier reaches both or neither.
type Carried =
  /** `carrier` is the element's id on its own binding. */
  | { on: 'element'; carrier: string; binding: AnyBinding }
  /** `<element id> <event>`, plus the clause only a timeout listener adds. */
  | {
      on: 'listener';
      carrier: string;
      binding: ListenerBinding;
      timer: string;
    };

function* carriedBindings(container: FlowContainer): Generator<Carried> {
  for (const element of allElements(container)) {
    if ('binding' in element && element.binding !== undefined) {
      yield { on: 'element', carrier: element.id, binding: element.binding };
    }
    const executionListeners =
      'executionListeners' in element ? (element.executionListeners ?? []) : [];
    for (const listener of executionListeners) {
      yield {
        on: 'listener',
        carrier: `${element.id} ${listener.event}`,
        binding: listener.binding,
        timer: '',
      };
    }
    if (element.kind !== 'userTask') {
      continue;
    }
    for (const listener of element.taskListeners ?? []) {
      yield {
        on: 'listener',
        carrier: `${element.id} ${listener.event}`,
        binding: listener.binding,
        timer:
          listener.timer !== undefined
            ? ` ${listener.timer.timerKind} ${listener.timer.expression}`
            : '',
      };
    }
  }
}

function listenerSignatures(container: FlowContainer): string[] {
  return [...carriedBindings(container)].flatMap((carried) =>
    carried.on === 'listener'
      ? [
          `${carried.carrier}${carried.timer} ${bindingSignature(carried.binding)}`,
        ]
      : [],
  );
}

function fieldSignatures(container: FlowContainer): string[] {
  return [...carriedBindings(container)].flatMap(({ carrier, binding }) =>
    fieldsOf(binding).map((field) => `${carrier} ${field.name}=${field.value}`),
  );
}

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it('every injected field keeps its carrier, name, and value at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(fieldSignatures(ir), `fields differ in ${label}`).toEqual(
        EXPECTED_FIELDS,
      );
    }
  });

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
      '<operaton:executionListener event="start" class="com.example.claims.OpenAuditTrail">',
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
