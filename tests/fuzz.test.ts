// Round-trip fuzz harness over generated programs.
//
// Per seed: generate a program, validate it, then push its source through
// parse -> astToIr -> irToXml -> xmlToIr -> irToDsl -> validate -> astToIr,
// each stage inside a try, with the outcome classified (`runPipeline`,
// `symptomOf`). A validator-clean seed fails the oracle when its class is
// `crash`, `timeout`, `import-refused`, `dsl-invalid`, `silent-change` or
// `warned-restructuring`, when its first print carries any print warning, or
// when its second print differs from its first (`failingSeeds`, one
// `toEqual([])` assertion over every one of those). A seed counts as clean
// when `compareModels` (`./helpers/model-equivalence.ts`) reports `same`,
// `canonical` (differs only by JUEL quote style or a minted coordinate id)
// or `restructured` (a documented hoist, backward `goto` or branch sinking
// that keeps every step's content and the routes between them); only
// `changed` can fail.
//
// Environment: FUZZ_N (programs, default 200), FUZZ_SEED (first seed,
// default 1; program i uses FUZZ_SEED + i), FUZZ_OUT (output directory;
// when set, writes `results.jsonl`, `summary.json` and minimized programs
// under `min/` and runs minimization; when unset, writes nothing and skips
// minimization), FUZZ_SHUFFLE (`reverse`, or a number that seeds a
// permutation; unset runs in compiler order). The same FUZZ_SEED and FUZZ_N
// reproduce the same corpus on any tree; minimization re-applies the same
// FUZZ_SHUFFLE mode to every candidate.
//
// FUZZ_SHUFFLE reorders the imported model's `flowElements` and
// `sequenceFlows`, in the process and every nested container, before the
// first print: as another BPMN tool might list them. A gateway's own
// outgoing flows keep their relative order within that reordering, because
// Operaton evaluates a gateway's conditioned routes in document order, so
// shuffling them would change which route the model actually takes, not
// just how the printer reads it. Keeping route order fixed removes that
// artifact instead of asking the comparison to reconstruct
// engine-observable order semantics.
//
// Another tool can still list a gateway's routes in any order, so a seed that
// passes in that mode is printed a second time with every flow reordered,
// routes included (`runSeed`). That print is a different model, so it skips
// the comparison and fails only on the other conditions: a crash or refusal,
// output the validator refuses, a print warning, or a second pass that
// differs. Its symptoms carry a `routes|` prefix.
//
// Full run: FUZZ_N=2000 FUZZ_OUT=<dir> npm test --workspace tests -- fuzz.test.ts

import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import {
  astToIr,
  irToDsl,
  irToXml,
  xmlToIr,
  LayoutError,
  UnsupportedConstructError,
} from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';
import type { Model } from '@bpmn-script/language';

import { validate } from './helpers/pipeline.js';
import { normalizeIr } from './helpers/normalize-ir.js';
import {
  compareModels,
  type ModelComparison,
} from './helpers/model-equivalence.js';
import {
  generateProgram,
  minimize,
  renderProgram,
  PROCESS_NAMES,
  type Program,
} from './helpers/fuzz-generator.js';

const N = Number(process.env.FUZZ_N ?? 200);
const SEED = Number(process.env.FUZZ_SEED ?? 1);
const OUT = process.env.FUZZ_OUT;
const TIMEOUT_MS = 10_000;
const MIN_BUDGET_MS = 180_000;

type ShuffleMode = 'reverse' | number;

function parseShuffleMode(raw: string | undefined): ShuffleMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'reverse') return 'reverse';
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `FUZZ_SHUFFLE must be "reverse" or a number, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

const SHUFFLE = parseShuffleMode(process.env.FUZZ_SHUFFLE);

// A seeded LCG, so (programSeed, mode) always draws the same permutation.
function permutationRng(programSeed: number, mode: number): () => number {
  let state = Math.abs(programSeed * 2654435761 + mode) % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function permuted<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Reorders a flow list the way another BPMN tool might list it, keeping each
// source's own outgoing flows in their original relative order: Operaton
// evaluates a gateway's conditioned routes in document order, so shuffling
// them changes which route the model takes, not just how the printer reads
// it (see the header comment). Only the order of the (source, group) blocks
// shuffles.
function reorderFlows<F extends { sourceRef: string }>(
  flows: readonly F[],
  mode: ShuffleMode,
  rand: () => number,
): F[] {
  const bySource = new Map<string, F[]>();
  const sourceOrder: string[] = [];
  for (const f of flows) {
    let group = bySource.get(f.sourceRef);
    if (group === undefined) {
      group = [];
      bySource.set(f.sourceRef, group);
      sourceOrder.push(f.sourceRef);
    }
    group.push(f);
  }
  const reorderedSources =
    mode === 'reverse' ? sourceOrder.toReversed() : permuted(sourceOrder, rand);
  return reorderedSources.flatMap((s) => bySource.get(s)!);
}

// Reorders `flowElements` and `sequenceFlows` of `container` and every
// nested sub-process body before the first print, a gateway's own routes
// too when `routes` is set. One `rand` stream is shared across the whole
// walk, so nested containers of the same size still draw distinct
// permutations.
function reorderContainer<T extends FlowContainer>(
  container: T,
  mode: ShuffleMode,
  rand: () => number,
  routes: boolean,
): T {
  const reorderElements = (items: readonly FlowElement[]): FlowElement[] =>
    mode === 'reverse' ? items.toReversed() : permuted(items, rand);
  const walk = (c: FlowContainer): FlowContainer => {
    const flowElements = reorderElements(c.flowElements).map((el) =>
      el.kind === 'subProcess'
        ? (walk(el as unknown as FlowContainer) as unknown as FlowElement)
        : el,
    );
    return {
      ...c,
      flowElements,
      sequenceFlows: routes
        ? mode === 'reverse'
          ? c.sequenceFlows.toReversed()
          : permuted(c.sequenceFlows, rand)
        : reorderFlows(c.sequenceFlows, mode, rand),
    };
  };
  return walk(container) as T;
}

type Cls =
  | 'crash'
  | 'timeout'
  | 'import-refused'
  | 'dsl-invalid'
  | 'silent-change'
  | 'warned-restructuring'
  | 'clean';

const CLASS_ORDER: Cls[] = [
  'crash',
  'timeout',
  'import-refused',
  'dsl-invalid',
  'silent-change',
  'warned-restructuring',
  'clean',
];

// A validator-clean seed fails on one of these classes regardless of the
// second pass, when its first print carries any print warning (which
// includes every `warned-restructuring` seed, since that class requires at
// least one), or when the second print differs from the first.
const FAIL_CLASSES = new Set<Cls>([
  'crash',
  'timeout',
  'import-refused',
  'dsl-invalid',
  'silent-change',
  'warned-restructuring',
]);

interface Outcome {
  cls: Cls;
  stage: string;
  message: string;
  errorName?: string;
  symptom: string;
  comparison?: ModelComparison;
  importWarnings?: number;
  importWarningCategories: string[];
  importWarningMessages: string[];
  unstableLines?: {
    kind: 'digits-only' | 'text';
    before: string;
    after: string;
  };
  printWarningCategories: string[];
  layoutFallback: boolean;
  secondPassStable?: boolean;
  routesShuffled: boolean;
  dsl1?: string;
  diff?: string[];
  diffEntries?: DiffEntry[];
  ms: number;
}

class TimeoutError extends Error {
  constructor(stage: string) {
    super(`stage ${stage} exceeded ${TIMEOUT_MS} ms`);
    this.name = 'TimeoutError';
  }
}

// Bounds an async stage. A stage that never yields to the event loop cannot be
// interrupted from inside the process; the bound fires as soon as it does.
async function bounded<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(stage)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn(), clock]);
  } finally {
    clearTimeout(timer);
  }
}

function isRefusal(e: unknown): e is UnsupportedConstructError {
  return e instanceof UnsupportedConstructError;
}

// `toEqual` semantics on a string: sorted keys, `undefined` dropped.
function stable(x: unknown): string {
  return JSON.stringify(x, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, o[k]]),
      );
    }
    return v;
  });
}

// Element lists keyed by id so a diff names elements, not positions.
function keyed(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (
      v.length > 0 &&
      v.every((e) => e && typeof e === 'object' && 'id' in e)
    ) {
      const o: Record<string, unknown> = {};
      for (const e of v) o[(e as { id: string }).id] = keyed(e);
      return o;
    }
    return v.map(keyed);
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, keyed(o[k])]),
    );
  }
  return v;
}

interface DiffEntry {
  path: string;
  kind: 'only-before' | 'only-after' | 'changed';
  before?: unknown;
  after?: unknown;
}

function diffPaths(
  a: unknown,
  b: unknown,
  path = '',
  out: DiffEntry[] = [],
): DiffEntry[] {
  if (out.length >= 40) return out;
  if (stable(a) === stable(b)) return out;
  const isObj = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object';
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, kind: 'only-after', after: b[k] });
      else if (!(k in b))
        out.push({ path: p, kind: 'only-before', before: a[k] });
      else diffPaths(a[k], b[k], p, out);
    }
    return out;
  }
  out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

function diffText(d: DiffEntry): string {
  if (d.kind === 'only-after')
    return `${d.path}: only after = ${short(d.after)}`;
  if (d.kind === 'only-before')
    return `${d.path}: only before = ${short(d.before)}`;
  return `${d.path}: ${short(d.before)} -> ${short(d.after)}`;
}

function short(x: unknown): string {
  const s = stable(x) ?? 'undefined';
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

// The generator's four process names and every counter, so one symptom is one
// key whatever process and statement numbers a seed drew.
const PROCESS_NAME_PATTERN = new RegExp(PROCESS_NAMES.join('|'), 'g');

function normalizeMessage(m: string): string {
  return m
    .replace(PROCESS_NAME_PATTERN, '<process>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

// The leaves a structural diff touched, digits and process names blanked so a
// moved coordinate or a different statement count does not split the group.
function diffShape(diff: DiffEntry[]): string {
  const leaf = (path: string): string => {
    const segs = path.replace(/^\(positional\) /, '').split('.');
    return segs[segs.length - 1]
      .replace(PROCESS_NAME_PATTERN, '<process>')
      .replace(/\d+/g, '#');
  };
  const leaves = [...new Set(diff.map((d) => leaf(d.path)))].sort();
  return leaves.slice(0, 4).join(',');
}

function firstLineDifference(
  a: string,
  b: string,
): { kind: 'digits-only' | 'text'; before: string; after: string } {
  const la = a.split('\n');
  const lb = b.split('\n');
  let kind: 'digits-only' | 'text' = 'digits-only';
  let first: { before: string; after: string } | undefined;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const x = la[i] ?? '<none>';
    const y = lb[i] ?? '<none>';
    if (x === y) continue;
    first ??= { before: x.trim(), after: y.trim() };
    if (x.replace(/\d+/g, '#') !== y.replace(/\d+/g, '#')) kind = 'text';
  }
  return { kind, ...(first ?? { before: '', after: '' }) };
}

async function parseModel(text: string): Promise<{
  model: Model;
  errors: string[];
  warnings: string[];
  dispose: () => Promise<void>;
}> {
  const result = await validate(text);
  const messageOf = (m: string | { value: string }): string =>
    typeof m === 'string' ? m : m.value;
  const errors = result.diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => messageOf(d.message));
  const warnings = result.diagnostics
    .filter((d) => d.severity === 2)
    .map((d) => messageOf(d.message));
  const dispose =
    (result as { dispose?: () => Promise<void> }).dispose ?? (async () => {});
  return {
    model: result.document.parseResult.value,
    errors,
    warnings,
    dispose,
  };
}

async function compile(text: string): Promise<BpmnProcess> {
  const { model, errors, dispose } = await parseModel(text);
  try {
    if (errors.length > 0)
      throw new Error('parse/validation errors: ' + errors[0]);
    return astToIr(model);
  } finally {
    await dispose();
  }
}

function fails(o: Outcome): boolean {
  return (
    FAIL_CLASSES.has(o.cls) ||
    o.printWarningCategories.length > 0 ||
    o.secondPassStable === false
  );
}

// The route-order-preserving run, and in FUZZ_SHUFFLE mode the fully
// reordered one when the first passes (see the header comment).
async function runSeed(text: string, programSeed: number): Promise<Outcome> {
  const o = await runPipeline(text, programSeed, false);
  if (SHUFFLE === undefined || fails(o)) return o;
  const routes = await runPipeline(text, programSeed, true);
  return fails(routes) ? routes : o;
}

async function runPipeline(
  text: string,
  programSeed: number,
  routesShuffled: boolean,
): Promise<Outcome> {
  const started = Date.now();
  const o: Outcome = {
    cls: 'clean',
    stage: '',
    message: '',
    symptom: '',
    importWarningCategories: [],
    importWarningMessages: [],
    printWarningCategories: [],
    layoutFallback: false,
    routesShuffled,
    ms: 0,
  };
  const finish = (partial: Partial<Outcome>): Outcome => {
    Object.assign(o, partial);
    o.ms = Date.now() - started;
    o.symptom = (routesShuffled ? 'routes|' : '') + symptomOf(o);
    delete o.diffEntries;
    return o;
  };
  let stage = 'compile';
  try {
    const ir1 = await compile(text);

    stage = 'serialize';
    let xml1: string;
    try {
      xml1 = await bounded(stage, () => irToXml(ir1));
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      xml1 = e.xml;
      o.layoutFallback = true;
    }

    stage = 'import';
    let imported: Awaited<ReturnType<typeof xmlToIr>>;
    try {
      imported = await bounded(stage, () => xmlToIr(xml1));
    } catch (e) {
      if (isRefusal(e)) {
        return finish({
          cls: 'import-refused',
          stage,
          message: e.message,
          errorName: e.name,
        });
      }
      throw e;
    }
    o.importWarnings = imported.warnings.length;
    o.importWarningCategories = [
      ...new Set(imported.warnings.map((w) => w.category)),
    ].sort();
    o.importWarningMessages = [
      ...new Set(imported.warnings.map((w) => normalizeMessage(w.message))),
    ].slice(0, 3);

    stage = 'print';
    const forPrint =
      SHUFFLE === undefined
        ? imported.ir
        : reorderContainer(
            imported.ir,
            SHUFFLE,
            typeof SHUFFLE === 'number'
              ? permutationRng(programSeed, SHUFFLE)
              : () => 0,
            routesShuffled,
          );
    const printed = irToDsl(forPrint);
    const dsl1 = printed.source;
    const pw = printed.warnings ?? [];
    o.printWarningCategories = [...new Set(pw.map((w) => w.category))].sort();
    o.dsl1 = dsl1;

    stage = 'revalidate';
    const { model, errors, dispose } = await parseModel(dsl1);
    if (errors.length > 0) {
      await dispose();
      return finish({ cls: 'dsl-invalid', stage, message: errors[0] });
    }

    stage = 'recompile';
    let ir3: BpmnProcess;
    try {
      ir3 = astToIr(model);
    } finally {
      await dispose();
    }
    const n1 = normalizeIr(ir1);
    const n3 = normalizeIr(ir3);

    stage = 'serialize2';
    let xml2: string;
    try {
      xml2 = await bounded(stage, () => irToXml(ir3));
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      xml2 = e.xml;
      o.layoutFallback = true;
    }

    stage = 'import2';
    let imported2: Awaited<ReturnType<typeof xmlToIr>>;
    try {
      imported2 = await bounded(stage, () => xmlToIr(xml2));
    } catch (e) {
      if (isRefusal(e)) {
        return finish({
          cls: 'import-refused',
          stage,
          message: e.message,
          errorName: e.name,
        });
      }
      throw e;
    }

    stage = 'print2';
    const dsl2 = irToDsl(imported2.ir).source;
    o.secondPassStable = dsl2 === dsl1;
    if (!o.secondPassStable) o.unstableLines = firstLineDifference(dsl1, dsl2);

    if (routesShuffled) return finish({ cls: 'clean', stage, message: '' });

    stage = 'compare';
    const comparison = compareModels(ir1, ir3);
    if (comparison === 'changed') {
      // Two flows can share a canonical key after normalization (a conditioned
      // and a fallback flow between one fork and join), which `keyed` collapses;
      // the positional diff then names the difference.
      let entries = diffPaths(keyed(n1), keyed(n3));
      if (entries.length === 0) {
        entries = diffPaths(n1, n3).map((d) => ({
          ...d,
          path: `(positional) ${d.path}`,
        }));
      }
      const diff = entries.map(diffText);
      o.diffEntries = entries;
      return finish({
        cls: pw.length > 0 ? 'warned-restructuring' : 'silent-change',
        comparison,
        stage: 'compare',
        message: diff.slice(0, 3).join('; '),
        diff,
      });
    }
    return finish({ cls: 'clean', comparison, stage: 'compare', message: '' });
  } catch (e) {
    if (e instanceof TimeoutError) {
      return finish({ cls: 'timeout', stage, message: e.message });
    }
    const err = e as Error;
    return finish({
      cls: 'crash',
      stage,
      errorName: err?.name ?? typeof e,
      message: `${err?.message ?? String(e)}\n${(err?.stack ?? '').split('\n').slice(1, 4).join('\n')}`,
    });
  }
}

function symptomOf(o: Outcome): string {
  switch (o.cls) {
    case 'crash':
      return `crash|${o.stage}|${o.errorName}|${normalizeMessage(o.message.split('\n')[0])}`;
    case 'timeout':
      return `timeout|${o.stage}`;
    case 'import-refused':
      return `import-refused|${o.stage}|${o.errorName}|${normalizeMessage(o.message)}`;
    case 'dsl-invalid':
      return `dsl-invalid|${normalizeMessage(o.message)}`;
    case 'silent-change':
      return `silent-change|${diffShape(o.diffEntries ?? [])}`;
    case 'warned-restructuring':
      return `warned-restructuring|${o.printWarningCategories.join(',')}`;
    case 'clean':
      // A clean comparison can still carry a print warning (the model did
      // not change, but the print warned about it); that keeps the seed out
      // of the ordinary `clean` bucket so it is minimized and reported.
      if (o.printWarningCategories.length > 0)
        return `clean-warned|${o.printWarningCategories.join(',')}`;
      return o.secondPassStable === false ? 'clean-unstable' : 'clean';
  }
}

// Whether a minimization candidate still shows the failure being reduced.
function sameFailure(original: Outcome, candidate: Outcome): boolean {
  if (
    candidate.cls !== original.cls ||
    candidate.routesShuffled !== original.routesShuffled
  )
    return false;
  switch (original.cls) {
    case 'dsl-invalid':
      return (
        normalizeMessage(candidate.message) ===
        normalizeMessage(original.message)
      );
    case 'crash':
    case 'import-refused':
      return (
        candidate.errorName === original.errorName &&
        candidate.stage === original.stage
      );
    case 'clean':
      return candidate.symptom === original.symptom;
    default:
      return true;
  }
}

interface SeedRow {
  seed: number;
  valid: boolean;
  errors?: string[];
  warnings?: number;
  warningMessages?: string[];
  statements?: number;
  outcome?: Outcome;
}

function countStatements(p: Program): number {
  let n = 0;
  const walk = (body: Program['body']): void => {
    for (const s of body) {
      n++;
      if ('body' in s) walk(s.body);
      if (s.k === 'if') {
        walk(s.then);
        for (const e of s.elseIfs) walk(e.body);
        if (s.else) walk(s.else);
      }
      if (s.k === 'parallel' || s.k === 'race')
        for (const b of s.branches) walk(b.body);
    }
  };
  walk(p.body);
  return n;
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

describe('round-trip fuzz', () => {
  it(
    `round-trip fuzz: generated programs ${SEED}..${SEED + N - 1} round-trip clean and warning-free${SHUFFLE === undefined ? '' : ` (shuffle: ${SHUFFLE})`}`,
    { timeout: 6 * 60 * 60 * 1000 },
    async () => {
      if (OUT !== undefined) {
        // A stale minimized program from an earlier run would misattribute a symptom.
        rmSync(join(OUT, 'min'), { recursive: true, force: true });
        mkdirSync(join(OUT, 'min'), { recursive: true });
        writeFileSync(join(OUT, 'results.jsonl'), '');
      }
      const rows: SeedRow[] = [];
      const programs = new Map<number, Program>();
      const t0 = Date.now();

      for (let i = 0; i < N; i++) {
        const seed = SEED + i;
        const program = generateProgram(seed);
        const text = renderProgram(program);
        const { errors, warnings, dispose } = await parseModel(text);
        await dispose();
        const row: SeedRow = {
          seed,
          valid: errors.length === 0,
          statements: countStatements(program),
          warnings: warnings.length,
          warningMessages: warnings.map((w) => w.slice(0, 120)),
        };
        if (!row.valid) {
          row.errors = errors.slice(0, 3);
        } else {
          row.outcome = await runSeed(text, seed);
          programs.set(seed, program);
        }
        rows.push(row);
        if (OUT !== undefined) {
          appendFileSync(
            join(OUT, 'results.jsonl'),
            JSON.stringify(row) + '\n',
          );
        }
        if ((i + 1) % 100 === 0) {
          console.log(
            `[fuzz] ${i + 1}/${N} in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
          );
        }
      }

      // ---- aggregate ----
      const valid = rows.filter((r) => r.valid);
      const classes = Object.fromEntries(
        CLASS_ORDER.map((c) => [c, 0]),
      ) as Record<Cls, number>;
      const seedsByClass = Object.fromEntries(
        CLASS_ORDER.map((c) => [c, [] as number[]]),
      ) as Record<Cls, number[]>;
      let cleanCanonical = 0;
      let cleanRestructured = 0;
      const failingSeeds: number[] = [];
      const side = {
        importWarningsEmpty: 0,
        importWarningsNonEmpty: 0,
        secondPassStable: 0,
        secondPassUnstable: 0,
        secondPassNotReached: 0,
        layoutFallback: 0,
      };
      const layoutFallbackSeeds: number[] = [];
      const cleanButUnstable: number[] = [];
      const importWarningCategories: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      const importWarningMessages: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      const unstable: {
        seed: number;
        cls: Cls;
        kind: string;
        before: string;
        after: string;
      }[] = [];
      const printWarningCategories: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      const invalidMessages: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      const warningMessages: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      for (const r of rows) {
        for (const w of r.warningMessages ?? []) {
          const m = normalizeMessage(w);
          warningMessages[m] ??= { count: 0, exampleSeed: r.seed };
          warningMessages[m].count++;
        }
        if (!r.valid) {
          const m = normalizeMessage(r.errors![0]);
          invalidMessages[m] ??= { count: 0, exampleSeed: r.seed };
          invalidMessages[m].count++;
          continue;
        }
        const o = r.outcome!;
        classes[o.cls]++;
        seedsByClass[o.cls].push(r.seed);
        if (o.importWarnings !== undefined) {
          if (o.importWarnings === 0) side.importWarningsEmpty++;
          else side.importWarningsNonEmpty++;
        }
        for (const c of o.importWarningCategories) {
          importWarningCategories[c] ??= { count: 0, exampleSeed: r.seed };
          importWarningCategories[c].count++;
        }
        for (const m of o.importWarningMessages) {
          importWarningMessages[m] ??= { count: 0, exampleSeed: r.seed };
          importWarningMessages[m].count++;
        }
        if (o.unstableLines)
          unstable.push({ seed: r.seed, cls: o.cls, ...o.unstableLines });
        for (const c of o.printWarningCategories) {
          printWarningCategories[c] ??= { count: 0, exampleSeed: r.seed };
          printWarningCategories[c].count++;
        }
        if (o.secondPassStable === undefined) side.secondPassNotReached++;
        else if (o.secondPassStable) side.secondPassStable++;
        else side.secondPassUnstable++;
        if (o.layoutFallback) {
          side.layoutFallback++;
          layoutFallbackSeeds.push(r.seed);
        }
        if (o.cls === 'clean') {
          if (o.comparison === 'canonical') cleanCanonical++;
          else if (o.comparison === 'restructured') cleanRestructured++;
        }
        if (o.cls === 'clean' && o.secondPassStable === false)
          cleanButUnstable.push(r.seed);
        if (fails(o)) failingSeeds.push(r.seed);
      }

      // ---- symptoms ----
      interface Symptom {
        key: string;
        cls: Cls;
        stage: string;
        message: string;
        seeds: number[];
        minimized?: {
          seed: number;
          file: string;
          statements: number;
          before: number;
          complete: boolean;
          candidates: number;
          ms: number;
        };
      }
      const symptoms = new Map<string, Symptom>();
      for (const r of valid) {
        const o = r.outcome!;
        // Every failing outcome gets a symptom entry, a warned or unstable
        // clean seed included, so it is minimized and reported like any
        // other failure.
        if (!fails(o)) continue;
        const s = symptoms.get(o.symptom) ?? {
          key: o.symptom,
          cls: o.cls,
          stage: o.stage,
          message: o.message,
          seeds: [],
        };
        s.seeds.push(r.seed);
        symptoms.set(o.symptom, s);
      }
      const warned = new Map<
        string,
        { categories: string[]; seeds: number[]; example: string }
      >();
      const warnedCategoryCounts: Record<
        string,
        { count: number; exampleSeed: number }
      > = {};
      for (const r of valid) {
        const o = r.outcome!;
        if (o.cls !== 'warned-restructuring') continue;
        const key = o.printWarningCategories.join(',');
        const w = warned.get(key) ?? {
          categories: o.printWarningCategories,
          seeds: [],
          example: o.message,
        };
        w.seeds.push(r.seed);
        warned.set(key, w);
        for (const c of o.printWarningCategories) {
          warnedCategoryCounts[c] ??= { count: 0, exampleSeed: r.seed };
          warnedCategoryCounts[c].count++;
        }
      }

      // ---- minimize one seed per symptom ----
      if (OUT !== undefined) {
        const outDir = OUT;
        let k = 0;
        for (const s of symptoms.values()) {
          k++;
          // the smallest failing seed of the group is the cheapest to reduce
          const seed = s.seeds
            .map((sd) => ({
              sd,
              n: rows.find((r) => r.seed === sd)!.statements!,
            }))
            .sort((a, b) => a.n - b.n || a.sd - b.sd)[0].sd;
          const original = programs.get(seed)!;
          const originalOutcome = rows.find((r) => r.seed === seed)!.outcome!;
          const started = Date.now();
          let candidates = 0;
          let complete = true;
          const keep = async (candidate: Program): Promise<boolean> => {
            if (Date.now() - started > MIN_BUDGET_MS) {
              complete = false;
              return false;
            }
            candidates++;
            const text = renderProgram(candidate);
            const { errors, dispose } = await parseModel(text);
            await dispose();
            if (errors.length > 0) return false;
            const outcome = await runSeed(text, seed);
            return sameFailure(originalOutcome, outcome);
          };
          console.log(
            `[fuzz] minimizing ${k}/${symptoms.size}: ${s.cls} seed ${seed} (${s.seeds.length} seeds)`,
          );
          const reduced = await minimize(original, keep);
          const text = renderProgram(reduced);
          const outcome = await runSeed(text, seed);
          const base = `${s.cls}-${seed}`;
          writeFileSync(join(outDir, 'min', `${base}.bpmnscript`), text);
          const symptomText = [
            `class: ${outcome.cls}`,
            `stage: ${outcome.stage}`,
            `symptom: ${s.key}`,
            `seeds: ${s.seeds.join(', ')}`,
            `minimized from seed ${seed}: ${countStatements(original)} -> ${countStatements(reduced)} statements, ${candidates} candidates, ${complete ? 'complete' : 'budget exhausted'}`,
            '',
            'message:',
            outcome.message,
            ...(outcome.diff
              ? ['', 'diff (normalized ir1 -> ir3):', ...outcome.diff]
              : []),
            ...(outcome.dsl1 !== undefined
              ? ['', 'printed dsl1:', outcome.dsl1]
              : []),
            '',
          ].join('\n');
          writeFileSync(join(outDir, 'min', `${base}.txt`), symptomText);
          s.minimized = {
            seed,
            file: `min/${base}.bpmnscript`,
            statements: countStatements(reduced),
            before: countStatements(original),
            complete,
            candidates,
            ms: Date.now() - started,
          };
        }
      }

      const summary = {
        invocation: {
          seed: SEED,
          n: N,
          shuffle: SHUFFLE ?? null,
          minimize: OUT !== undefined,
          timeoutMs: TIMEOUT_MS,
          tree: gitHead(),
          cwd: process.cwd(),
          date: new Date().toISOString(),
          totalMs: Date.now() - t0,
        },
        generator: {
          generated: rows.length,
          valid: valid.length,
          keepRate: valid.length / rows.length,
          validWithWarnings: valid.filter((r) => (r.warnings ?? 0) > 0).length,
          statementsMin: Math.min(...rows.map((r) => r.statements!)),
          statementsMax: Math.max(...rows.map((r) => r.statements!)),
          invalidMessages: Object.entries(invalidMessages)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([message, v]) => ({ message, ...v })),
          warningMessages: Object.entries(warningMessages)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([message, v]) => ({ message, ...v })),
        },
        classes,
        cleanCanonical,
        cleanRestructured,
        failingSeeds,
        seedsByClass,
        side,
        layoutFallbackSeeds,
        cleanButUnstable,
        importWarningCategories,
        importWarningMessages,
        secondPassUnstable: {
          digitsOnly: unstable.filter((u) => u.kind === 'digits-only').length,
          text: unstable.filter((u) => u.kind === 'text').length,
          byClass: Object.fromEntries(
            CLASS_ORDER.map((c) => [
              c,
              unstable.filter((u) => u.cls === c).length,
            ]),
          ),
          examples: unstable.slice(0, 12),
          cleanSeeds: unstable.filter((u) => u.cls === 'clean'),
        },
        printWarningCategories,
        warnedCategoryCounts,
        warnedRestructuring: [...warned.values()].sort(
          (a, b) => b.seeds.length - a.seeds.length,
        ),
        symptoms: [...symptoms.values()].sort(
          (a, b) =>
            CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) ||
            b.seeds.length - a.seeds.length,
        ),
      };
      if (OUT !== undefined) {
        writeFileSync(
          join(OUT, 'summary.json'),
          JSON.stringify(summary, null, 2),
        );
      }
      console.log(
        `[fuzz] done: ${JSON.stringify({ keepRate: summary.generator.keepRate, classes })}`,
      );
      expect(rows.length).toBe(N);
      expect(failingSeeds).toEqual([]);
    },
  );
});
