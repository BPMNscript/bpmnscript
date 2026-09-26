// Fuzz program generator, printer and delta-debugging reducer. Programs are
// best-effort valid; the harness keeps only validator-clean ones.

import {
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  ENGINE_KEYS,
  EXECUTION_LISTENER_EVENTS,
  FORM_FIELD_TYPES,
  JUEL_RESERVED_WORDS,
  LISTENER_BINDING_KEYS,
  RACE_TRIGGERS,
  SCRIPT_FORMAT_ALIASES,
  SERVICE_TASK_BINDING_KEYS,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TIMER_PARTICLE_BY_KIND,
  TYPE_BINDING_VALUES,
} from '@bpmn-script/language';

const JUEL_WORDS: readonly string[] = JUEL_RESERVED_WORDS;

class Rng {
  private state: number;
  constructor(seed: number) {
    // eslint-disable-next-line no-bitwise
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    /* eslint-disable no-bitwise */
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    /* eslint-enable no-bitwise */
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

type ExprType = 'boolean' | 'number' | 'string' | 'unknown';

type Expr =
  | { t: 'leaf'; text: string; type: ExprType }
  | { t: 'bin'; op: string; l: Expr; r: Expr; type: ExprType }
  | { t: 'un'; op: string; e: Expr; type: ExprType }
  | { t: 'paren'; e: Expr; type: ExprType }
  | { t: 'tern'; c: Expr; a: Expr; b: Expr; type: ExprType };

interface Item {
  key?: string;
  value: string;
  flag?: true;
}

interface FormFieldSpec {
  id: string;
  type: string;
  label?: string;
  defaultValue?: string;
  items: Item[];
  values: { id: string; label?: string }[];
  props: { name: string; value: string }[];
}

type Member =
  | { m: 'io'; dir: string; name: string; value: string }
  | {
      m: 'listener';
      event: string;
      timer?: { particle: string; time: string };
      items: Item[];
      script?: string;
      fields: { name: string; value: string }[];
    }
  | { m: 'form'; fields: FormFieldSpec[] }
  | {
      m: 'mapping';
      dir: 'in' | 'out';
      local?: true;
      all?: true;
      target?: string;
      source?: string;
    }
  | { m: 'errorMapping'; code: string; condition: Expr };

interface Repeat {
  cardinality?: string;
  element?: string;
  collection?: string;
  sequential?: true;
  until?: Expr;
}

type Stmt =
  | {
      k: 'start';
      name: string;
      trigger?: string;
      items: Item[];
      members: Member[];
    }
  | {
      k: 'end';
      name: string;
      trigger?: string;
      items: Item[];
      members: Member[];
    }
  | {
      k: 'task';
      kw:
        'user' | 'service' | 'step' | 'send' | 'receive' | 'decide' | 'script';
      name: string;
      repeat?: Repeat;
      items: Item[];
      members: Member[];
      script?: string;
    }
  | {
      k: 'call';
      name: string;
      repeat?: Repeat;
      items: Item[];
      members: Member[];
    }
  | {
      k: 'sub';
      kw: 'subprocess' | 'attempt';
      name: string;
      repeat?: Repeat;
      items: Item[];
      members: Member[];
      body: Stmt[];
    }
  | {
      k: 'if';
      cond: Expr;
      items: Item[];
      then: Stmt[];
      elseIfs: { cond: Expr; body: Stmt[] }[];
      else?: Stmt[];
    }
  | { k: 'while'; cond: Expr; items: Item[]; body: Stmt[] }
  | { k: 'do'; cond: Expr; items: Item[]; body: Stmt[] }
  | {
      k: 'parallel';
      items: Item[];
      branches: { cond?: Expr; otherwise?: true; body: Stmt[] }[];
    }
  | {
      k: 'await';
      trigger: string;
      name?: string;
      items: Item[];
      members: Member[];
    }
  | {
      k: 'race';
      items: Item[];
      branches: {
        trigger: string;
        items: Item[];
        members: Member[];
        body: Stmt[];
      }[];
    }
  | {
      k: 'throw' | 'emit';
      trigger: string;
      name?: string;
      items: Item[];
      members: Member[];
    }
  | { k: 'goto'; target: string }
  | {
      k: 'on';
      host?: string;
      trigger: string;
      items: Item[];
      members: Member[];
      body: Stmt[];
    };

interface CodeDecl {
  kind: 'error' | 'escalation';
  name: string;
  items: Item[];
}

export interface Program {
  name: string;
  header: Item[];
  vars: { name: string; type: string }[];
  codes: CodeDecl[];
  body: Stmt[];
}

// A ternary arm or binary operand is one grammar precedence level down.
function renderExpr(e: Expr): string {
  const operand = (x: Expr): string =>
    x.t === 'tern' ? `(${renderExpr(x)})` : renderExpr(x);
  switch (e.t) {
    case 'leaf':
      return e.text;
    case 'bin':
      return `${operand(e.l)} ${e.op} ${operand(e.r)}`;
    case 'un':
      return `${e.op}${e.e.t === 'bin' || e.e.t === 'tern' ? `(${renderExpr(e.e)})` : renderExpr(e.e)}`;
    case 'paren':
      return `(${renderExpr(e.e)})`;
    case 'tern':
      return `${operand(e.c)} ? ${operand(e.a)} : ${operand(e.b)}`;
  }
}

function renderItems(items: Item[]): string {
  if (items.length === 0) return '';
  return (
    '(' +
    items
      .map((it) =>
        it.flag ? it.value : it.key ? `${it.key}: ${it.value}` : it.value,
      )
      .join(', ') +
    ')'
  );
}

function indent(lines: string[], depth: number): string[] {
  const pad = '  '.repeat(depth);
  return lines.map((l) => (l === '' ? l : pad + l));
}

function renderFence(script: string): string[] {
  // The script already contains its tag line and closing fence.
  return script.split('\n');
}

function renderMembers(members: Member[]): string[] {
  const out: string[] = [];
  for (const m of members) {
    switch (m.m) {
      case 'io': {
        const valueLines = m.value.split('\n');
        out.push(
          `${m.dir} ${m.name} = ${valueLines[0]}`,
          ...valueLines.slice(1),
        );
        break;
      }
      case 'listener': {
        let head = `on ${m.event}`;
        if (m.timer) head += ` ${m.timer.particle} ${m.timer.time}`;
        head += renderItems(m.items);
        if (m.script) {
          const fence = renderFence(m.script);
          out.push(`${head} ${fence[0]}`, ...fence.slice(1));
        } else if (m.fields.length > 0) {
          out.push(`${head} {`);
          out.push(
            ...indent(
              m.fields.map((f) => `field ${f.name} = ${f.value}`),
              1,
            ),
          );
          out.push('}');
        } else {
          out.push(head);
        }
        break;
      }
      case 'form': {
        out.push('form {');
        for (const f of m.fields) {
          let line = `${f.id}: ${f.type}`;
          if (f.label !== undefined) line += ` ${f.label}`;
          if (f.defaultValue !== undefined) line += ` = ${f.defaultValue}`;
          line += renderItems(f.items);
          if (f.values.length > 0 || f.props.length > 0) {
            out.push(`  ${line} {`);
            for (const v of f.values) {
              out.push(
                `    ${v.id}${v.label !== undefined ? ' ' + v.label : ''}`,
              );
            }
            for (const p of f.props) {
              out.push(`    property ${p.name} = ${p.value}`);
            }
            out.push('  }');
          } else {
            out.push(`  ${line}`);
          }
        }
        out.push('}');
        break;
      }
      case 'mapping': {
        let line = m.dir;
        if (m.local) line += ' local';
        if (m.all) line += ' *';
        else {
          line += ` ${m.target}`;
          if (m.source !== undefined) line += ` = ${m.source}`;
        }
        out.push(line);
        break;
      }
      case 'errorMapping':
        out.push(`error ${m.code} when ${renderExpr(m.condition)}`);
        break;
    }
  }
  return out;
}

function renderRepeat(r: Repeat | undefined): string {
  if (!r) return '';
  let s = ' for';
  if (r.cardinality !== undefined) s += ` ${r.cardinality}`;
  if (r.collection !== undefined) {
    s += ` each${r.element ? ' ' + r.element : ''} in ${r.collection}`;
  }
  if (r.sequential) s += ' sequentially';
  if (r.until) s += ` until (${renderExpr(r.until)})`;
  return s;
}

function renderBlock(body: Stmt[]): string[] {
  return ['{', ...indent(renderStmts(body), 1), '}'];
}

function withBlock(head: string, lines: string[]): string[] {
  return [`${head} ${lines[0]}`, ...lines.slice(1)];
}

function renderMemberBlock(members: Member[]): string[] | undefined {
  if (members.length === 0) return undefined;
  return ['{', ...indent(renderMembers(members), 1), '}'];
}

function renderStmt(s: Stmt): string[] {
  switch (s.k) {
    case 'start':
    case 'end': {
      let head = `${s.k} ${s.name}`;
      if (s.trigger) head += ` ${s.trigger}`;
      head += renderItems(s.items);
      const mb = renderMemberBlock(s.members);
      return mb ? withBlock(head, mb) : [head];
    }
    case 'task': {
      const head = `${s.kw} ${s.name}${renderRepeat(s.repeat)}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      const lines = mb ? withBlock(head, mb) : [head];
      if (s.script !== undefined) {
        const fence = renderFence(s.script);
        const last = lines.length - 1;
        lines[last] = `${lines[last]} ${fence[0]}`;
        lines.push(...fence.slice(1));
      }
      return lines;
    }
    case 'call': {
      const head = `call ${s.name}${renderRepeat(s.repeat)}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      return mb ? withBlock(head, mb) : [head];
    }
    case 'sub': {
      const head = `${s.kw} ${s.name}${renderRepeat(s.repeat)}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      const headLines = mb ? withBlock(head, mb) : [head];
      const last = headLines.length - 1;
      const block = renderBlock(s.body);
      headLines[last] = `${headLines[last]} ${block[0]}`;
      return [...headLines, ...block.slice(1)];
    }
    case 'if': {
      const lines = withBlock(
        `if (${renderExpr(s.cond)})${s.items.length ? ' ' + renderItems(s.items) : ''}`,
        renderBlock(s.then),
      );
      for (const ei of s.elseIfs) {
        const b = renderBlock(ei.body);
        lines[lines.length - 1] = `} else if (${renderExpr(ei.cond)}) ${b[0]}`;
        lines.push(...b.slice(1));
      }
      if (s.else) {
        const b = renderBlock(s.else);
        lines[lines.length - 1] = `} else ${b[0]}`;
        lines.push(...b.slice(1));
      }
      return lines;
    }
    case 'while':
      return withBlock(
        `while (${renderExpr(s.cond)})${s.items.length ? ' ' + renderItems(s.items) : ''}`,
        renderBlock(s.body),
      );
    case 'do': {
      const lines = withBlock('do', renderBlock(s.body));
      lines[lines.length - 1] =
        `} while (${renderExpr(s.cond)})${s.items.length ? ' ' + renderItems(s.items) : ''}`;
      return lines;
    }
    case 'parallel': {
      const out = [
        `parallel${s.items.length ? ' ' + renderItems(s.items) : ''} {`,
      ];
      for (const b of s.branches) {
        const head = b.otherwise
          ? 'else '
          : b.cond
            ? `if (${renderExpr(b.cond)}) `
            : '';
        const block = renderBlock(b.body);
        out.push(...indent([`${head}${block[0]}`, ...block.slice(1)], 1));
      }
      out.push('}');
      return out;
    }
    case 'await': {
      const head = `await ${s.trigger}${s.name ? ' ' + s.name : ''}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      return mb ? withBlock(head, mb) : [head];
    }
    case 'race': {
      const out = [
        `await${s.items.length ? ' ' + renderItems(s.items) : ''} {`,
      ];
      for (const b of s.branches) {
        const head = `${b.trigger}${renderItems(b.items)}`;
        const mb = renderMemberBlock(b.members);
        const headLines = mb ? withBlock(head, mb) : [head];
        const block = renderBlock(b.body);
        headLines[headLines.length - 1] += ` ${block[0]}`;
        out.push(...indent([...headLines, ...block.slice(1)], 1));
      }
      out.push('}');
      return out;
    }
    case 'throw':
    case 'emit': {
      const head = `${s.k} ${s.trigger}${s.name ? ' ' + s.name : ''}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      return mb ? withBlock(head, mb) : [head];
    }
    case 'goto':
      return [`goto ${s.target}`];
    case 'on': {
      const head = `on ${s.host ? s.host + ': ' : ''}${s.trigger}${renderItems(s.items)}`;
      const mb = renderMemberBlock(s.members);
      const headLines = mb ? withBlock(head, mb) : [head];
      const block = renderBlock(s.body);
      headLines[headLines.length - 1] += ` ${block[0]}`;
      return [...headLines, ...block.slice(1)];
    }
  }
}

function renderStmts(stmts: Stmt[]): string[] {
  const out: string[] = [];
  for (const s of stmts) out.push(...renderStmt(s));
  return out;
}

export function renderProgram(p: Program): string {
  const out: string[] = [];
  const header = p.header.length ? renderItems(p.header) : '';
  out.push(`process ${p.name}${header} {`);
  for (const v of p.vars) out.push(`  var ${v.name}: ${v.type}`);
  for (const c of p.codes)
    out.push(`  ${c.kind} ${c.name}${renderItems(c.items)}`);
  if (p.vars.length + p.codes.length > 0) out.push('');
  out.push(...indent(renderStmts(p.body), 1));
  out.push('}', '');
  return out.join('\n');
}

export const PROCESS_NAMES = [
  'order-fulfilment',
  'claim-review',
  'onboarding',
  'invoice_batch',
] as const;

type VarType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'any';

interface Variable {
  name: string;
  type: VarType;
}

const VAR_POOL: readonly Variable[] = [
  { name: 'amount', type: 'number' },
  { name: 'retries', type: 'number' },
  { name: 'score', type: 'number' },
  { name: 'status', type: 'string' },
  { name: 'region', type: 'string' },
  { name: 'approved', type: 'boolean' },
  { name: 'urgent', type: 'boolean' },
  { name: 'due', type: 'date' },
  { name: 'order', type: 'json' },
  { name: 'items', type: 'any' },
  { name: 'lines', type: 'any' },
];

const STEP_WORDS = [
  'Review',
  'Pack',
  'Ship',
  'Notify',
  'Check',
  'Approve',
  'Archive',
  'Charge',
  'Fetch',
  'Audit',
  'Rate',
  'Hold',
  'Release',
  'Escalate',
  'Record',
];
const HYPHEN_WORDS = ['check-stock', 'send-mail', 'close-case', 'pay-out'];

const MESSAGE_NAMES = [
  'OrderReceived',
  'PaymentDone',
  'Cancelled',
  'Quote Received',
];
const SIGNAL_NAMES = ['StockLow', 'Ready', 'Shutdown'];
const LINK_NAMES = ['Rework', 'Retry', 'Skip'];
const CLASS_NAMES = [
  'com.example.Delegate',
  'com.example.orders.Ship',
  'org.acme.Audit',
];
const DURATIONS = ['PT1H', 'P3D', 'PT30M', 'PT2H30M'];
const DATES = ['2026-08-01T09:00:00', '2027-01-01T00:00:00'];
const CYCLES = ['R3/PT10M', 'R/PT1H', '0 0 9 * * ?'];
const RETRY = ['R3/PT10M', 'R5/PT5M'];

interface Scope {
  container: 'process' | 'subprocess' | 'attempt' | 'handler';
  targets: string[]; // goto targets
  hosts: { name: string; kind: string }[]; // handler hosts
  linkCatchesWanted: string[]; // emitted links without a catch yet
  usedHandlers: Set<string>; // trigger|code per subscription scope
  depth: number;
  inBranch: boolean; // goto/link into a parallel or race branch is refused
  hostedBody: boolean; // no start; shares the host container's statements
}

export class Generator {
  private readonly rng: Rng;
  private names = new Set<string>();
  private labels = new Set<string>();
  private counter = 0;
  private vars = new Map<string, Variable>();
  private codes: CodeDecl[] = [];
  private linkCatches = new Set<string>();
  private messageStarts = new Set<string>();
  private plainStartUsed = false;
  private statementBudget = 0;
  private stmtCount = 0;
  private formFieldIds = new Map<string, string>();

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  generate(): Program {
    const r = this.rng;
    this.statementBudget = r.int(5, 20);
    const name = r.pick(PROCESS_NAMES);
    this.names.add(name);
    const header = this.header();
    this.codes = [];
    if (r.chance(0.6)) {
      this.codes.push({
        kind: 'error',
        name: 'OUT_OF_STOCK',
        items: r.chance(0.5)
          ? [{ key: 'message', value: '"Out of stock"' }]
          : [],
      });
    }
    if (r.chance(0.4))
      this.codes.push({ kind: 'escalation', name: 'NEEDS_REVIEW', items: [] });
    if (r.chance(0.25)) {
      this.codes.push({
        kind: 'error',
        name: 'DECLINED',
        items: [{ key: 'code', value: '"card-declined"' }],
      });
    }
    this.names.add('OUT_OF_STOCK');
    this.names.add('NEEDS_REVIEW');
    this.names.add('DECLINED');

    const scope: Scope = {
      container: 'process',
      targets: [],
      hosts: [],
      linkCatchesWanted: [],
      usedHandlers: new Set(),
      depth: 0,
      inBranch: false,
      hostedBody: false,
    };
    const body: Stmt[] = [];
    if (r.chance(0.8)) {
      body.push(this.startEvent(true));
      if (r.chance(0.25)) body.push(this.startEvent(false));
    }
    body.push(...this.chain(scope, true));
    this.flushLinks(scope, body);
    body.push(...this.handlers(scope, body));

    const vars = [...this.vars.values()].map((v) => ({
      name: v.name,
      type: v.type,
    }));
    return { name, header, vars, codes: this.codes, body };
  }

  // ----- names -----

  private fresh(hint?: string): string {
    const r = this.rng;
    for (;;) {
      const word =
        hint ?? (r.chance(0.08) ? r.pick(HYPHEN_WORDS) : r.pick(STEP_WORDS));
      const n = ++this.counter;
      const name =
        r.chance(0.3) && !this.names.has(word) ? word : `${word}${n}`;
      if (!this.names.has(name)) {
        this.names.add(name);
        return name;
      }
    }
  }

  private label(): Item[] {
    const r = this.rng;
    if (!r.chance(0.3)) return [];
    const text = `"${r.pick(['Review the order', 'Pack it', 'Ship the parcel', 'Say \\"hi\\"', 'Line\\nbreak', 'Tab\\there'])} ${++this.counter}"`;
    if (this.labels.has(text)) return [];
    this.labels.add(text);
    return [{ key: 'label', value: text }];
  }

  private documentation(): Item[] {
    return this.rng.chance(0.15)
      ? [
          {
            key: 'documentation',
            value: `"Escalate above ${this.rng.int(1, 9)}000."`,
          },
        ]
      : [];
  }

  // ----- variables and expressions -----

  private variable(type?: VarType): Variable {
    const r = this.rng;
    const pool = type ? VAR_POOL.filter((v) => v.type === type) : VAR_POOL;
    const v = r.pick(pool);
    this.vars.set(v.name, v);
    return v;
  }

  private leaf(text: string, type: ExprType): Expr {
    return { t: 'leaf', text, type };
  }

  private rawTemplate(type: ExprType): Expr {
    const r = this.rng;
    const v = this.variable('number');
    const s = this.variable('string');
    const j = this.variable('json');
    const choices: [string, ExprType][] = [
      [`"\${${v.name} > ${r.int(1, 9)}}"`, 'boolean'],
      [`"\${${s.name} == \\"a\\"}"`, 'boolean'],
      [`"\${${s.name} == \\"a\\\\\\\\b\\"}"`, 'boolean'],
      [`"#{${v.name} + 1}"`, 'number'],
      [`"\${${j.name}['${r.pick(JUEL_WORDS)}']}"`, 'unknown'],
      [`"\${fn(\\"a\\")}"`, 'unknown'],
      [`'\${${v.name} * 2}'`, 'number'],
    ];
    const fitting = choices.filter(([, t]) => t === type || t === 'unknown');
    const [text, t] = r.pick(fitting.length ? fitting : choices);
    return this.leaf(text, t === 'unknown' ? type : t);
  }

  numExpr(depth = 0): Expr {
    const r = this.rng;
    if (depth > 1 || r.chance(0.4)) {
      const c = r.int(0, 5);
      if (c === 0) return this.leaf(String(r.int(0, 1000)), 'number');
      if (c === 1) return this.leaf(`${r.int(0, 9)}.${r.int(0, 99)}`, 'number');
      if (c === 2)
        return this.leaf(`${this.variable('json').name}.total`, 'number');
      if (c === 3 && depth > 0) return this.rawTemplate('number');
      return this.leaf(this.variable('number').name, 'number');
    }
    const c = r.int(0, 3);
    if (c === 0)
      return { t: 'un', op: '-', e: this.numExpr(depth + 1), type: 'number' };
    if (c === 1)
      return { t: 'paren', e: this.numExpr(depth + 1), type: 'number' };
    return {
      t: 'bin',
      op: r.pick(['+', '-', '*', '/', '%']),
      l: this.numExpr(depth + 1),
      r: this.numExpr(depth + 1),
      type: 'number',
    };
  }

  strExpr(): Expr {
    const r = this.rng;
    const c = r.int(0, 3);
    if (c === 0)
      return this.leaf(
        `"${r.pick(['open', 'eu', 'x\\"y', 'a\\\\b'])}"`,
        'string',
      );
    if (c === 1)
      return this.leaf(`${this.variable('json').name}.name`, 'string');
    if (c === 2) return this.leaf(`${this.variable('any').name}[0]`, 'string');
    return this.leaf(this.variable('string').name, 'string');
  }

  boolExpr(depth = 0): Expr {
    const r = this.rng;
    if (depth > 1 || r.chance(0.3)) {
      const c = r.int(0, 4);
      if (c === 0) return this.leaf(r.pick(['true', 'false']), 'boolean');
      if (c === 1) return this.rawTemplate('boolean');
      if (c === 2)
        return this.leaf(`${this.variable('json').name}.paid`, 'boolean');
      if (c === 3)
        return this.leaf(
          `${this.variable('json').name}['${r.pick(JUEL_WORDS)}']`,
          'boolean',
        );
      return this.leaf(this.variable('boolean').name, 'boolean');
    }
    const c = r.int(0, 7);
    if (c === 0)
      return { t: 'un', op: '!', e: this.boolExpr(depth + 1), type: 'boolean' };
    if (c === 1)
      return { t: 'paren', e: this.boolExpr(depth + 1), type: 'boolean' };
    if (c === 2)
      return {
        t: 'bin',
        op: r.pick(['&&', '||']),
        l: this.boolExpr(depth + 1),
        r: this.boolExpr(depth + 1),
        type: 'boolean',
      };
    if (c === 3)
      return {
        t: 'bin',
        op: r.pick(['==', '!=']),
        l: this.strExpr(),
        r: this.strExpr(),
        type: 'boolean',
      };
    if (c === 4)
      return {
        t: 'bin',
        op: '==',
        l: this.leaf(this.variable('json').name, 'unknown'),
        r: this.leaf('null', 'unknown'),
        type: 'boolean',
      };
    if (c === 5) {
      return {
        t: 'tern',
        c: this.boolExpr(depth + 1),
        a: this.boolExpr(depth + 1),
        b: this.boolExpr(depth + 1),
        type: 'boolean',
      };
    }
    return {
      t: 'bin',
      op: r.pick(['<', '<=', '>', '>=', '==', '!=']),
      l: this.numExpr(depth + 1),
      r: this.numExpr(depth + 1),
      type: 'boolean',
    };
  }

  private valueForm(allowInt = true, allowBare = true): string {
    const r = this.rng;
    const c = r.int(0, allowInt ? 3 : 2);
    if (c === 0)
      return `"${r.pick(['sepa', 'east-coast', 'say \\"hi\\"', 'a\\\\b', 'two\\nlines'])}"`;
    if (c === 1)
      return allowBare ? this.variable().name : `"${r.pick(['x', 'y'])}"`;
    if (c === 2) return renderExpr(this.rawTemplate('unknown'));
    return String(r.int(0, 99));
  }

  private ioValue(depth = 0): string {
    const r = this.rng;
    const c = r.int(0, depth > 0 ? 3 : 5);
    if (c === 0) return this.valueForm();
    if (c === 1) return renderExpr(this.boolExpr(1));
    if (c === 2) return renderExpr(this.numExpr(1));
    if (c === 3) return this.strLiteral();
    if (c === 4) {
      const n = r.int(0, 3);
      const items: string[] = [];
      for (let i = 0; i < n; i++) items.push(this.ioValue(depth + 1));
      return `[${items.join(', ')}]`;
    }
    const n = r.int(0, 3);
    const entries: string[] = [];
    for (let i = 0; i < n; i++) {
      const key = r.chance(0.3)
        ? `"${r.pick(['other key', 'x-y', 'a\\"b'])}"`
        : r.pick(['street', 'city', 'zip', 'mod']);
      entries.push(`${key}: ${this.ioValue(depth + 1)}`);
    }
    return `{ ${entries.join(', ')} }`;
  }

  private strLiteral(): string {
    return `"${this.rng.pick(['open', 'eu', 'x\\"y', 'a\\\\b', 'line\\nbreak', 'tab\\t'])}"`;
  }

  private fence(): string {
    const r = this.rng;
    const tag = r.pick(Object.keys(SCRIPT_FORMAT_ALIASES));
    const body = r.pick([
      'execution.setVariable("x", 1)',
      'if (a) { b } else { c }',
      'def s = "quote \\" inside"\nlog.info(s)',
      '${amount > 1}',
    ]);
    return `\`\`\`${tag}\n${body}\n\`\`\``;
  }

  // ----- settings -----

  private engineSettings(
    opts: {
      join?: boolean;
      run?: boolean;
      noAsyncAfter?: boolean;
      timer?: boolean;
    } = {},
  ): Item[] {
    const r = this.rng;
    const items: Item[] = [];
    const prefixes: string[] = [''];
    if (opts.join) prefixes.push('join');
    if (opts.run) prefixes.push('run');
    for (const prefix of prefixes) {
      if (!r.chance(prefix === '' ? 0.35 : 0.2)) continue;
      const spell = (key: string): string =>
        prefix === '' ? key : prefix + key[0].toUpperCase() + key.slice(1);
      const asyncKeys = ENGINE_KEYS.filter(
        (k) =>
          k.startsWith('async') &&
          !(opts.noAsyncAfter && k === 'asyncAfter' && prefix === ''),
      );
      const others = ENGINE_KEYS.filter(
        (k) =>
          !k.startsWith('async') && !(prefix === 'run' && k === 'jobPriority'),
      );
      const withAsync = r.chance(0.8) || opts.timer;
      if (withAsync && !opts.timer)
        items.push({ key: spell(r.pick(asyncKeys)), value: 'true' });
      if (r.chance(0.5)) {
        const key = r.pick(others);
        const value =
          key === 'exclusive'
            ? r.pick(['true', 'false'])
            : key === 'jobPriority'
              ? String(r.int(0, 100))
              : `"${r.pick(RETRY)}"`;
        items.push({ key: spell(key), value });
      }
    }
    return items;
  }

  private header(): Item[] {
    const r = this.rng;
    const items: Item[] = [];
    if (r.chance(0.3))
      items.push({ key: 'label', value: '"Motor claim settlement"' });
    if (r.chance(0.2))
      items.push({ key: 'documentation', value: '"Handles a \\"claim\\"."' });
    if (r.chance(0.3))
      items.push({ key: 'versionTag', value: `"${r.int(1, 9)}.0"` });
    if (r.chance(0.3))
      items.push({
        key: 'historyTimeToLive',
        value: r.pick(['"P90D"', '"30"', '"180"']),
      });
    if (r.chance(0.2))
      items.push({ key: 'candidateStarterUsers', value: '"demo,manager"' });
    if (r.chance(0.2))
      items.push({ key: 'candidateStarterGroups', value: '"adjusters"' });
    return items;
  }

  // ----- members -----

  private ioParams(dirs: readonly string[], allowOutput: boolean): Member[] {
    const r = this.rng;
    const out: Member[] = [];
    const used = new Map<string, Set<string>>();
    const n = r.int(0, 3);
    for (let i = 0; i < n; i++) {
      let dir = r.pick(dirs);
      if (dir === 'output' && !allowOutput) dir = 'input';
      const name = r.pick([
        'address',
        'labels',
        'tracking',
        'team',
        'note',
        'hint',
      ]);
      const set = used.get(dir) ?? new Set();
      if (set.has(name)) continue;
      set.add(name);
      used.set(dir, set);
      const value =
        dir === 'field' || dir === 'property'
          ? r.chance(0.7)
            ? this.strLiteral()
            : renderExpr(this.rawTemplate('unknown'))
          : r.chance(0.15)
            ? this.fence()
            : this.ioValue();
      out.push({ m: 'io', dir, name, value });
    }
    return out;
  }

  private listeners(taskListeners: boolean): Member[] {
    const r = this.rng;
    const out: Member[] = [];
    if (!r.chance(0.35)) return out;
    const events = taskListeners
      ? [...EXECUTION_LISTENER_EVENTS, ...TASK_LISTENER_EVENTS]
      : [...EXECUTION_LISTENER_EVENTS];
    const used = new Set<string>();
    const n = r.int(1, 2);
    for (let i = 0; i < n; i++) {
      const event = r.pick(events);
      if (used.has(event)) continue;
      used.add(event);
      const m: Member = { m: 'listener', event, items: [], fields: [] };
      if (event === 'timeout') {
        const [particle, time] = this.timerClause();
        m.timer = { particle, time };
      }
      if (r.chance(0.3)) {
        m.script = this.fence();
      } else {
        const key = r.pick(LISTENER_BINDING_KEYS);
        m.items.push({ key, value: this.bindingValue(key) });
        if (key !== 'expression' && r.chance(0.4)) {
          m.fields.push({
            name: 'auditTag',
            value: r.chance(0.5)
              ? '"claim-intake"'
              : `"\${${this.variable('string').name}}"`,
          });
        }
      }
      out.push(m);
    }
    return out;
  }

  private timerClause(): [string, string] {
    const r = this.rng;
    const kind = r.pick(['duration', 'date', 'cycle'] as const);
    const particle = TIMER_PARTICLE_BY_KIND[kind];
    const time =
      kind === 'duration'
        ? r.pick(DURATIONS)
        : kind === 'date'
          ? r.pick(DATES)
          : r.pick(CYCLES);
    return [
      particle,
      r.chance(0.15) ? `"\${${this.variable('string').name}}"` : `"${time}"`,
    ];
  }

  private bindingValue(key: string): string {
    const r = this.rng;
    switch (key) {
      case 'class':
        return `"${r.pick(CLASS_NAMES)}"`;
      case 'expression':
        return r.chance(0.5)
          ? `"\${${r.pick(['svc', 'bean'])}.run(execution)}"`
          : r.chance(0.5)
            ? this.variable('json').name
            : `"#{${this.variable('json').name}.go()}"`;
      case 'delegate':
        return r.chance(0.6)
          ? `"\${${r.pick(['shipDelegate', 'auditBean'])}}"`
          : this.variable('json').name;
      case 'topic':
        return `"${r.pick(['shipping', 'charge-card', 'audit'])}"`;
      case 'type':
        return `"${r.pick(TYPE_BINDING_VALUES)}"`;
      default:
        return '"x"';
    }
  }

  private form(): Member {
    const r = this.rng;
    const fields: FormFieldSpec[] = [];
    const n = r.int(1, 4);
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      let type: string = r.pick(FORM_FIELD_TYPES);
      const id = r.pick([
        'fullName',
        'birthDate',
        'plan',
        'newsletter',
        'qty',
        'iban',
        'amount',
        'approved',
      ]);
      if (used.has(id)) continue;
      // a form field with a `var`'s name must agree with its type
      const pooled = VAR_POOL.find((v) => v.name === id);
      if (pooled) {
        if (!(FORM_FIELD_TYPES as readonly string[]).includes(pooled.type))
          continue;
        type = pooled.type;
      }
      const earlier = this.formFieldIds.get(id);
      if (earlier !== undefined && earlier !== type) continue;
      this.formFieldIds.set(id, type);
      used.add(id);
      const f: FormFieldSpec = { id, type, items: [], values: [], props: [] };
      if (r.chance(0.6))
        f.label = `"${r.pick(['Full name', 'Amount in \\"euros\\"', 'Plan'])}"`;
      if (type === 'enum') {
        f.values.push({
          id: 'basic',
          label: r.chance(0.5) ? '"Basic"' : undefined,
        });
        f.values.push({ id: 'plus' });
        if (r.chance(0.4)) f.defaultValue = '"basic"';
      } else if (r.chance(0.4)) {
        f.defaultValue =
          type === 'string'
            ? '"n/a"'
            : type === 'number'
              ? String(r.int(0, 9))
              : type === 'boolean'
                ? r.pick(['true', 'false'])
                : `"\${${this.variable('date').name}}"`;
      }
      if (r.chance(0.5))
        f.items.push({ key: r.pick(['required', 'readonly']), value: 'true' });
      if (type === 'number' && r.chance(0.5))
        f.items.push({
          key: r.pick(['min', 'max']),
          value: r.pick(['0', '"-5"', '5000']),
        });
      if (type === 'string' && r.chance(0.5))
        f.items.push({
          key: r.pick(['minlength', 'maxlength']),
          value: String(r.int(1, 80)),
        });
      if (type === 'date' && r.chance(0.6))
        f.items.push({ key: 'pattern', value: '"dd/MM/yyyy"' });
      if (r.chance(0.2))
        f.items.push({
          key: 'validator',
          value: r.chance(0.5)
            ? '"com.example.IbanValidator"'
            : '"${validator.ok(fullName)}"',
        });
      if (r.chance(0.25))
        f.props.push({
          name: 'placeholder',
          value: r.chance(0.7) ? '"Filled in by accounting"' : '"${hint}"',
        });
      fields.push(f);
    }
    if (fields.length === 0)
      fields.push({
        id: 'note',
        type: 'string',
        items: [],
        values: [],
        props: [],
      });
    return { m: 'form', fields };
  }

  private repeat(): Repeat | undefined {
    const r = this.rng;
    if (!r.chance(0.2)) return undefined;
    const rep: Repeat = {};
    const c = r.int(0, 3);
    if (c === 0 || c === 3)
      rep.cardinality = r.pick([
        '3',
        '"2"',
        this.variable('number').name,
        '"${order.size}"',
      ]);
    if (c !== 0) {
      rep.collection = r.chance(0.7)
        ? this.variable('any').name
        : `"\${${this.variable('json').name}.lines}"`;
      if (r.chance(0.7)) rep.element = r.pick(['line', 'item']);
    }
    if (r.chance(0.3)) rep.sequential = true;
    if (r.chance(0.3)) {
      rep.until = {
        t: 'bin',
        op: '>=',
        l: this.leaf(
          r.pick([
            'nrOfCompletedInstances',
            'nrOfInstances',
            'nrOfActiveInstances',
          ]),
          'number',
        ),
        r: this.leaf(String(r.int(1, 5)), 'number'),
        type: 'boolean',
      };
    }
    return rep;
  }

  // ----- statements -----

  private startEvent(first: boolean): Stmt {
    const r = this.rng;
    const s: Stmt = {
      k: 'start',
      name: this.fresh('Start'),
      items: [...this.label()],
      members: [],
    };
    const wantTrigger = first ? r.chance(0.35) : true;
    if (wantTrigger) {
      const trigger = r.pick(START_TRIGGERS);
      if (trigger === 'message' || trigger === 'signal') {
        const pool = (
          trigger === 'message' ? MESSAGE_NAMES : SIGNAL_NAMES
        ).filter((n) => !this.messageStarts.has(`${trigger}:${n}`));
        const name = pool[0];
        this.messageStarts.add(`${trigger}:${name}`);
        s.trigger = trigger;
        s.items.unshift({ value: `"${name}"` });
      } else if (trigger === 'timer' && !this.plainStartUsed) {
        this.plainStartUsed = true;
        s.trigger = 'timer';
        s.items.unshift(...this.timerPayload());
      } else {
        s.trigger = 'condition';
        s.items.unshift({ value: renderExpr(this.boolExpr()) });
      }
    } else {
      this.plainStartUsed = true;
    }
    if (r.chance(0.2))
      s.items.push({
        key: 'initiator',
        value: r.chance(0.5) ? '"starter"' : 'starter',
      });
    if (r.chance(0.3))
      s.items.push(...this.engineSettings({ timer: s.trigger === 'timer' }));
    if (r.chance(0.3)) s.members.push(this.form());
    s.members.push(...this.listeners(false));
    return s;
  }

  private timerPayload(): Item[] {
    const r = this.rng;
    const kind = r.pick(['duration', 'date', 'cycle'] as const);
    const time =
      kind === 'duration'
        ? r.pick(DURATIONS)
        : kind === 'date'
          ? r.pick(DATES)
          : r.pick(CYCLES);
    if (kind === 'duration') return [{ value: `"${time}"` }];
    return [{ key: TIMER_PARTICLE_BY_KIND[kind], value: `"${time}"` }];
  }

  private triggerPayload(trigger: string): Item[] {
    const r = this.rng;
    switch (trigger) {
      case 'message':
        return [{ value: `"${r.pick(MESSAGE_NAMES)}"` }];
      case 'signal':
        return [{ value: `"${r.pick(SIGNAL_NAMES)}"` }];
      case 'timer':
        return this.timerPayload();
      case 'condition':
        return [{ value: renderExpr(this.boolExpr()) }];
      case 'link':
        return [{ value: `"${r.pick(LINK_NAMES)}"` }];
      case 'error': {
        const code = this.codes.find((c) => c.kind === 'error');
        return code ? [{ value: code.name }] : [];
      }
      case 'escalation': {
        const code = this.codes.find((c) => c.kind === 'escalation');
        return code ? [{ value: code.name }] : [];
      }
      default:
        return [];
    }
  }

  private task(scope: Scope): Stmt {
    const r = this.rng;
    const kw = r.pick([
      'user',
      'service',
      'step',
      'send',
      'receive',
      'decide',
      'script',
    ] as const);
    const name = this.fresh();
    const items: Item[] = [...this.label(), ...this.documentation()];
    const members: Member[] = [];
    const repeat = this.repeat();
    let binding: string | undefined;
    const dirs: string[] = ['input', 'output'];
    switch (kw) {
      case 'user': {
        if (r.chance(0.7))
          items.push({
            key: 'assignee',
            value: r.pick(['"demo"', 'demo', '"${who}"']),
          });
        if (r.chance(0.2))
          items.push({ key: 'candidateGroups', value: '"adjusters"' });
        if (r.chance(0.2))
          items.push({ key: 'candidateUsers', value: '"demo,manager"' });
        if (r.chance(0.2))
          items.push({
            key: 'dueDate',
            value: r.pick(['"P2D"', '"2026-01-01T09:00:00"', '"${due}"']),
          });
        if (r.chance(0.15))
          items.push({ key: 'followUpDate', value: '"PT4H"' });
        if (r.chance(0.2))
          items.push({ key: 'priority', value: r.pick(['75', '"${amount}"']) });
        if (r.chance(0.2)) {
          items.push({
            key: 'formKey',
            value: '"embedded:app:forms/triage.html"',
          });
        } else {
          // Not dead: each `chance` draws independently.
          if (r.chance(0.2)) {
            items.push({ key: 'formRef', value: '"payout-approval"' });
            items.push(
              r.chance(0.5)
                ? { key: 'binding', value: r.pick(['latest', 'deployment']) }
                : { key: 'version', value: r.pick(['2', '"3"']) },
            );
          }
        }
        if (r.chance(0.25)) members.push(this.form());
        break;
      }
      case 'service':
      case 'send': {
        binding = r.pick(SERVICE_TASK_BINDING_KEYS);
        items.push({ key: binding, value: this.bindingValue(binding) });
        if (binding === 'expression' && r.chance(0.5))
          items.push({ key: 'resultVariable', value: '"result"' });
        break;
      }
      case 'decide': {
        if (r.chance(0.6)) {
          binding = 'decision';
          items.push({ key: 'decision', value: '"approve-claim"' });
          if (r.chance(0.5))
            items.push(
              r.chance(0.5)
                ? { key: 'binding', value: r.pick(['latest', 'deployment']) }
                : { key: 'version', value: '2' },
            );
          if (r.chance(0.5)) {
            items.push({ key: 'resultVariable', value: '"verdict"' });
            if (r.chance(0.6))
              items.push({
                key: 'mapDecisionResult',
                value: r.pick(DECISION_RESULT_MAPPINGS),
              });
          }
        } else {
          binding = r.pick(SERVICE_TASK_BINDING_KEYS);
          items.push({ key: binding, value: this.bindingValue(binding) });
        }
        break;
      }
      case 'receive':
        if (r.chance(0.7))
          items.push({ key: 'message', value: `"${r.pick(MESSAGE_NAMES)}"` });
        break;
      case 'script':
        if (r.chance(0.3))
          items.push({ key: 'resultVariable', value: '"grade"' });
        break;
      default:
        break;
    }
    if (binding === 'class' || binding === 'delegate') dirs.push('field');
    if (binding === 'type') {
      const type = items.find((i) => i.key === 'type')!.value;
      if (type === '"mail"') {
        members.push({
          m: 'io',
          dir: 'field',
          name: 'to',
          value: '"ops@example.com"',
        });
        members.push({
          m: 'io',
          dir: 'field',
          name: r.pick(['text', 'html']),
          value: r.chance(0.7) ? '"Disk usage high"' : '"${body}"',
        });
        if (r.chance(0.3))
          members.push({
            m: 'io',
            dir: 'field',
            name: 'subject',
            value: '"Alert"',
          });
      } else {
        members.push({ m: 'io', dir: 'field', name: 'command', value: '"df"' });
        if (r.chance(0.5))
          members.push({ m: 'io', dir: 'field', name: 'arg1', value: '"-h"' });
        if (r.chance(0.4))
          members.push({
            m: 'io',
            dir: 'field',
            name: r.pick(['wait', 'redirectError', 'cleanEnv']),
            value: r.pick(['"true"', '"false"']),
          });
        if (r.chance(0.3))
          members.push({
            m: 'io',
            dir: 'field',
            name: 'outputVariable',
            value: '"diskReport"',
          });
      }
    }
    if (binding === 'topic') {
      if (r.chance(0.4))
        items.push({
          key: 'taskPriority',
          value: r.pick([
            '42',
            '"-5"',
            this.variable('number').name,
            '"${amount}"',
          ]),
        });
      dirs.push('property');
      const code = this.codes.find((c) => c.kind === 'error');
      if (code && r.chance(0.4)) {
        members.push({
          m: 'errorMapping',
          code: code.name,
          condition: r.chance(0.5)
            ? {
                t: 'bin',
                op: '==',
                l: this.leaf('externalTask.errorMessage', 'string'),
                r: this.leaf('"declined"', 'string'),
                type: 'boolean',
              }
            : this.boolExpr(),
        });
      }
    }
    members.push(...this.ioParams(dirs, repeat === undefined));
    members.push(...this.listeners(kw === 'user'));
    if (r.chance(0.4))
      items.push(...this.engineSettings({ run: repeat !== undefined }));
    const s: Stmt = { k: 'task', kw, name, repeat, items, members };
    if (kw === 'script') s.script = this.fence();
    if (!scope.inBranch) {
      scope.targets.push(name);
      scope.hosts.push({ name, kind: kw });
    }
    return s;
  }

  private call(scope: Scope): Stmt {
    const r = this.rng;
    const name = this.fresh('Call');
    const items: Item[] = [
      ...this.label(),
      {
        key: 'process',
        value: `"${r.pick(['invoice-approval', 'payment-run'])}"`,
      },
    ];
    if (r.chance(0.4))
      items.push(
        r.chance(0.5)
          ? { key: 'binding', value: r.pick(['latest', 'deployment']) }
          : { key: 'version', value: r.pick(['1', '"2"']) },
      );
    if (r.chance(0.3))
      items.push({
        key: 'businessKey',
        value: r.pick(['"abc"', '"${order.id}"', this.variable('string').name]),
      });
    if (r.chance(0.3))
      items.push(
        r.chance(0.5)
          ? { key: 'mapper', value: '"com.example.Mapper"' }
          : { key: 'mapperDelegate', value: '"${mapperBean}"' },
      );
    const repeat = this.repeat();
    if (r.chance(0.4))
      items.push(...this.engineSettings({ run: repeat !== undefined }));
    const members: Member[] = [];
    const n = r.int(0, 3);
    const usedIn = new Set<string>();
    const usedOut = new Set<string>();
    for (let i = 0; i < n; i++) {
      const dir = r.pick(['in', 'out'] as const);
      const used = dir === 'in' ? usedIn : usedOut;
      if (r.chance(0.15)) {
        if (used.has('*')) continue;
        used.add('*');
        members.push({
          m: 'mapping',
          dir,
          all: true,
          local: r.chance(0.3) ? true : undefined,
        });
        continue;
      }
      const target = r.pick(['amount', 'approved', 'claimTotal', 'y']);
      if (used.has(target)) continue;
      used.add(target);
      const m: Member = { m: 'mapping', dir, target };
      if (r.chance(0.3)) m.local = true;
      if (r.chance(0.6))
        m.source =
          dir === 'in'
            ? r.pick([
                this.variable().name,
                '"u"',
                renderExpr(this.numExpr(1)),
                '"${order.total}"',
              ])
            : r.pick(['result', '"${result}"']);
      members.push(m);
    }
    members.push(...this.ioParams(['input', 'output'], repeat === undefined));
    members.push(...this.listeners(false));
    if (!scope.inBranch) {
      scope.targets.push(name);
      scope.hosts.push({ name, kind: 'call' });
    }
    return { k: 'call', name, repeat, items, members };
  }

  private sub(scope: Scope): Stmt {
    const r = this.rng;
    const kw = r.chance(0.35) ? 'attempt' : 'subprocess';
    const name = this.fresh(kw === 'attempt' ? 'Try' : 'Sub');
    const items: Item[] = [...this.label()];
    const repeat = this.repeat();
    if (r.chance(0.3))
      items.push(...this.engineSettings({ run: repeat !== undefined }));
    const members: Member[] = [
      ...this.ioParams(['input', 'output'], repeat === undefined),
      ...this.listeners(false),
    ];
    const inner: Scope = {
      container: kw,
      targets: [],
      hosts: [],
      linkCatchesWanted: [],
      usedHandlers: new Set(),
      depth: scope.depth + 1,
      inBranch: false,
      hostedBody: false,
    };
    const body: Stmt[] = [];
    let explicitEnd = false;
    if (r.chance(0.4))
      body.push({
        k: 'start',
        name: this.fresh('Start'),
        items: [],
        members: [],
      });
    body.push(...this.chain(inner, false));
    if (r.chance(0.4) && !this.terminates(body[body.length - 1])) {
      body.push({ k: 'end', name: this.fresh('Done'), items: [], members: [] });
      explicitEnd = true;
    }
    void explicitEnd;
    this.flushLinks(inner, body);
    if (r.chance(0.3) && this.stmtCount < this.statementBudget) {
      const undo: Scope = {
        ...inner,
        container: 'handler',
        targets: [],
        hosts: [],
        inBranch: true,
      };
      body.push({
        k: 'on',
        trigger: 'compensation',
        items: [],
        members: [],
        body: [this.simpleTask(undo)],
      });
    }
    body.push(...this.handlers(inner, body));
    if (!scope.inBranch) {
      scope.targets.push(name);
      scope.hosts.push({ name, kind: kw });
    }
    return { k: 'sub', kw, name, repeat, items, members, body };
  }

  private simpleTask(scope: Scope): Stmt {
    const name = this.fresh();
    if (!scope.inBranch) {
      scope.targets.push(name);
      scope.hosts.push({ name, kind: 'service' });
    }
    return {
      k: 'task',
      kw: 'service',
      name,
      items: [{ key: 'class', value: `"${this.rng.pick(CLASS_NAMES)}"` }],
      members: [],
    };
  }

  private ifStmt(scope: Scope): Stmt {
    const r = this.rng;
    const inner = { ...scope, depth: scope.depth + 1 };
    const s: Stmt = {
      k: 'if',
      cond: this.boolExpr(),
      items: r.chance(0.25) ? this.engineSettings({ join: true }) : [],
      then: this.chain(inner, false),
      elseIfs: [],
    };
    const n = r.int(0, 2);
    for (let i = 0; i < n; i++)
      s.elseIfs.push({ cond: this.boolExpr(), body: this.chain(inner, false) });
    if (r.chance(0.5)) s.else = this.chain(inner, false);
    return s;
  }

  private loop(scope: Scope): Stmt {
    const r = this.rng;
    const inner = { ...scope, depth: scope.depth + 1 };
    const items = r.chance(0.25) ? this.engineSettings() : [];
    const body = this.chainNonTerminating(inner);
    return r.chance(0.6)
      ? { k: 'while', cond: this.boolExpr(), items, body }
      : { k: 'do', cond: this.boolExpr(), items, body };
  }

  private parallel(scope: Scope): Stmt {
    const r = this.rng;
    const inner = { ...scope, depth: scope.depth + 1, inBranch: true };
    const items = r.chance(0.25) ? this.engineSettings({ join: true }) : [];
    const mode = r.int(0, 3); // 0 plain, 1 all conditioned, 2 conditioned + else, 3 mixed
    const n = r.int(2, 3);
    const branches: { cond?: Expr; otherwise?: true; body: Stmt[] }[] = [];
    for (let i = 0; i < n; i++) {
      const body = this.chain(inner, false);
      if (mode === 0) branches.push({ body });
      else if (mode === 1) branches.push({ cond: this.boolExpr(), body });
      else if (mode === 2)
        branches.push(
          i === n - 1
            ? { otherwise: true, body }
            : { cond: this.boolExpr(), body },
        );
      else branches.push(i === 0 ? { cond: this.boolExpr(), body } : { body });
    }
    return { k: 'parallel', items, branches };
  }

  private race(scope: Scope): Stmt {
    const r = this.rng;
    const inner = { ...scope, depth: scope.depth + 1, inBranch: true };
    const items = r.chance(0.25)
      ? this.engineSettings({ join: true, noAsyncAfter: true })
      : [];
    const n = r.int(2, 3);
    const branches: {
      trigger: string;
      items: Item[];
      members: Member[];
      body: Stmt[];
    }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      const trigger = r.pick(RACE_TRIGGERS);
      const payload = this.triggerPayload(trigger);
      const key = `${trigger}:${payload[0]?.value}`;
      if (used.has(key)) continue;
      used.add(key);
      const bItems = [...payload];
      if (r.chance(0.2))
        bItems.push(...this.engineSettings({ timer: trigger === 'timer' }));
      branches.push({
        trigger,
        items: bItems,
        members: this.listeners(false),
        body: this.chain(inner, false),
      });
    }
    while (branches.length < 2) {
      branches.push({
        trigger: 'timer',
        items: this.timerPayload(),
        members: [],
        body: this.chain(inner, false),
      });
    }
    return { k: 'race', items, branches };
  }

  private awaitStmt(scope: Scope): Stmt {
    const r = this.rng;
    const trigger = r.pick(RACE_TRIGGERS);
    const items = this.triggerPayload(trigger);
    if (r.chance(0.25))
      items.push(...this.engineSettings({ timer: trigger === 'timer' }));
    const s: Stmt = {
      k: 'await',
      trigger,
      items,
      members: this.listeners(false),
    };
    if (r.chance(0.4)) {
      s.name = this.fresh('Wait');
      if (!scope.inBranch) scope.targets.push(s.name);
    }
    return s;
  }

  private raise(scope: Scope, kind: 'throw' | 'emit'): Stmt | undefined {
    const r = this.rng;
    const pool =
      kind === 'throw'
        ? THROW_TRIGGERS
        : EMIT_TRIGGERS.filter((t) => t !== 'link');
    let trigger = r.pick(pool);
    if (trigger === 'compensation' && scope.container === 'process')
      trigger = 'message';
    const items = this.triggerPayload(trigger);
    if ((trigger === 'error' || trigger === 'escalation') && items.length === 0)
      return undefined;
    if (trigger === 'message' && r.chance(0.5)) {
      const key = r.pick(['class', 'expression', 'delegate', 'topic']);
      items.push({ key, value: this.bindingValue(key) });
    }
    if (r.chance(0.2)) items.push(...this.engineSettings());
    const s: Stmt = { k: kind, trigger, items, members: this.listeners(false) };
    if (r.chance(0.5)) {
      s.name = this.fresh(kind === 'throw' ? 'Fail' : 'Tell');
      if (!scope.inBranch) scope.targets.push(s.name);
    }
    return s;
  }

  private endStmt(scope: Scope): Stmt {
    const r = this.rng;
    const s: Stmt = {
      k: 'end',
      name: this.fresh('Done'),
      items: [...this.label()],
      members: [],
    };
    if (r.chance(0.3)) s.trigger = 'terminate';
    else if (scope.container === 'attempt' && r.chance(0.6))
      s.trigger = 'cancel';
    if (r.chance(0.2)) s.items.push(...this.engineSettings());
    s.members.push(...this.listeners(false));
    return s;
  }

  private terminates(s: Stmt | undefined): boolean {
    if (!s) return false;
    switch (s.k) {
      case 'end':
      case 'goto':
      case 'throw':
        return true;
      case 'emit':
        return s.trigger === 'link';
      case 'do':
        return this.blockTerminates(s.body);
      case 'if':
        return (
          s.else !== undefined &&
          this.blockTerminates(s.then) &&
          s.elseIfs.every((e) => this.blockTerminates(e.body)) &&
          this.blockTerminates(s.else)
        );
      case 'parallel':
        if (s.branches.every((b) => b.cond !== undefined)) return false;
        return s.branches.every((b) => this.blockTerminates(b.body));
      case 'race':
        return s.branches.every((b) => this.blockTerminates(b.body));
      default:
        return false;
    }
  }

  private blockTerminates(body: Stmt[]): boolean {
    return body.some((s) => this.terminates(s));
  }

  private chain(scope: Scope, processLevel: boolean): Stmt[] {
    const r = this.rng;
    const out: Stmt[] = [];
    const n = scope.depth === 0 ? r.int(2, 6) : r.int(1, 3);
    for (let i = 0; i < n && this.stmtCount < this.statementBudget; i++) {
      const s = this.statement(scope);
      if (!s) continue;
      out.push(s);
      this.stmtCount++;
      if (this.terminates(s)) break;
    }
    if (out.length === 0) {
      out.push(this.simpleTask(scope));
      this.stmtCount++;
    }
    if (
      !this.terminates(out[out.length - 1]) &&
      r.chance(scope.depth === 0 ? 0.5 : 0.2)
    ) {
      const term = this.terminal(scope);
      if (term) {
        out.push(term);
        this.stmtCount++;
      }
    }
    // Reopen flow after a terminal: a `start` at process level or an `await link`.
    if (
      this.terminates(out[out.length - 1]) &&
      !scope.inBranch &&
      !scope.hostedBody
    ) {
      if (scope.linkCatchesWanted.length > 0 && r.chance(0.8)) {
        const link = scope.linkCatchesWanted.shift()!;
        this.linkCatches.add(link);
        const s: Stmt = {
          k: 'await',
          trigger: 'link',
          items: [{ value: `"${link}"` }],
          members: [],
        };
        if (r.chance(0.5)) s.name = this.fresh('At');
        out.push(s, ...this.chain(scope, processLevel));
      } else if (processLevel && r.chance(0.2)) {
        out.push(this.startEvent(false), ...this.chain(scope, processLevel));
      }
    }
    return out;
  }

  private chainNonTerminating(scope: Scope): Stmt[] {
    const out: Stmt[] = [];
    const n = this.rng.int(1, 3);
    for (let i = 0; i < n && this.stmtCount < this.statementBudget; i++) {
      const s = this.statement(scope, true);
      if (!s || this.terminates(s)) continue;
      out.push(s);
      this.stmtCount++;
    }
    if (out.length === 0) out.push(this.simpleTask(scope));
    return out;
  }

  private terminal(scope: Scope): Stmt | undefined {
    const r = this.rng;
    const c = r.int(0, 4);
    if (c === 0 || c === 1) return this.endStmt(scope);
    if (c === 2) return this.raise(scope, 'throw');
    if (c === 3 && scope.targets.length > 0 && scope.depth > 0) {
      return { k: 'goto', target: r.pick(scope.targets) };
    }
    if (c === 4 && !scope.inBranch && !scope.hostedBody) {
      const link = r.pick(
        LINK_NAMES.filter(
          (l) =>
            !this.linkCatches.has(l) && !scope.linkCatchesWanted.includes(l),
        ),
      );
      if (link === undefined) return undefined;
      scope.linkCatchesWanted.push(link);
      const s: Stmt = {
        k: 'emit',
        trigger: 'link',
        items: [{ value: `"${link}"` }],
        members: [],
      };
      if (r.chance(0.5)) s.name = this.fresh('To');
      return s;
    }
    return undefined;
  }

  private statement(scope: Scope, nonTerminating = false): Stmt | undefined {
    const r = this.rng;
    const deep = scope.depth >= 2;
    const c = r.int(0, deep ? 5 : 11);
    switch (c) {
      case 0:
      case 1:
      case 2:
        return this.task(scope);
      case 3:
        return this.call(scope);
      case 4:
        return this.awaitStmt(scope);
      case 5:
        return this.raise(scope, 'emit');
      case 6:
        return this.ifStmt(scope);
      case 7:
        return this.loop(scope);
      case 8:
        return this.parallel(scope);
      case 9:
        return this.race(scope);
      case 10:
        return this.sub(scope);
      default:
        return nonTerminating ? this.task(scope) : this.task(scope);
    }
  }

  private handlers(scope: Scope, body: Stmt[]): Stmt[] {
    const r = this.rng;
    const out: Stmt[] = [];
    if (scope.hostedBody || this.stmtCount >= this.statementBudget) return out;
    const n = r.int(0, 2);
    const hostsInBody = scope.hosts.filter((h) =>
      body.some((s) => this.contains(s, h.name)),
    );
    for (let i = 0; i < n; i++) {
      const hosted = hostsInBody.length > 0 && r.chance(0.5);
      let trigger: string;
      let host: { name: string; kind: string } | undefined;
      if (hosted) {
        host = r.pick(hostsInBody);
        const legal = ['error', 'message', 'signal', 'timer', 'condition'];
        if (['subprocess', 'attempt', 'call', 'user'].includes(host.kind))
          legal.push('escalation');
        if (host.kind === 'attempt') legal.push('cancel');
        trigger = r.pick(legal);
      } else {
        trigger = r.pick([
          'error',
          'escalation',
          'message',
          'signal',
          'timer',
          'condition',
        ]);
      }
      const items = this.triggerPayload(trigger);
      if (
        (trigger === 'error' || trigger === 'escalation') &&
        items.length === 0 &&
        r.chance(0.5)
      ) {
        // catch-all form
      } else if (
        (trigger === 'error' || trigger === 'escalation') &&
        items.length === 0
      ) {
        continue;
      }
      const scopeKey = host ? `host:${host.name}` : `self`;
      const dupKey = `${scopeKey}|${trigger}|${items[0]?.value ?? ''}`;
      if (scope.usedHandlers.has(dupKey)) continue;
      // a catch-all beside a coded catch of the same kind is refused
      const catchAllKey = `${scopeKey}|${trigger}|`;
      if (
        items.length === 0 &&
        [...scope.usedHandlers].some((k) =>
          k.startsWith(`${scopeKey}|${trigger}|`),
        )
      )
        continue;
      if (items.length > 0 && scope.usedHandlers.has(catchAllKey)) continue;
      scope.usedHandlers.add(dupKey);
      if (trigger === 'error' && items.length > 0 && r.chance(0.3)) {
        items.push({ key: 'code', value: 'c' });
        if (r.chance(0.5)) items.push({ key: 'message', value: 'm' });
      }
      if (trigger === 'escalation' && items.length > 0 && r.chance(0.3))
        items.push({ key: 'code', value: 'c' });
      if (r.chance(0.25))
        items.push(...this.engineSettings({ timer: trigger === 'timer' }));
      if (
        ['escalation', 'message', 'signal', 'timer', 'condition'].includes(
          trigger,
        ) &&
        r.chance(0.4)
      ) {
        items.push({ value: 'alongside', flag: true });
      }
      const inner: Scope = host
        ? {
            ...scope,
            depth: scope.depth + 1,
            hostedBody: true,
            inBranch: false,
          }
        : {
            container: 'handler',
            targets: [],
            hosts: [],
            linkCatchesWanted: [],
            usedHandlers: new Set(),
            depth: scope.depth + 1,
            inBranch: false,
            hostedBody: false,
          };
      const hBody: Stmt[] = [];
      if (!host && r.chance(0.4))
        hBody.push({
          k: 'start',
          name: this.fresh('Start'),
          items: [],
          members: [],
        });
      hBody.push(...this.chain(inner, false));
      if (!host) this.flushLinks(inner, hBody);
      if (
        host &&
        r.chance(0.3) &&
        !this.terminates(hBody[hBody.length - 1]) &&
        scope.targets.length > 0
      ) {
        hBody.push({ k: 'goto', target: r.pick(scope.targets) });
      }
      if (!host) hBody.push(...this.handlers(inner, hBody));
      out.push({
        k: 'on',
        host: host?.name,
        trigger,
        items,
        members: this.listeners(false),
        body: hBody,
      });
      this.stmtCount += 1 + hBody.length;
      if (this.stmtCount >= this.statementBudget) break;
    }
    return out;
  }

  // Every `emit link` needs an `await link` catch in the same container.
  private flushLinks(scope: Scope, body: Stmt[]): void {
    if (scope.linkCatchesWanted.length === 0) return;
    if (!this.terminates(body[body.length - 1])) {
      body.push({ k: 'end', name: this.fresh('Done'), items: [], members: [] });
    }
    while (scope.linkCatchesWanted.length > 0) {
      const link = scope.linkCatchesWanted.shift()!;
      this.linkCatches.add(link);
      body.push({
        k: 'await',
        trigger: 'link',
        items: [{ value: `"${link}"` }],
        members: [],
      });
      body.push(this.simpleTask(scope));
      body.push({ k: 'end', name: this.fresh('Done'), items: [], members: [] });
    }
  }

  private contains(s: Stmt, name: string): boolean {
    if ('name' in s && s.name === name) return true;
    for (const b of childBlocks(s))
      if (b.some((x) => this.contains(x, name))) return true;
    return false;
  }
}

function childBlocks(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'sub':
    case 'while':
    case 'do':
    case 'on':
      return [s.body];
    case 'if':
      return [
        s.then,
        ...s.elseIfs.map((e) => e.body),
        ...(s.else ? [s.else] : []),
      ];
    case 'parallel':
    case 'race':
      return s.branches.map((b) => b.body);
    default:
      return [];
  }
}

export function generateProgram(seed: number): Program {
  return new Generator(seed).generate();
}

export type Keep = (candidate: Program) => Promise<boolean>;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function statementLists(p: Program): Stmt[][] {
  const lists: Stmt[][] = [p.body];
  const walk = (body: Stmt[]): void => {
    for (const s of body) {
      for (const b of childBlocks(s)) {
        lists.push(b);
        walk(b);
      }
    }
  };
  walk(p.body);
  return lists;
}

export function countStatements(p: Program): number {
  return statementLists(p).reduce((n, list) => n + list.length, 0);
}

async function dropStatements(p: Program, keep: Keep): Promise<Program> {
  let changed = true;
  while (changed) {
    changed = false;
    const lists = statementLists(p);
    for (let li = 0; li < lists.length; li++) {
      const list = lists[li];
      for (let i = list.length - 1; i >= 0; i--) {
        const candidate = clone(p);
        const cList = statementLists(candidate)[li];
        cList.splice(i, 1);
        if (await keep(candidate)) {
          p = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  // Unwrap compound statements into their bodies.
  changed = true;
  while (changed) {
    changed = false;
    const lists = statementLists(p);
    for (let li = 0; li < lists.length; li++) {
      const list = lists[li];
      for (let i = 0; i < list.length; i++) {
        const blocks = childBlocks(list[i]);
        for (let bi = 0; bi < blocks.length; bi++) {
          const candidate = clone(p);
          const cList = statementLists(candidate)[li];
          const inner = childBlocks(cList[i])[bi];
          cList.splice(i, 1, ...inner);
          if (await keep(candidate)) {
            p = candidate;
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (changed) break;
    }
  }
  return p;
}

function droppableArrays(p: Program): unknown[][] {
  const arrays: unknown[][] = [p.header, p.vars, p.codes];
  const walk = (body: Stmt[]): void => {
    for (const s of body) {
      if ('items' in s) arrays.push(s.items);
      if ('members' in s) {
        arrays.push(s.members);
        for (const m of s.members) {
          if (m.m === 'listener') arrays.push(m.items, m.fields);
          if (m.m === 'form') {
            arrays.push(m.fields);
            for (const f of m.fields) arrays.push(f.items, f.values, f.props);
          }
        }
      }
      if (s.k === 'race')
        for (const b of s.branches) arrays.push(b.items, b.members);
      if (s.k === 'if') arrays.push(s.elseIfs);
      if (s.k === 'parallel' || s.k === 'race') arrays.push(s.branches);
      for (const b of childBlocks(s)) walk(b);
    }
  };
  walk(p.body);
  return arrays;
}

async function dropEntries(p: Program, keep: Keep): Promise<Program> {
  let changed = true;
  while (changed) {
    changed = false;
    const arrays = droppableArrays(p);
    for (let ai = 0; ai < arrays.length; ai++) {
      const arr = arrays[ai];
      for (let i = arr.length - 1; i >= 0; i--) {
        const candidate = clone(p);
        droppableArrays(candidate)[ai].splice(i, 1);
        if (await keep(candidate)) {
          p = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  const optionalFields: [string, string][] = [
    ['task', 'repeat'],
    ['call', 'repeat'],
    ['sub', 'repeat'],
    ['if', 'else'],
    ['await', 'name'],
    ['throw', 'name'],
    ['emit', 'name'],
    ['start', 'trigger'],
    ['end', 'trigger'],
    ['on', 'host'],
    ['listener', 'script'],
  ];
  changed = true;
  while (changed) {
    changed = false;
    const nodes = allNodes(p);
    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni] as Record<string, unknown>;
      for (const [kind, field] of optionalFields) {
        const nodeKind = (node.k ?? node.m) as string;
        if (nodeKind !== kind || node[field] === undefined) continue;
        const candidate = clone(p);
        delete (allNodes(candidate)[ni] as Record<string, unknown>)[field];
        if (await keep(candidate)) {
          p = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return p;
}

function allNodes(p: Program): unknown[] {
  const nodes: unknown[] = [];
  const walk = (body: Stmt[]): void => {
    for (const s of body) {
      nodes.push(s);
      if ('members' in s) for (const m of s.members) nodes.push(m);
      if (s.k === 'race')
        for (const b of s.branches) for (const m of b.members) nodes.push(m);
      for (const b of childBlocks(s)) walk(b);
    }
  };
  walk(p.body);
  return nodes;
}

function exprSlots(p: Program): { get: () => Expr; set: (e: Expr) => void }[] {
  const slots: { get: () => Expr; set: (e: Expr) => void }[] = [];
  const walk = (body: Stmt[]): void => {
    for (const s of body) {
      if (s.k === 'if') {
        slots.push({ get: () => s.cond, set: (e) => (s.cond = e) });
        for (const ei of s.elseIfs)
          slots.push({ get: () => ei.cond, set: (e) => (ei.cond = e) });
      }
      if (s.k === 'while' || s.k === 'do')
        slots.push({ get: () => s.cond, set: (e) => (s.cond = e) });
      if (s.k === 'parallel')
        for (const b of s.branches)
          if (b.cond)
            slots.push({ get: () => b.cond!, set: (e) => (b.cond = e) });
      if ('repeat' in s && s.repeat?.until) {
        const rep = s.repeat;
        slots.push({ get: () => rep.until!, set: (e) => (rep.until = e) });
      }
      if ('members' in s)
        for (const m of s.members)
          if (m.m === 'errorMapping')
            slots.push({
              get: () => m.condition,
              set: (e) => (m.condition = e),
            });
      for (const b of childBlocks(s)) walk(b);
    }
  };
  walk(p.body);
  return slots;
}

function simplerForms(e: Expr): Expr[] {
  const out: Expr[] = [];
  const sameType = (x: Expr): boolean => x.type === e.type;
  switch (e.t) {
    case 'bin':
      if (sameType(e.l)) out.push(e.l);
      if (sameType(e.r)) out.push(e.r);
      break;
    case 'un':
    case 'paren':
      if (sameType(e.e)) out.push(e.e);
      break;
    case 'tern':
      if (sameType(e.a)) out.push(e.a);
      if (sameType(e.b)) out.push(e.b);
      break;
    case 'leaf':
      break;
  }
  if (e.type === 'boolean' && !(e.t === 'leaf' && e.text === 'true'))
    out.push({ t: 'leaf', text: 'true', type: 'boolean' });
  if (e.type === 'number' && !(e.t === 'leaf' && e.text === '1'))
    out.push({ t: 'leaf', text: '1', type: 'number' });
  if (e.type === 'string' && !(e.t === 'leaf' && e.text === '"a"'))
    out.push({ t: 'leaf', text: '"a"', type: 'string' });
  return out;
}

function exprChildren(e: Expr): { get: () => Expr; set: (x: Expr) => void }[] {
  switch (e.t) {
    case 'bin':
      return [
        { get: () => e.l, set: (x) => (e.l = x) },
        { get: () => e.r, set: (x) => (e.r = x) },
      ];
    case 'un':
    case 'paren':
      return [{ get: () => e.e, set: (x) => (e.e = x) }];
    case 'tern':
      return [
        { get: () => e.c, set: (x) => (e.c = x) },
        { get: () => e.a, set: (x) => (e.a = x) },
        { get: () => e.b, set: (x) => (e.b = x) },
      ];
    case 'leaf':
      return [];
  }
}

async function simplifyExpressions(p: Program, keep: Keep): Promise<Program> {
  let changed = true;
  while (changed) {
    changed = false;
    const slotCount = exprSlots(p).length;
    for (let si = 0; si < slotCount && !changed; si++) {
      const paths: number[][] = [];
      const collect = (e: Expr, path: number[]): void => {
        paths.push(path);
        exprChildren(e).forEach((c, i) => collect(c.get(), [...path, i]));
      };
      collect(exprSlots(p)[si].get(), []);
      for (const path of paths) {
        const target = (
          prog: Program,
        ): { get: () => Expr; set: (x: Expr) => void } => {
          let slot = exprSlots(prog)[si];
          for (const i of path) slot = exprChildren(slot.get())[i];
          return slot;
        };
        const forms = simplerForms(target(p).get());
        for (const form of forms) {
          const candidate = clone(p);
          target(candidate).set(clone(form));
          if (await keep(candidate)) {
            p = candidate;
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
  }
  return p;
}

export async function minimize(p: Program, keep: Keep): Promise<Program> {
  p = await dropStatements(p, keep);
  p = await dropEntries(p, keep);
  p = await simplifyExpressions(p, keep);
  // Dropped entries can free more statements.
  p = await dropStatements(p, keep);
  return p;
}
