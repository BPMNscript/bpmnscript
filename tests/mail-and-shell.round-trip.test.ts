// The three tags that take a `type` binding each carry one of the two
// behaviours Operaton builds itself, with the fields the engine sets on it, so
// a field that stops travelling in one direction or a type that comes back in
// another spelling fails the whole-object comparison below. A dropped
// `resultVariable` sits beside the binding, so the frozen tag, the printed
// head, and the fixture's idempotence check catch that one instead.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess, ServiceTaskBinding } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { describeNoOverlappingShapes } from './helpers/di-bounds.js';
import { bindingOf } from './helpers/ir-query.js';

const rt = roundTripFixture('mail-and-shell', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// Revert: any direction dropping a field or the type, or `xmlToIr` reading the
// type through the external branch.
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

describe('the frozen mail-and-shell binding contract', () => {
  it('every field survives at each hop and through import, on all three tags', () => {
    const runs: (readonly [label: string, ir: BpmnProcess])[] = [
      ...rt.hops,
      ['imported', rt.irFromImport],
    ];
    for (const [label, ir] of runs) {
      for (const id of Object.keys(BUILTIN_BINDINGS)) {
        expect(
          bindingOf(ir, id),
          `${id}.binding differs in ${label}`,
        ).toStrictEqual(BUILTIN_BINDINGS[id]);
      }
    }
  });

  // Revert: `codeBindingFields` in `irToXml` not treating `builtin` as a
  // carrier -> every field child gone.
  it('the frozen artifact writes the type on each tag and the fields in both value slots', () => {
    expect(rt.frozenXml).toContain(
      '<bpmn:businessRuleTask id="RateSeverity" name="Rate the severity" operaton:type="shell">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:field name="command" stringValue="rate-severity" />\n' +
        '      </bpmn:extensionElements>',
    );
    expect(rt.frozenXml).toContain(
      '<bpmn:sendTask id="PageOnCall" name="Page the on-call engineer" operaton:type="shell" operaton:resultVariable="pageResult">\n' +
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
  });

  // The whole set of heads and field lines, so a field printed on a tag that
  // carries none fails too. The harness re-parses and validates DSL' as a
  // whole. Revert: `fieldMembers` in `irToDsl` not treating `builtin` as a
  // carrier -> every field line gone.
  it('the printed script carries the type on the head and the fields as members', () => {
    const lines = rt.dslPrime
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(service|send|decide|field) /.test(line));
    expect(lines).toEqual([
      'decide RateSeverity(label: "Rate the severity", type: "shell") {',
      'field command = "rate-severity"',
      'send PageOnCall(label: "Page the on-call engineer", type: "shell", resultVariable: "pageResult") {',
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
});

describeNoOverlappingShapes(rt);
