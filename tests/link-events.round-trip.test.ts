// A link throw ends its path and a link catch opens one, matched by name and
// never by a flow, so every hop of the round trip must keep all five link
// events under their authored ids and names, with no flow leaving a throw or
// entering a catch, in the sub-process as at the top.

import { describe, it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import {
  describeDiContainment,
  describeNoOverlappingShapes,
} from './helpers/di-bounds.js';
import { allElements, allOf } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('link-events', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

const LINK_EVENTS = [
  ['intermediateCatchEvent', 'AtAudit', { kind: 'link', linkName: 'Audit' }],
  ['intermediateCatchEvent', 'AtRework', { kind: 'link', linkName: 'Rework' }],
  [
    'intermediateThrowEvent',
    'ReworkMissingReceipts',
    { kind: 'link', linkName: 'Rework' },
  ],
  [
    'intermediateThrowEvent',
    'ReworkRejected',
    { kind: 'link', linkName: 'Rework' },
  ],
  ['intermediateThrowEvent', 'ToAudit', { kind: 'link', linkName: 'Audit' }],
] as const;

const idsOfKind = (kind: string): Set<string> =>
  new Set(LINK_EVENTS.filter(([k]) => k === kind).map(([, id]) => id));
const THROW_IDS = idsOfKind('intermediateThrowEvent');
const CATCH_IDS = idsOfKind('intermediateCatchEvent');

function containersOf(ir: FlowContainer): FlowContainer[] {
  return [ir, ...allOf(ir, 'subProcess')];
}

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('both ends of every pair keep their link name at every hop, and no flow leaves a throw or enters a catch', () => {
    for (const [label, ir] of rt.hops) {
      const linkEvents = allElements(ir)
        .filter(
          (fe) =>
            fe.kind === 'intermediateThrowEvent' ||
            fe.kind === 'intermediateCatchEvent',
        )
        .map((fe) => [fe.kind, fe.id, fe.eventDefinition])
        .sort(([, a], [, b]) => (a as string).localeCompare(b as string));
      expect(linkEvents, `link event set differs in ${label}`).toEqual(
        LINK_EVENTS,
      );

      for (const container of containersOf(ir)) {
        expect(
          container.sequenceFlows.filter(
            (flow) =>
              THROW_IDS.has(flow.sourceRef) || CATCH_IDS.has(flow.targetRef),
          ),
          `a flow touches a link event's closed side in ${container.id} of ${label}`,
        ).toEqual([]);
      }
    }
  });

  it("the decompiled DSL' places each catch after a dead fall-through and keeps the rework chain structured", () => {
    expect(rt.dslPrime).toContain(
      [
        '  end Closed(label: "Claim closed")',
        '  emit link ReworkMissingReceipts("Rework")',
        '  emit link ReworkRejected("Rework")',
        '  await link AtRework("Rework", asyncBefore: true)',
        '  user ReworkClaim(label: "Rework the claim", assignee: "demo")',
        '  if (amount > 5000) {',
        '    user EscalateRework(label: "Escalate the rework", assignee: "manager")',
        '  } else {',
        '    user NoteRework(label: "Note the rework", assignee: "demo")',
        '  }',
        '  goto AssessClaim',
      ].join('\n'),
    );
    expect(rt.dslPrime).toContain(
      [
        '    end Settled',
        '    emit link ToAudit("Audit")',
        '    await link AtAudit("Audit")',
        '    user AuditPayout(label: "Audit the payout", assignee: "manager")',
        '    end Audited',
      ].join('\n'),
    );
  });
});

describe('the frozen .bpmn carries the link pair the engine matches on', () => {
  it('names both ends of each pair with the link name and carries asyncBefore on the catch alone', () => {
    const named = [
      ...rt.frozenXml.matchAll(
        /<bpmn:intermediate(?:Throw|Catch)Event id="([^"]+)" name="([^"]+)"/g,
      ),
    ]
      .map(([, id, name]) => [id, name])
      .sort(([a], [b]) => a!.localeCompare(b!));
    expect(named).toEqual(LINK_EVENTS.map(([, id, def]) => [id, def.linkName]));

    expect(rt.frozenXml.match(/operaton:asyncBefore="true"/g)).toHaveLength(1);
    expect(
      [
        ...rt.frozenXml.matchAll(
          /<bpmn:\w+ id="([^"]+)"[^>]*operaton:asyncBefore="true"/g,
        ),
      ].map(([, id]) => id),
    ).toEqual(['AtRework']);
  });
});

describeNoOverlappingShapes(rt);
describeDiContainment(rt, ['Settlement', 'ToAudit', 'AtAudit']);
