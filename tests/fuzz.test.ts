// Round-trip fuzz: per seed, generate a program, then parse -> astToIr -> irToXml
// -> xmlToIr -> irToDsl -> revalidate -> astToIr, compare, and print a second time.
// A valid seed fails on a FAIL_CLASSES class, any print warning, or an unstable
// second print; the run fails on any import warning but the uncaught-cancel one.
//
// FUZZ_N (default 200), FUZZ_SEED (default 1), FUZZ_OUT (writes results.jsonl,
// summary.json and minimized programs to min/), FUZZ_SHUFFLE (`reverse` or a
// numeric seed) reorders the imported model before printing. A gateway's own
// outgoing flows keep their order, since Operaton evaluates conditions in
// document order; passing seeds get a second `routes|` run that shuffles those too.

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
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

import { validate } from './helpers/pipeline.js';
import { normalizeIr } from './helpers/normalize-ir.js';
import {
  compareModels,
  stable,
  type ModelComparison,
} from './helpers/model-equivalence.js';
import {
  countStatements,
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

// Shuffles per-source blocks only; a gateway's routes keep their order.
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

// One shared `rand`, so same-size nested containers draw distinct permutations.
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

const CLASS_ORDER = [
  'crash',
  'timeout',
  'import-refused',
  'dsl-invalid',
  'silent-change',
  'warned-restructuring',
  'clean',
] as const;
type Cls = (typeof CLASS_ORDER)[number];

const FAIL_CLASSES = new Set<Cls>(CLASS_ORDER.filter((c) => c !== 'clean'));

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

// Fires only once the stage yields; a synchronous hang cannot be interrupted.
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

// Blanks process names and numbers so one symptom is one key across seeds.
const PROCESS_NAME_PATTERN = new RegExp(PROCESS_NAMES.join('|'), 'g');

/**
 * The generator keeps a cancel end in an attempt block nothing catches, a shape
 * that deploys but fails the run when the end is reached, so the importer
 * warns about it and nothing else.
 */
const UNCAUGHT_CANCEL_WARNING =
  /^The block '[^']+' holds an end event that gives it up, with no cancel boundary event attached to it: /;

function normalizeMessage(m: string): string {
  return m
    .replace(PROCESS_NAME_PATTERN, '<process>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

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
  const errors = result.diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => Diagnostic.getMessageString(d));
  const warnings = result.diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Warning)
    .map((d) => Diagnostic.getMessageString(d));
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
  // A layout failure still carries the complete, diagram-less model.
  const serialize = async (ir: BpmnProcess): Promise<string> => {
    try {
      return await bounded(stage, () => irToXml(ir));
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      o.layoutFallback = true;
      return e.xml;
    }
  };
  const importXml = async (
    xml: string,
  ): Promise<Awaited<ReturnType<typeof xmlToIr>> | undefined> => {
    try {
      return await bounded(stage, () => xmlToIr(xml));
    } catch (e) {
      if (!(e instanceof UnsupportedConstructError)) throw e;
      finish({
        cls: 'import-refused',
        stage,
        message: e.message,
        errorName: e.name,
      });
      return undefined;
    }
  };
  try {
    const ir1 = await compile(text);

    stage = 'serialize';
    const xml1 = await serialize(ir1);

    stage = 'import';
    const imported = await importXml(xml1);
    if (imported === undefined) return o;
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
    const xml2 = await serialize(ir3);

    stage = 'import2';
    const imported2 = await importXml(xml2);
    if (imported2 === undefined) return o;

    stage = 'print2';
    const dsl2 = irToDsl(imported2.ir).source;
    o.secondPassStable = dsl2 === dsl1;
    if (!o.secondPassStable) o.unstableLines = firstLineDifference(dsl1, dsl2);

    if (routesShuffled) return finish({ cls: 'clean', stage, message: '' });

    stage = 'compare';
    const comparison = compareModels(ir1, ir3);
    if (comparison === 'changed') {
      // `keyed` collapses flows sharing a canonical key (conditioned + fallback
      // between one fork and join); fall back to a positional diff.
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
      if (o.printWarningCategories.length > 0)
        return `clean-warned|${o.printWarningCategories.join(',')}`;
      return o.secondPassStable === false ? 'clean-unstable' : 'clean';
  }
}

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

type Tally = Record<string, { count: number; exampleSeed: number }>;

function tally(t: Tally, key: string, seed: number): void {
  t[key] ??= { count: 0, exampleSeed: seed };
  t[key].count++;
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
      const importWarningCategories: Tally = {};
      const importWarningMessages: Tally = {};
      const unstable: {
        seed: number;
        cls: Cls;
        kind: string;
        before: string;
        after: string;
      }[] = [];
      const printWarningCategories: Tally = {};
      const invalidMessages: Tally = {};
      const warningMessages: Tally = {};
      for (const r of rows) {
        for (const w of r.warningMessages ?? [])
          tally(warningMessages, normalizeMessage(w), r.seed);
        if (!r.valid) {
          tally(invalidMessages, normalizeMessage(r.errors![0]), r.seed);
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
          tally(importWarningCategories, c, r.seed);
        }
        for (const m of o.importWarningMessages) {
          tally(importWarningMessages, m, r.seed);
        }
        if (o.unstableLines)
          unstable.push({ seed: r.seed, cls: o.cls, ...o.unstableLines });
        for (const c of o.printWarningCategories) {
          tally(printWarningCategories, c, r.seed);
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
      const warnedCategoryCounts: Tally = {};
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
          tally(warnedCategoryCounts, c, r.seed);
        }
      }

      if (OUT !== undefined) {
        const outDir = OUT;
        let k = 0;
        for (const s of symptoms.values()) {
          k++;
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
      expect(
        Object.keys(importWarningMessages).filter(
          (m) => !UNCAUGHT_CANCEL_WARNING.test(m),
        ),
      ).toEqual([]);
    },
  );
});
