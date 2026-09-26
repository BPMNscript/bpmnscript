import { it, expect } from 'vitest';

import type {
  FieldInjection,
  FlowContainer,
  FlowElement,
  ListenerBinding,
  VersionBinding,
} from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { allElements } from './helpers/ir-query.js';

const rt = roundTripFixture('listeners', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

const SCRIPT_BODY = 'task.setVariable("assessmentRevised", true);\n';

// The handler header has no id slot, so this id is positional.
const WITHDRAWAL_HANDLER = 'EventSubProcess_claim-settlement_5';

// `<carrier> <event> <binding>`, in the order a depth-first walk reaches them.
const EXPECTED_LISTENERS = [
  'ValidateClaim start class=com.example.claims.OpenAuditTrail',
  'ValidateClaim end expression=${auditTrail.close(execution)}',
  'AssessDamage start delegateExpression=${assessmentTracker}',
  'InspectVehicle create class=com.example.claims.NotifyAssessor',
  'InspectVehicle assignment expression=${assessorRoster.record(task)}',
  'InspectVehicle complete delegateExpression=${assessmentRecorder}',
  `InspectVehicle update script=javascript ${JSON.stringify(SCRIPT_BODY)}`,
  'InspectVehicle delete class=com.example.claims.ReleaseAssessor',
  'InspectVehicle timeout duration PT8H delegateExpression=${assessmentEscalation}',
  'ClaimSettled end class=com.example.claims.ArchiveClaim',
  `${WITHDRAWAL_HANDLER} start class=com.example.claims.LogWithdrawal`,
];

// `<carrier> <name>=<value>`; a listener's carrier is `<element> <event>`.
const EXPECTED_FIELDS = [
  'ValidateClaim policyRegister=motor-policies',
  'ValidateClaim settlementCurrency=${claim.currency}',
  'ValidateClaim start auditCategory=claim-validation',
  'InspectVehicle complete reviewedBy=${task.assignee}',
];

type AnyBinding =
  | ListenerBinding
  | VersionBinding
  | NonNullable<Extract<FlowElement, { kind: 'serviceTask' }>['binding']>;

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

// An element's own binding, then its execution listeners', then its task
// listeners': the order both the serializer and the printer emit.
type Carried =
  | { on: 'element'; carrier: string; binding: AnyBinding }
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

it('keeps every listener and injected field on its carrier at every hop, the script body under its language tag', () => {
  for (const [label, ir] of rt.hops) {
    expect(fieldSignatures(ir), label).toEqual(EXPECTED_FIELDS);
    expect(listenerSignatures(ir), label).toEqual(EXPECTED_LISTENERS);
  }
  expect(rt.dslPrime).toContain('```javascript\n' + SCRIPT_BODY + '```');
});

it('writes the timeout listener with the id and timer child BpmnParse.parseTimeoutTaskListener requires, the script verbatim, bindings unprefixed', () => {
  for (const fragment of [
    [
      '<operaton:taskListener id="InspectVehicle_timeout_1" event="timeout" delegateExpression="${assessmentEscalation}">',
      '  <bpmn:timerEventDefinition>',
      '    <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT8H</bpmn:timeDuration>',
      '  </bpmn:timerEventDefinition>',
      '</operaton:taskListener>',
    ].join('\n          '),
    `<operaton:script scriptFormat="javascript">${SCRIPT_BODY}</operaton:script>`,
    '<operaton:executionListener event="start" class="com.example.claims.OpenAuditTrail">',
  ]) {
    expect(rt.frozenXml).toContain(fragment);
  }
});
