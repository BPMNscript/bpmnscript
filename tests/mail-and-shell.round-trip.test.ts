import { it, expect } from 'vitest';

import type { ServiceTaskBinding } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { bindingOf } from './helpers/ir-query.js';

const rt = roundTripFixture('mail-and-shell', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

const BUILTIN_BINDINGS: Record<string, ServiceTaskBinding> = {
  RateSeverity: {
    kind: 'builtin',
    type: 'shell',
    fields: [{ name: 'command', value: 'rate-severity' }],
  },
  PageOnCall: {
    kind: 'builtin',
    type: 'shell',
    fields: [
      { name: 'command', value: 'page' },
      { name: 'arg1', value: 'oncall' },
      { name: 'outputVariable', value: 'pageReceipt' },
      { name: 'errorCodeVariable', value: 'pageExitCode' },
      { name: 'wait', value: 'true' },
    ],
  },
  MailOnCall: {
    kind: 'builtin',
    type: 'mail',
    fields: [
      { name: 'to', value: 'oncall@example.com' },
      { name: 'cc', value: 'ops-lead@example.com' },
      { name: 'subject', value: '${summary}' },
      {
        name: 'text',
        value: 'An incident was logged. Open the HTML part for its details.',
      },
      { name: 'html', value: '${details}' },
    ],
  },
};

it('keeps every field on all three tags at each hop and through import, the type on the head, the fields in both value slots', () => {
  for (const [label, ir] of [
    ...rt.hops,
    ['imported', rt.irFromImport],
  ] as const) {
    for (const [id, binding] of Object.entries(BUILTIN_BINDINGS)) {
      expect(bindingOf(ir, id), `${id} in ${label}`).toStrictEqual(binding);
    }
  }
  expect(rt.frozenXml).toContain(
    '<bpmn:businessRuleTask id="RateSeverity" name="Rate the severity" operaton:type="shell">\n' +
      '      <bpmn:extensionElements>\n' +
      '        <operaton:field name="command" stringValue="rate-severity" />\n' +
      '      </bpmn:extensionElements>',
  );
  expect(rt.frozenXml).toContain(
    '<bpmn:sendTask id="PageOnCall" name="Page the on-call engineer" operaton:type="shell">\n' +
      '      <bpmn:extensionElements>\n' +
      '        <operaton:field name="command" stringValue="page" />\n' +
      '        <operaton:field name="arg1" stringValue="oncall" />\n' +
      '        <operaton:field name="outputVariable" stringValue="pageReceipt" />\n' +
      '        <operaton:field name="errorCodeVariable" stringValue="pageExitCode" />\n' +
      '        <operaton:field name="wait" stringValue="true" />\n' +
      '      </bpmn:extensionElements>',
  );
  expect(rt.frozenXml).toContain(
    '<bpmn:serviceTask id="MailOnCall" name="Mail the on-call engineer" operaton:type="mail">\n' +
      '      <bpmn:extensionElements>\n' +
      '        <operaton:field name="to" stringValue="oncall@example.com" />\n' +
      '        <operaton:field name="cc" stringValue="ops-lead@example.com" />\n' +
      '        <operaton:field name="subject">\n' +
      '          <operaton:expression>${summary}</operaton:expression>\n' +
      '        </operaton:field>\n' +
      '        <operaton:field name="text" stringValue="An incident was logged. Open the HTML part for its details." />\n' +
      '        <operaton:field name="html">\n' +
      '          <operaton:expression>${details}</operaton:expression>\n' +
      '        </operaton:field>\n' +
      '      </bpmn:extensionElements>',
  );
  const lines = rt.dslPrime
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(service|send|decide|field) /.test(line));
  expect(lines).toEqual([
    'decide RateSeverity(label: "Rate the severity", type: "shell") {',
    'field command = "rate-severity"',
    'send PageOnCall(label: "Page the on-call engineer", type: "shell") {',
    'field command = "page"',
    'field arg1 = "oncall"',
    'field outputVariable = "pageReceipt"',
    'field errorCodeVariable = "pageExitCode"',
    'field wait = "true"',
    'service MailOnCall(label: "Mail the on-call engineer", type: "mail") {',
    'field to = "oncall@example.com"',
    'field cc = "ops-lead@example.com"',
    'field subject = "${summary}"',
    'field text = "An incident was logged. Open the HTML part for its details."',
    'field html = "${details}"',
  ]);
});
