import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, irToDsl, astToIr } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { realNodeReachability } from './helpers/real-node-reachability.js';
import { parse, parseToAst, roundTripOf } from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INVOICE_DSL_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const STRUCTURED_DSL_PATH = resolve(
  __dirname,
  'golden/structured-control-flow.bpmnscript',
);

const UNSTRUCTURED_BPMN_PATH = resolve(
  __dirname,
  'golden/unstructured-goto.bpmn',
);

describe('structured idempotence (invoice-approval, if/else)', () => {
  const run = roundTripOf(readFileSync(INVOICE_DSL_PATH, 'utf-8'));
  let dsl2: string;

  beforeAll(() => {
    dsl2 = irToDsl(run.ir3);
  });

  it('final IR equals initial IR up to documented id normalization', () => {
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
  });

  it('re-emitted DSL is byte-identical to the first emitted DSL', () => {
    // Deterministic structural ids make the emission byte-stable, so a second
    // irToDsl over the re-desugared IR reproduces the first exactly.
    expect(dsl2).toBe(run.dsl);
  });

  it('the emitted DSL is structured syntax (if/else, no gateway/edge form)', () => {
    expect(run.dsl).toContain('process invoice-approval');
    expect(run.dsl).toContain('if (amount > 1000)');
    expect(run.dsl).toContain('else');
    expect(run.dsl).not.toContain('gateway');
    expect(run.dsl).not.toContain('->');
  });

  it('the if-condition survives as a conditional flow in the final IR', () => {
    const conditional = run.ir3.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditional).toBeDefined();
    expect(conditional!.conditionExpression).toBe('${amount > 1000}');
  });
});

describe('loop round-trip (while => conditioned back-edge, never standardLoopCharacteristics)', () => {
  const run = roundTripOf(readFileSync(STRUCTURED_DSL_PATH, 'utf-8'));

  it('the BPMN XML contains no standardLoopCharacteristics', () => {
    // A `while` desugars to a conditioned back-edge, not a loop-marker task.
    expect(run.xml).not.toContain('standardLoopCharacteristics');
  });

  it('the re-emitted DSL reconstructs the loop as `while`, with no goto', () => {
    expect(run.dsl).toMatch(/\bwhile\s*\(/);
    expect(run.dsl).toContain('while (retries < 3)');
    expect(run.dsl).not.toContain('goto');
  });

  it('the loop body task survives the round-trip verbatim', () => {
    expect(run.dsl).toContain(
      'service RetryFetch "Retry fetch" { class = "com.example.flow.RetryFetchDelegate" }',
    );
  });
});

describe('parallel round-trip (parallelGateway fork/join => parallel { { } { } })', () => {
  const run = roundTripOf(readFileSync(STRUCTURED_DSL_PATH, 'utf-8'));

  it('the BPMN XML contains a parallelGateway fork and join (two parallelGateways)', () => {
    expect(run.xml).toContain('bpmn:parallelGateway');
    const forkJoin = run.xml.match(/<bpmn:parallelGateway\b/g) ?? [];
    expect(forkJoin.length).toBe(2); // exactly one fork + one join
  });

  it('the re-emitted DSL reconstructs the nested `parallel { { } { } }` construct', () => {
    expect(run.dsl).toMatch(/\bparallel\s*\{/);
    expect(run.dsl).not.toContain('} and {');
    expect(run.dsl).not.toMatch(/\band\b/);
  });

  it('both parallel branch tasks survive the round-trip verbatim', () => {
    expect(run.dsl).toContain(
      'user NotifyOwner "Notify owner" { assignee = "demo" }',
    );
    expect(run.dsl).toContain(
      'service AuditLog "Write audit log" { class = "com.example.flow.AuditLogDelegate" }',
    );
  });
});

// Every edge in this fixture has a `goto` form, so the whole set of connections
// between authored nodes survives, over a second round trip too. Edges with no
// form at all belong to the goto-fallback suite.
describe('goto-degradation preserves the edges that have a goto form', () => {
  let irImport: BpmnProcess; // from xmlToIr(unstructured.bpmn)
  let degradedDsl: string; // irToDsl(irImport), contains goto(s)
  let irReDesugared: BpmnProcess; // astToIr(parse(degradedDsl))
  let irSecondRound: BpmnProcess; // astToIr(parse(irToDsl(irReDesugared)))

  beforeAll(async () => {
    const xml = readFileSync(UNSTRUCTURED_BPMN_PATH, 'utf-8');

    ({ ir: irImport } = await xmlToIr(xml));
    degradedDsl = irToDsl(irImport);
    irReDesugared = astToIr(await parseToAst(degradedDsl));

    const dsl2 = irToDsl(irReDesugared);
    irSecondRound = astToIr(await parseToAst(dsl2));
  });

  it('importing the unstructured fixture and re-emitting never throws', () => {
    // The beforeAll ran the whole chain, so reaching here is most of the
    // assertion. Pinning the import shape keeps it from being vacuous.
    expect(irImport.id).toBe('unstructured-goto');
    expect(irImport.sequenceFlows.length).toBeGreaterThan(0);
  });

  it('the degraded DSL falls back to at least one `goto`', () => {
    expect(degradedDsl).toContain('goto');
    const gotos = degradedDsl.match(/\bgoto\b/g) ?? [];
    expect(gotos.length).toBeGreaterThanOrEqual(1);
  });

  it('the re-desugared DSL re-parses with zero parser errors', async () => {
    const document = await parse(degradedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('the real-node reachability is identical after the round-trip', () => {
    // Raw flow endpoints cannot match: the import has hand-named gateways
    // (RouteA/RouteB) while re-desugaring synthesizes fresh ids and grows XOR
    // joins for the `if`s whose branches are pure `goto`s. Compare authored-node
    // connectivity with gateway routing contracted away instead.
    expect(realNodeReachability(irReDesugared)).toEqual(
      realNodeReachability(irImport),
    );
  });

  it('a SECOND round-trip preserves the same real-node reachability (idempotent totality)', () => {
    expect(realNodeReachability(irSecondRound)).toEqual(
      realNodeReachability(irReDesugared),
    );
  });

  it('the fixture conditions survive the goto-degradation round-trip', () => {
    // Reachability is condition-agnostic: a `conditionExpression` stripped off a
    // surviving edge passes every check above, so pin the conditions too. The
    // round trip canonicalizes the fixture's single-quoted literal to double
    // quotes, hence the shifted spelling in the expected set.
    const reConditions = irReDesugared.sequenceFlows
      .map((f) => f.conditionExpression)
      .filter((c): c is string => c !== undefined)
      .sort();
    expect(reConditions).toEqual(
      ['${retry == true}', '${route == "A"}'].sort(),
    );
  });

  it('every authored node from the import is still present after re-desugaring', () => {
    const realIds = (ir: BpmnProcess) =>
      ir.flowElements
        .filter(
          (fe) =>
            fe.kind !== 'exclusiveGateway' && fe.kind !== 'parallelGateway',
        )
        .map((fe) => fe.id)
        .sort();
    expect(realIds(irReDesugared)).toEqual(realIds(irImport));
  });

  it('the meaningfulness guard: a dropped edge would make reachability differ', () => {
    // Removing one import flow changes the relation, so the equality above is
    // load-bearing rather than always-true.
    const corrupt: BpmnProcess = {
      ...irImport,
      sequenceFlows: irImport.sequenceFlows.slice(1),
    };
    expect(realNodeReachability(corrupt)).not.toEqual(
      realNodeReachability(irImport),
    );
  });
});

// A bean method call is outside the JUEL native subset: the trailing `()`
// leaves tokens unconsumed, so it takes the raw fallback and has to survive the
// round trip as the same quoted raw form.
describe('bean-call condition stays quoted-raw end-to-end', () => {
  const BEAN_DSL = [
    'process bean-cond "Bean Cond" {',
    '  start S',
    '  if ("${myBean.check()}") {',
    '    user Approve "Approve" { assignee = "demo" }',
    '  } else {',
    '    user Reject "Reject" { assignee = "demo" }',
    '  }',
    '  end E',
    '}',
    '',
  ].join('\n');

  const run = roundTripOf(BEAN_DSL);

  const condition = (ir: BpmnProcess) =>
    ir.sequenceFlows.find((sf) => sf.conditionExpression !== undefined)
      ?.conditionExpression;

  it('the bean call is preserved verbatim in the IR condition expression', () => {
    expect(condition(run.ir1)).toBe('${myBean.check()}');
    expect(condition(run.ir2)).toBe('${myBean.check()}');
  });

  it('the re-emitted DSL keeps the condition as the quoted raw `"${...}"` form', () => {
    expect(run.dsl).toContain('if ("${myBean.check()}")');
    // The bare (unquoted) form would signal a spurious parse-into-subset.
    expect(run.dsl).not.toContain('if (myBean.check())');
  });

  it('the re-emitted DSL re-parses, and re-desugars to the same raw condition', () => {
    expect(condition(run.ir3)).toBe('${myBean.check()}');
  });
});
