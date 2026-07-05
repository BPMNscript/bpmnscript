/**
 * Whole-feature E2E: construct round-trip idempotence + goto-degradation.
 *
 * This is the dedicated end-to-end test that exercises the whole feature as a
 * *user* would — authoring source, building it to BPMN, importing it back, and
 * restructuring it — over real infrastructure: real Langium parse, real
 * `bpmn-moddle` (via `irToXml`/`xmlToIr`), real `bpmn-auto-layout` (invoked
 * inside `irToXml`), and real fixture files. There is NO Docker and NO engine
 * here; the "real infrastructure" is the unmocked transform chain and the
 * on-disk golden fixtures.
 *
 * It complements `tests/round-trip.test.ts` (which imports a handwritten golden
 * with hand-named ids) by driving the structured constructs — `if`/`else`,
 * `while`, `parallel`, and `goto` — through the full pipeline
 *
 *   DSL → IR → XML → IR → DSL → IR
 *
 * Five scenarios, each a focused assertion on one part of the contract:
 *
 *   1. Structured idempotence (happy path) — `invoice-approval.bpmnscript`.
 *   2. Loop round-trip — the `while` of `structured-control-flow.bpmnscript`.
 *   3. Parallel round-trip — the `parallel { { } { } }` of the same fixture.
 *   4. Goto-degradation (totality) — the unstructured `unstructured-goto.bpmn`.
 *   5. Expression fallback — a bean method-call condition (raw `${…}`).
 *
 * Normalization is REUSED from the shared `helpers/normalize-ir.ts`; it is
 * never duplicated here.
 *
 * ── A note on scenario 4's invariant ───────────────────────────────────────
 * The goal is that the goto-degraded edge set be "identical … (compare
 * source/target pairs, not flow ids)". The *literal* flow-endpoint set cannot
 * be byte-identical across the round-trip: the original fixture has hand-named
 * gateways (`RouteA`/`RouteB`), whereas re-desugaring synthesizes fresh
 * deterministic gateway ids AND grows phantom XOR joins for the `if`s whose
 * branches are pure `goto`s (a documented behaviour — see CLAUDE.md:
 * "an `if` with empty/goto branches gains a phantom join"). Those phantom joins
 * have ZERO incoming flows, so `normalizeIr`'s pass-through-join inliner (which
 * requires ≥1 incoming) correctly leaves them in place — they are genuine
 * extra scaffolding, not a maskable id rename.
 *
 * The faithful realization of that intent — *no structural data loss*, i.e.
 * every authored node stays reachable from the same predecessors — is the
 * reachability relation between the REAL (non-gateway) nodes, with the
 * synthesized gateway routing contracted away. {@link realNodeReachability}
 * computes exactly that. Asserting it is identical across the import round-trip
 * proves totality: no edge between real nodes is lost or rewired. See the test
 * body for the explicit relaxation note.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The `invoice-approval` example. */
const INVOICE_DSL_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

/** The single-process fixture exercising if/else + while + parallel. */
const STRUCTURED_DSL_PATH = resolve(
  __dirname,
  'golden/structured-control-flow.bpmnscript',
);

/** The intentionally unstructured cross-branching fixture. */
const UNSTRUCTURED_BPMN_PATH = resolve(
  __dirname,
  'golden/unstructured-goto.bpmn',
);

// ---------------------------------------------------------------------------
// Langium parse helper — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the
 * source has any parser error — a round-tripped source that does not re-parse
 * is itself a round-trip failure, so it must abort the test, never be swallowed.
 */
async function parseToAst(source: string) {
  const document = await parse(source);
  const errors = document.parseResult.parserErrors;
  if (errors.length > 0) {
    throw new Error(
      'Parser errors in round-tripped DSL:\n' +
        errors.map((e) => e.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

/**
 * The reachability relation between the REAL (non-gateway) flow nodes, with
 * every gateway contracted to a transparent routing point.
 *
 * For each real node `r`, we walk forward across any number of gateways and
 * record `r -> t` for every real node `t` first reached. This collapses the
 * synthesized gateway scaffolding (splits, joins, phantom joins) that differs
 * between an imported graph and its re-desugared counterpart, leaving exactly
 * the authored-node connectivity — the quantity that must be preserved for the
 * round-trip to be lossless (totality, scenario 4).
 */
function realNodeReachability(ir: BpmnProcess): string[] {
  const isGateway = new Map<string, boolean>(
    ir.flowElements.map((fe) => [
      fe.id,
      fe.kind === 'exclusiveGateway' || fe.kind === 'parallelGateway',
    ]),
  );

  const outgoing = new Map<string, string[]>();
  for (const sf of ir.sequenceFlows) {
    (
      outgoing.get(sf.sourceRef) ??
      outgoing.set(sf.sourceRef, []).get(sf.sourceRef)!
    ).push(sf.targetRef);
  }

  const pairs = new Set<string>();
  for (const node of ir.flowElements) {
    if (isGateway.get(node.id)) continue; // start from real nodes only
    const seen = new Set<string>();
    const stack = [...(outgoing.get(node.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (isGateway.get(next)) {
        // Transparent: walk through the gateway to its successors.
        for (const t of outgoing.get(next) ?? []) stack.push(t);
      } else {
        pairs.add(`${node.id}->${next}`);
      }
    }
  }
  return [...pairs].sort();
}

// ===========================================================================
// Scenario 1 — Structured idempotence (happy path).
//
//   invoice-approval.bpmnscript → astToIr (ir1)
//     → irToXml → xmlToIr → irToDsl (dsl1)
//     → parse → astToIr (irFinal) → irToDsl (dsl2)
//
// The first IR and the final IR are equal up to documented id normalization,
// and dsl1 / dsl2 are byte-identical (deterministic synthesized ids).
// ===========================================================================

describe('Scenario 1 — structured idempotence (invoice-approval, if/else)', () => {
  let irInitial: BpmnProcess;
  let irFinal: BpmnProcess;
  let dsl1: string;
  let dsl2: string;

  beforeAll(async () => {
    const source = readFileSync(INVOICE_DSL_PATH, 'utf-8');

    irInitial = astToIr(await parseToAst(source));

    const xml = await irToXml(irInitial);
    const { ir: irImported } = await xmlToIr(xml);
    dsl1 = irToDsl(irImported);

    irFinal = astToIr(await parseToAst(dsl1));
    dsl2 = irToDsl(irFinal);
  });

  it('final IR equals initial IR up to documented id normalization', () => {
    expect(normalizeIr(irFinal)).toEqual(normalizeIr(irInitial));
  });

  it('re-emitted DSL is byte-identical to the first emitted DSL', () => {
    // Deterministic structural ids make the structured emission byte-stable, so
    // a second irToDsl over the re-desugared IR reproduces dsl1 exactly.
    expect(dsl2).toBe(dsl1);
  });

  it('the emitted DSL is structured syntax (if/else, no gateway/edge form)', () => {
    expect(dsl1).toContain('process invoice-approval');
    expect(dsl1).toContain('if (amount > 1000)');
    expect(dsl1).toContain('else');
    expect(dsl1).not.toContain('gateway');
    expect(dsl1).not.toContain('->');
  });

  it('the if-condition survives as a conditional flow in the final IR', () => {
    const conditional = irFinal.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditional).toBeDefined();
    expect(conditional!.conditionExpression).toBe('${amount > 1000}');
  });
});

// ===========================================================================
// Scenario 2 — Loop round-trip (`while`).
//
// The `while (retries < 3)` branch of structured-control-flow.bpmnscript
// survives DSL → XML → DSL reconstructed as `while`, with NO
// `standardLoopCharacteristics` anywhere in the XML and no `goto` fallback.
// ===========================================================================

describe('Scenario 2 — loop round-trip (while ⇒ conditioned back-edge, never standardLoopCharacteristics)', () => {
  let xml: string;
  let reemittedDsl: string;

  beforeAll(async () => {
    const source = readFileSync(STRUCTURED_DSL_PATH, 'utf-8');
    const ir = astToIr(await parseToAst(source));
    xml = await irToXml(ir);
    const { ir: imported } = await xmlToIr(xml);
    reemittedDsl = irToDsl(imported);
  });

  it('the BPMN XML contains no standardLoopCharacteristics', () => {
    // The catalogue (§3.4/§5) forbids loop-marker desugaring: a `while` is an
    // exclusiveGateway with a conditioned back-edge, never a loop-marker task.
    expect(xml).not.toContain('standardLoopCharacteristics');
  });

  it('the re-emitted DSL reconstructs the loop as `while`, with no goto', () => {
    expect(reemittedDsl).toMatch(/\bwhile\s*\(/);
    expect(reemittedDsl).toContain('while (retries < 3)');
    expect(reemittedDsl).not.toContain('goto');
  });

  it('the loop body task survives the round-trip verbatim', () => {
    expect(reemittedDsl).toContain(
      'service RetryFetch "Retry fetch" { class = "com.example.flow.RetryFetchDelegate" }',
    );
  });
});

// ===========================================================================
// Scenario 3 — Parallel round-trip (`parallel { { } { } }`).
//
// The parallel branch survives the full loop with a `bpmn:parallelGateway`
// fork+join pair in the XML and `parallel` reconstructed in the re-emitted DSL.
// ===========================================================================

describe('Scenario 3 — parallel round-trip (parallelGateway fork/join ⇒ parallel { { } { } })', () => {
  let xml: string;
  let reemittedDsl: string;

  beforeAll(async () => {
    const source = readFileSync(STRUCTURED_DSL_PATH, 'utf-8');
    const ir = astToIr(await parseToAst(source));
    xml = await irToXml(ir);
    const { ir: imported } = await xmlToIr(xml);
    reemittedDsl = irToDsl(imported);
  });

  it('the BPMN XML contains a parallelGateway fork and join (two parallelGateways)', () => {
    expect(xml).toContain('bpmn:parallelGateway');
    const forkJoin = xml.match(/<bpmn:parallelGateway\b/g) ?? [];
    expect(forkJoin.length).toBe(2); // exactly one fork + one join
  });

  it('the re-emitted DSL reconstructs the nested `parallel { { } { } }` construct', () => {
    expect(reemittedDsl).toMatch(/\bparallel\s*\{/);
    // Branches are nested brace blocks, not `and`-separated.
    expect(reemittedDsl).not.toContain('} and {');
    expect(reemittedDsl).not.toMatch(/\band\b/);
  });

  it('both parallel branch tasks survive the round-trip verbatim', () => {
    expect(reemittedDsl).toContain(
      'user NotifyOwner "Notify owner" { assignee = "demo" }',
    );
    expect(reemittedDsl).toContain(
      'service AuditLog "Write audit log" { class = "com.example.flow.AuditLogDelegate" }',
    );
  });
});

// ===========================================================================
// Scenario 4 — Goto-degradation (the key totality / data-loss path).
//
// Import the unstructured cross-branching fixture → `irToDsl` falls back to
// `goto` for the edges it cannot fold → re-parse → re-desugar. The full set of
// connections between authored nodes must be preserved, with no exception and
// no lost edge, across a SECOND round-trip too.
// ===========================================================================

describe('Scenario 4 — goto-degradation preserves the full edge set (totality)', () => {
  let irImport: BpmnProcess; // from xmlToIr(unstructured.bpmn)
  let degradedDsl: string; // irToDsl(irImport) — contains goto(s)
  let irReDesugared: BpmnProcess; // astToIr(parse(degradedDsl))
  let irSecondRound: BpmnProcess; // astToIr(parse(irToDsl(irReDesugared)))

  beforeAll(async () => {
    const xml = readFileSync(UNSTRUCTURED_BPMN_PATH, 'utf-8');

    // xmlToIr must read an irreducible graph without throwing.
    ({ ir: irImport } = await xmlToIr(xml));
    degradedDsl = irToDsl(irImport);
    irReDesugared = astToIr(await parseToAst(degradedDsl));

    // A second full round-trip — must be just as total.
    const dsl2 = irToDsl(irReDesugared);
    irSecondRound = astToIr(await parseToAst(dsl2));
  });

  it('importing the unstructured fixture and re-emitting never throws', () => {
    // The beforeAll already exercised the whole chain; reaching here is the
    // assertion. We additionally pin the import shape so this is not vacuous.
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
    // RELAXATION vs. the literal "the edge set is identical" wording.
    // The raw flow-endpoint set cannot match byte-for-byte: the import has
    // hand-named gateways (RouteA/RouteB), while re-desugaring synthesizes
    // fresh deterministic gateway ids AND grows phantom XOR joins for the `if`s
    // whose branches are pure `goto`s (documented behaviour). Those phantom
    // joins have zero incoming flows, so they are genuine extra scaffolding,
    // not a maskable rename. The invariant that captures "no structural data
    // loss" — the actual intent — is the connectivity between the REAL
    // authored nodes with gateway routing contracted away, which IS identical.
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
    // Real-node reachability is condition-agnostic: a silently-stripped
    // `conditionExpression` on a surviving edge would NOT change the reachable
    // set and would pass the reachability checks above. Pin the conditions
    // explicitly. The fixture carries `${route == 'A'}` and `${retry == true}`;
    // the round-trip canonicalises the single-quoted string literal to double
    // quotes (`'A'` → `"A"`), so the expected re-desugared set is the canonical
    // form. Both conditions must still be present after the goto degradation.
    const reConditions = irReDesugared.sequenceFlows
      .map((f) => f.conditionExpression)
      .filter((c): c is string => c !== undefined)
      .sort();
    expect(reConditions).toEqual(
      ['${retry == true}', '${route == "A"}'].sort(),
    );
  });

  it('every authored node from the import is still present after re-desugaring', () => {
    // Totality at the node level: no real (non-gateway) node is dropped.
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
    // Proves the reachability assertion is not a vacuous always-true compare:
    // removing one import flow changes the relation, so the equality above is
    // load-bearing.
    const corrupt: BpmnProcess = {
      ...irImport,
      sequenceFlows: irImport.sequenceFlows.slice(1),
    };
    expect(realNodeReachability(corrupt)).not.toEqual(
      realNodeReachability(irImport),
    );
  });
});

// ===========================================================================
// Scenario 5 — Expression fallback round-trip (bean method call).
//
// A condition using a bean method call (`${myBean.check()}`) is outside the
// JUEL native subset (the trailing `()` leaves tokens unconsumed → raw
// fallback). It must survive DSL → XML → DSL as the SAME quoted raw form,
// without being mis-parsed into a structured subset expression.
// ===========================================================================

describe('Scenario 5 — bean-call condition stays quoted-raw end-to-end', () => {
  // Authored inline rather than as a new fixture file.
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

  let irInitial: BpmnProcess;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(BEAN_DSL));
    const xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('the bean call is preserved verbatim in the IR condition expression', () => {
    const initialCond = irInitial.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(initialCond?.conditionExpression).toBe('${myBean.check()}');

    const importedCond = irImported.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(importedCond?.conditionExpression).toBe('${myBean.check()}');
  });

  it('the re-emitted DSL keeps the condition as the quoted raw `"${…}"` form', () => {
    // Quoted-raw: NOT unquoted into a structured subset expression.
    expect(reemittedDsl).toContain('if ("${myBean.check()}")');
    // Negative guard: the bare (unquoted) form must NOT appear, which would
    // signal a spurious parse-into-subset.
    expect(reemittedDsl).not.toContain('if (myBean.check())');
  });

  it('the re-emitted DSL re-parses, and re-desugars to the same raw condition', async () => {
    const reIr = astToIr(await parseToAst(reemittedDsl));
    const cond = reIr.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(cond?.conditionExpression).toBe('${myBean.check()}');
  });
});
