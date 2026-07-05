/**
 * Desugaring AST → IR transform.
 *
 * Walks the structured Langium AST produced by the grammar and
 * lowers it into the flat, BPMN-shaped {@link BpmnProcess} IR defined in
 * `./ir/types.js`. The structured control-flow keywords (`if`/`else if`/`else`,
 * `while`, `do … while`, `parallel`, `goto`) become gateways + sequence flows;
 * implicit top-to-bottom sequence flow is materialised; implicit `start`/`end`
 * events are synthesised when the body does not declare them; conditions are
 * rendered to `${…}` bodies on the conditioned flows.
 *
 * All synthesised ids come exclusively from `./synthesize-ids.js` so
 * that the restructuring `irToDsl` can reproduce them exactly and the
 * round-trip is stable. No id is constructed inline.
 *
 * ============================================================================
 * STRUCTURAL-COORDINATE SCHEME  `<X>`  (FROZEN CONTRACT — `irToDsl` and the
 * round-trip normalizer consume it)
 * ============================================================================
 *
 * Every compound statement (`if` / `while` / `do-while` / `parallel`) needs a
 * structural coordinate `<X>` that seeds its synthesised gateway ids
 * (`Gateway_<X>_split`, `Gateway_<X>_join`, `Gateway_<X>_fork`,
 * `Gateway_<X>_loop`). The coordinate is **structural and deterministic** — it
 * is the compound statement's static position in the block tree, never a
 * traversal-order counter. Re-running this transform on the output of `irToDsl`
 * (which reconstructs the same block tree) therefore yields identical ids.
 *
 * Definition:
 *
 *   <X> = <enclosingBlockCoord> '_' <indexInBlock>
 *
 * where
 *   - <indexInBlock> is the **0-based index of the compound statement within the
 *     statement list of its immediately enclosing block**.
 *   - <enclosingBlockCoord> identifies that enclosing block. The process body is
 *     identified by the process id. A *nested* block belongs to a parent
 *     compound and is identified by the parent's <X> followed by a static
 *     **branch-discriminating segment** — because a single compound can own
 *     several sibling blocks (an `if`'s `then`/`else if`/`else`, a `parallel`'s
 *     branches), and a block has no statement of its own to index against. The
 *     segments, all static/structural (never traversal counters), are:
 *
 *       Block kind            Enclosing-block coordinate
 *       ────────────────────────────────────────────────
 *       process body          <processId>
 *       `if` then block       <X>_t
 *       i-th `else if` block   <X>_e<i>   (0-based: first `else if` ⇒ `_e0`)
 *       `else` block          <X>_e
 *       loop body (while)     <X>          (sole block ⇒ no segment needed)
 *       loop body (do-while)  <X>          (sole block ⇒ no segment needed)
 *       i-th `parallel` branch <X>_b<i>   (0-based)
 *
 *     A loop owns exactly one block, so its body has no sibling to collide with
 *     and needs no segment; a nested compound at body index 0 of a `while`/`do`
 *     at <X> reads <X>_0, distinct from any if-branch (`<X>_t_0`, `<X>_e_0`, …)
 *     or parallel-branch (`<X>_b0_0`) coordinate because those carry a segment
 *     a bare loop body never produces.
 *
 * Concretely:
 *   - A top-level `if` at body index 2 of `process invoice-approval` →
 *       <X> = `invoice-approval_2`,
 *       split gateway id = `Gateway_invoice-approval_2_split`,
 *       join  gateway id = `Gateway_invoice-approval_2_join`.
 *   - A `while` nested at index 0 of that `if`'s `then` block →
 *       then block coord = `invoice-approval_2_t`,
 *       <X> = `invoice-approval_2_t_0`,
 *       loop gateway id = `Gateway_invoice-approval_2_t_0_loop`.
 *   - The same `while` nested at index 0 of that `if`'s `else` block →
 *       else block coord = `invoice-approval_2_e`,
 *       <X> = `invoice-approval_2_e_0` (distinct from the `then` sibling).
 *   - A `parallel` at body index 1, its second branch (index 1) containing a
 *     nested `if` at index 0 →
 *       parallel  <X> = `<proc>_1`,
 *       fork id      = `Gateway_<proc>_1_fork`, join id = `Gateway_<proc>_1_join`,
 *       nested `if`  <X> = `<proc>_1_b1_0`.
 *
 * The coordinate is passed down explicitly while walking; it never depends on
 * how many gateways were emitted before. Gateway ids are NOT routed through the
 * `taken`/`resolveCollision` guard — two distinct structural coordinates never
 * produce the same gateway id (the position-path scheme is injective). Names
 * that would collide with a synthesised gateway id pattern are rejected upstream
 * by the validator (see `bpmn-script-validator.ts`).
 *
 * ============================================================================
 * ENTRY / EXIT CONTRACT
 * ============================================================================
 *
 * Lowering a statement returns `{ entry, exit }` (or `null` exit when control
 * does not fall through — an explicit `end`, or a block whose final statement
 * jumped away via `goto`):
 *   - `entry` is the id of the node an incoming flow must target.
 *   - `exit`  is the id of the node an outgoing fall-through flow leaves from,
 *             or `null` when control terminates / transfers explicitly.
 * For a simple statement entry === exit === the element's own id. For a
 * compound statement, entry is the split/fork/loop boundary and exit is the
 * join boundary (or the loop gateway, for a `while`).
 */

import {
  isStartEvent,
  isEndEvent,
  isUserTask,
  isServiceTask,
  isIfStatement,
  isWhileStatement,
  isDoWhileStatement,
  isParallelStatement,
  isGotoStatement,
  isLiteralString,
  isVarRef,
  renderExpression,
} from '@bpmn-script/language';
import type {
  Model,
  Process,
  Statement,
  Block,
  StartEvent as AstStartEvent,
  EndEvent as AstEndEvent,
  UserTask as AstUserTask,
  ServiceTask as AstServiceTask,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ParallelStatement,
  GotoStatement,
  Attribute,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow as IrSequenceFlow,
} from './ir/types.js';
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
} from './synthesize-ids.js';

/**
 * The fall-through boundary of a lowered statement or block.
 *
 * `exit` is `null` when control does not fall through to a following statement:
 * an explicit `end` event, or a block whose last statement transferred control
 * explicitly (`goto`). A `null` exit suppresses the implicit sequence flow to
 * the next sibling and the implicit join/end continuation.
 */
interface Frontier {
  /**
   * Id of the node an incoming flow must target, or `null` for an empty block
   * (no statements to enter — the caller routes the incoming flow straight to
   * the construct's join instead).
   */
  entry: string | null;
  /** Id of the node a fall-through flow leaves from, or `null` if none. */
  exit: string | null;
  /**
   * When set, the fall-through flow that the sequence chain emits **out of**
   * `exit` must use this exact id (and become its source gateway's default
   * flow), rather than a freshly synthesised `Flow_<src>_<tgt>` id.
   *
   * Used by `while`: the loop gateway's single non-back-edge outgoing flow is
   * its unconditioned default exit, whose id is reserved as
   * `Flow_<loopId>_default` and referenced by the gateway's `defaultFlowId`.
   */
  exitFlowId?: string;
}

/**
 * Mutable accumulator threaded through the recursive walk.
 *
 * `taken` seeds collision resolution: it is pre-populated with **every named
 * element id** before lowering begins, so synthesised flow/end ids never clash
 * with an author-chosen statement name. `makeSequenceFlowId`/`makeEndEventId`
 * mutate it in place.
 */
interface Builder {
  readonly processId: string;
  readonly flowElements: FlowElement[];
  readonly sequenceFlows: IrSequenceFlow[];
  readonly taken: Set<string>;
}

/**
 * Convert an AST `Model` into an engine-agnostic {@link BpmnProcess}.
 *
 * Only the **first** `process` block is converted; further `process` blocks are
 * ignored (a deliberate single-process limitation, not a parser guarantee).
 *
 * @param model The root AST node from `parseHelper<Model>` / the document builder.
 * @returns A fully-populated `BpmnProcess` ready for downstream transforms.
 * @throws {Error} When the model contains no process definitions.
 */
export function astToIr(model: Model): BpmnProcess {
  const process = model.processes[0];
  if (!process) {
    throw new Error('astToIr: the model contains no process definitions.');
  }

  const builder: Builder = {
    processId: process.name,
    flowElements: [],
    sequenceFlows: [],
    taken: collectNamedIds(process),
  };

  // 1. Lower the process body block. `entry`/`exit` mark where the implicit
  //    start flows in and where an implicit end (if any) flows out.
  const body = lowerBlockStatements(builder, process.body, process.name);

  // 2. Materialise the implicit start event when the body does not open with an
  //    explicit `start`. The start always flows to the body's entry.
  if (body.entry !== null) {
    const firstIsExplicitStart =
      process.body.length > 0 && isStartEvent(process.body[0]!);
    if (!firstIsExplicitStart) {
      // `makeStartEventId` resolves a collision with an author-chosen id and
      // records the result in `builder.taken` itself.
      const startId = makeStartEventId(process.name, builder.taken);
      builder.flowElements.unshift({ kind: 'startEvent', id: startId });
      addFlow(builder, startId, body.entry);
    }
  }

  // 3. Materialise the implicit end event when control falls off the body end
  //    and the last statement is not an explicit `end`.
  if (body.exit !== null) {
    const last = process.body[process.body.length - 1];
    const lastIsExplicitEnd = last !== undefined && isEndEvent(last);
    if (!lastIsExplicitEnd) {
      const endId = makeEndEventId(process.name, builder.taken);
      builder.flowElements.push({ kind: 'endEvent', id: endId });
      // Honour a reserved exit-flow id (e.g. when the body ends in a `while`,
      // the loop's default-exit flow id is stamped on the flow to the end).
      addFlow(builder, body.exit, endId, undefined, body.exitFlowId);
    }
  }

  const label = processLabel(process);

  return {
    id: process.name,
    ...(label !== undefined ? { name: label } : {}),
    isExecutable: true,
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
  };
}

// ---------------------------------------------------------------------------
// Block / statement-list lowering
// ---------------------------------------------------------------------------

/**
 * Lower a flat list of statements with implicit top-to-bottom sequence flow.
 *
 * Each statement is lowered in turn; a {@link SequenceFlow} is emitted from the
 * previous statement's `exit` to the current statement's `entry`. When a
 * statement has a `null` exit (explicit `end` or a `goto`), the chain breaks:
 * subsequent statements are still lowered (they may be jump targets) but no
 * implicit flow bridges the gap.
 *
 * @param coord The structural coordinate of the *enclosing* block — compound
 *   children index against it to form their own `<X>`.
 * @returns The block frontier: `entry` is the first statement's entry (or
 *   `null` for an empty block), `exit` is the last fall-through exit (or `null`
 *   when control does not reach the block end).
 */
function lowerBlockStatements(
  builder: Builder,
  statements: Statement[],
  coord: string,
): Frontier {
  let entry: string | null = null;
  let prevExit: string | null = null;
  let prevExitFlowId: string | undefined;
  let lastFrontier: Frontier | undefined;

  statements.forEach((stmt, index) => {
    const frontier = lowerStatement(builder, stmt, coord, index);
    // A statement always has a concrete entry node (only an empty *block* — never
    // a top-level statement — yields a null entry), so this is non-null here.
    const stmtEntry = frontier.entry!;

    if (entry === null) {
      entry = stmtEntry;
    }
    if (prevExit !== null) {
      addFlow(builder, prevExit, stmtEntry, undefined, prevExitFlowId);
    }
    prevExit = frontier.exit;
    prevExitFlowId = frontier.exitFlowId;
    lastFrontier = frontier;
  });

  // Propagate the trailing statement's `exitFlowId` so the block's own exit
  // flow (e.g. an implicit end, or a join continuation) honours a reserved
  // default-flow id when the block ends in a `while` loop.
  return {
    entry,
    exit: prevExit,
    ...(lastFrontier?.exitFlowId !== undefined
      ? { exitFlowId: lastFrontier.exitFlowId }
      : {}),
  };
}

/**
 * Lower a brace-delimited {@link Block}, indexing its compound children against
 * the supplied enclosing-block coordinate. The caller passes the fully-formed
 * coordinate including any branch-discriminating segment (e.g. an `if`'s `then`
 * block is lowered with `<X>_t`, its `else` with `<X>_e`, a `parallel` branch
 * with `<X>_b<i>`) so sibling blocks of one compound never share a coordinate.
 */
function lowerBlock(builder: Builder, block: Block, coord: string): Frontier {
  return lowerBlockStatements(builder, block.statements, coord);
}

/**
 * Dispatch a single statement to its lowering rule and return its frontier.
 *
 * @param coord The enclosing block's coordinate.
 * @param index The statement's 0-based position in its enclosing block; used to
 *   form a compound statement's structural coordinate `<coord>_<index>`.
 */
function lowerStatement(
  builder: Builder,
  stmt: Statement,
  coord: string,
  index: number,
): Frontier {
  if (isStartEvent(stmt)) {
    return lowerStartEvent(builder, stmt);
  }
  if (isEndEvent(stmt)) {
    return lowerEndEvent(builder, stmt);
  }
  if (isUserTask(stmt)) {
    return lowerUserTask(builder, stmt);
  }
  if (isServiceTask(stmt)) {
    return lowerServiceTask(builder, stmt);
  }
  if (isIfStatement(stmt)) {
    return lowerIf(builder, stmt, `${coord}_${index}`);
  }
  if (isWhileStatement(stmt)) {
    return lowerWhile(builder, stmt, `${coord}_${index}`);
  }
  if (isDoWhileStatement(stmt)) {
    return lowerDoWhile(builder, stmt, `${coord}_${index}`);
  }
  if (isParallelStatement(stmt)) {
    return lowerParallel(builder, stmt, `${coord}_${index}`);
  }
  if (isGotoStatement(stmt)) {
    return lowerGoto(stmt);
  }
  // Exhaustiveness guard: the Statement union is closed by the grammar.
  throw new Error(
    `astToIr: unexpected statement type '${(stmt as { $type: string }).$type}'.`,
  );
}

// ---------------------------------------------------------------------------
// Simple statements
// ---------------------------------------------------------------------------

/** Lower an explicit `start` event. Entry === exit === its own id. */
function lowerStartEvent(builder: Builder, stmt: AstStartEvent): Frontier {
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Lower an explicit `end` event. Its exit is `null`: control terminates, so no
 * implicit fall-through flow or join continuation is emitted after it.
 */
function lowerEndEvent(builder: Builder, stmt: AstEndEvent): Frontier {
  builder.flowElements.push({
    kind: 'endEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
  });
  return { entry: stmt.name, exit: null };
}

/** Lower a `user` task, mapping `assignee`/`formKey` attributes. */
function lowerUserTask(builder: Builder, stmt: AstUserTask): Frontier {
  const assignee = attrValue(stmt.attrs, 'assignee');
  const formKey = attrValue(stmt.attrs, 'formKey');
  builder.flowElements.push({
    kind: 'userTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(formKey !== undefined ? { formKey } : {}),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/** Lower a `service` task, mapping the `class` attribute to `javaClass`. */
function lowerServiceTask(builder: Builder, stmt: AstServiceTask): Frontier {
  const javaClass = attrValue(stmt.attrs, 'class') ?? '';
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    javaClass,
  });
  return { entry: stmt.name, exit: stmt.name };
}

// ---------------------------------------------------------------------------
// Compound statements
// ---------------------------------------------------------------------------

/**
 * Lower `if` / `else if` / `else` to an exclusive-gateway split + join.
 *
 * - A split `ExclusiveGateway` `Gateway_<X>_split` and join
 *   `ExclusiveGateway` `Gateway_<X>_join` are emitted.
 * - Each `if`/`else if` branch gets a conditioned flow split→(branch entry)
 *   carrying `conditionExpression = ${c}`.
 * - The trailing `else` (or an implicit fall-through when absent) gets an
 *   **unconditioned** flow split→(else entry / join) whose id becomes the
 *   gateway's `defaultFlowId`. The default flow never carries a condition
 *   (Operaton rejects a conditioned default).
 * - Each branch's fall-through exit flows into the join. A branch terminating
 *   in an explicit `end` (null exit) gets no join continuation.
 *
 * Entry is the split gateway; exit is the join gateway.
 */
function lowerIf(builder: Builder, stmt: IfStatement, x: string): Frontier {
  const splitId = makeGatewaySplitId(x);
  const joinId = makeGatewayJoinId(x);

  // Default flow id is reserved up-front so it is stable regardless of branch
  // count; it is attached to the split gateway as `defaultFlowId`.
  const defaultFlowId = makeDefaultFlowId(splitId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: splitId,
    defaultFlowId,
  });
  builder.flowElements.push({ kind: 'exclusiveGateway', id: joinId });

  // Conditioned branches: the `if` block plus every `else if`. Branch segments
  // (`_t`, `_e<i>`) follow the structural-coordinate scheme in the file header.
  lowerConditionedBranches(builder, stmt, x, splitId, joinId);

  // The trailing `else`, or an implicit fall-through, is the default flow. The
  // `else` block carries the `_e` segment (no index — there is at most one).
  if (stmt.elseBlock !== undefined) {
    const elseBranch = lowerBlock(builder, stmt.elseBlock, `${x}_e`);
    if (elseBranch.entry !== null) {
      addFlow(builder, splitId, elseBranch.entry, undefined, defaultFlowId);
    } else {
      addFlow(builder, splitId, joinId, undefined, defaultFlowId);
    }
    joinContinuation(builder, elseBranch, joinId);
  } else {
    // No `else`: the implicit fall-through goes split→join as the default.
    addFlow(builder, splitId, joinId, undefined, defaultFlowId);
  }

  return { entry: splitId, exit: joinId };
}

/**
 * Lower the conditioned branches of an `if` (the `then` block plus every
 * `else if`) into conditioned split→branch flows and their join continuations.
 *
 * Each branch is a block with no statement of its own to index against, so it
 * contributes a static branch-discriminating coordinate segment (`_t` for
 * `then`, `_e<i>` for the i-th `else if`) before its nested compounds index
 * against it — keeping a nested compound at index 0 of `then` (`<X>_t_0`)
 * distinct from one at index 0 of `else` (`<X>_e_0`), exactly as `parallel`
 * does with `b<i>`. An empty conditioned branch routes the condition straight
 * to the join.
 */
function lowerConditionedBranches(
  builder: Builder,
  stmt: IfStatement,
  x: string,
  splitId: string,
  joinId: string,
): void {
  const conditioned: { condition: string; block: Block; seg: string }[] = [
    { condition: renderExpression(stmt.condition), block: stmt.then, seg: 't' },
    ...stmt.elseIfs.map((ei, i) => ({
      condition: renderExpression(ei.condition),
      block: ei.body,
      seg: `e${i}`,
    })),
  ];

  for (const { condition, block, seg } of conditioned) {
    const branch = lowerBlock(builder, block, `${x}_${seg}`);
    if (branch.entry !== null) {
      addFlow(builder, splitId, branch.entry, condition);
    } else {
      // Empty conditioned branch: route the condition straight to the join.
      addFlow(builder, splitId, joinId, condition);
    }
    joinContinuation(builder, branch, joinId);
  }
}

/**
 * Lower `while (c) { body }` to a pre-test XOR loop.
 *
 * A loop-head `ExclusiveGateway` `Gateway_<X>_loop` is emitted. Entry flows
 * into the loop gateway; from it a conditioned flow (`${c}`) enters the body
 * and an unconditioned **default** flow leaves the loop (the loop exit). The
 * body's fall-through exit flows **back** to the loop gateway (the back-edge).
 *
 * Never emits `standardLoopCharacteristics` — the loop is a gateway + back-edge
 * only. Entry === exit === the loop gateway (the default flow leaves from it).
 */
function lowerWhile(
  builder: Builder,
  stmt: WhileStatement,
  x: string,
): Frontier {
  const loopId = makeGatewayLoopId(x);
  const defaultFlowId = makeDefaultFlowId(loopId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: loopId,
    defaultFlowId,
  });

  const condition = renderExpression(stmt.condition);
  const body = lowerBlock(builder, stmt.body, x);

  if (body.entry !== null) {
    // Conditioned entry into the body.
    addFlow(builder, loopId, body.entry, condition);
  }
  if (body.exit !== null) {
    // Back-edge: body fall-through returns to the loop head.
    addFlow(builder, body.exit, loopId);
  }

  // The unconditioned default flow out of the loop is the loop gateway's single
  // non-back-edge outgoing flow. Its id is reserved and surfaced via
  // `exitFlowId` so the enclosing sequence chain stamps it on the fall-through
  // flow (to the next statement or the implicit end) and the gateway's
  // `defaultFlowId` matches. The loop gateway is both entry and exit.
  return { entry: loopId, exit: loopId, exitFlowId: defaultFlowId };
}

/**
 * Lower `do { body } while (c)` to a post-test XOR loop.
 *
 * The body runs first; a loop `ExclusiveGateway` `Gateway_<X>_loop` sits after
 * the body. The loop gateway has a conditioned flow (`${c}`) **back** into the
 * body entry and an unconditioned default flow to the loop exit. Entry is the
 * body entry; exit is the loop gateway.
 *
 * Never emits `standardLoopCharacteristics`.
 */
function lowerDoWhile(
  builder: Builder,
  stmt: DoWhileStatement,
  x: string,
): Frontier {
  const loopId = makeGatewayLoopId(x);
  const defaultFlowId = makeDefaultFlowId(loopId);

  const condition = renderExpression(stmt.condition);
  const body = lowerBlock(builder, stmt.body, x);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: loopId,
    defaultFlowId,
  });

  // Body fall-through reaches the loop gateway.
  if (body.exit !== null) {
    addFlow(builder, body.exit, loopId, undefined, body.exitFlowId);
  }
  // Conditioned back-edge into the body entry.
  if (body.entry !== null) {
    addFlow(builder, loopId, body.entry, condition);
  }

  // The loop gateway's single non-back-edge outgoing flow is its unconditioned
  // default exit; surface its reserved id via `exitFlowId` so the enclosing
  // chain stamps it and the gateway's `defaultFlowId` matches.
  const entry = body.entry ?? loopId;
  return { entry, exit: loopId, exitFlowId: defaultFlowId };
}

/**
 * Lower `parallel { { A } { B } … }` to an AND fork/join pair.
 *
 * `Gateway_<X>_fork` (`ParallelGateway`) and `Gateway_<X>_join`
 * (`ParallelGateway`) are emitted. Each branch gets one unconditioned flow
 * fork→(branch entry); each branch fall-through exit flows to the join. No
 * conditions are emitted on parallel-outgoing flows (Operaton ignores them).
 *
 * Each branch's compound children index against a `b<branchIndex>` segment of
 * the coordinate (a branch is a block with no statement to index against).
 * Entry is the fork; exit is the join.
 */
function lowerParallel(
  builder: Builder,
  stmt: ParallelStatement,
  x: string,
): Frontier {
  const forkId = makeGatewayForkId(x);
  const joinId = makeGatewayJoinId(x);

  builder.flowElements.push({ kind: 'parallelGateway', id: forkId });
  builder.flowElements.push({ kind: 'parallelGateway', id: joinId });

  stmt.branches.forEach((branch, branchIndex) => {
    const lowered = lowerBlock(builder, branch, `${x}_b${branchIndex}`);
    if (lowered.entry !== null) {
      addFlow(builder, forkId, lowered.entry);
    } else {
      // Empty branch: fork straight to join.
      addFlow(builder, forkId, joinId);
    }
    joinContinuation(builder, lowered, joinId);
  });

  return { entry: forkId, exit: joinId };
}

/**
 * Lower `goto target` to a raw sequence flow from this statement's position to
 * the target statement's entry node.
 *
 * The flow source is filled in by the enclosing sequence chain (the previous
 * statement's exit flows into this `goto`'s entry, which is the target). The
 * `goto` itself produces no node: its `entry` is the resolved target's id and
 * its `exit` is `null` (control transfers explicitly, so no fall-through).
 *
 * Because there is no synthesised node for the jump, the implicit sequence flow
 * from the preceding statement lands directly on the target — exactly the "raw
 * flow to the target node" the contract requires.
 */
function lowerGoto(stmt: GotoStatement): Frontier {
  // `$refText` is the target id verbatim (cross-refs key on `name=ID`), and is
  // present even when the linker could not resolve the reference. Using it
  // directly avoids narrowing the `Statement` union (not every member exposes
  // `name`) and keeps the desugarer total over unresolved gotos.
  const targetId = stmt.target.$refText;
  return { entry: targetId, exit: null };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit a {@link SequenceFlow} from `sourceRef` to `targetRef`.
 *
 * When `forcedId` is supplied the flow is created with that exact id — used for
 * a gateway's reserved default flow (the gateway already references it as its
 * `defaultFlowId`) and for a `while` loop's reserved default-exit flow.
 * Otherwise a deterministic id is synthesised via {@link makeSequenceFlowId}. A
 * `conditionExpression` is attached only when `condition` is provided.
 */
function addFlow(
  builder: Builder,
  sourceRef: string,
  targetRef: string,
  condition?: string,
  forcedId?: string,
): void {
  const id =
    forcedId !== undefined
      ? forcedId
      : makeSequenceFlowId(sourceRef, targetRef, builder.taken);
  // Register a forced id in the collision set so a later synthesised flow with
  // the same source/target pair gets a `_2` suffix rather than colliding.
  if (forcedId !== undefined) {
    builder.taken.add(forcedId);
  }

  builder.sequenceFlows.push({
    id,
    ...(condition !== undefined ? { conditionExpression: condition } : {}),
    sourceRef,
    targetRef,
  });
}

/**
 * Emit the flow from a branch's fall-through exit into a convergence gateway
 * (an `if`/`else` XOR join or a `parallel` AND join), honouring a reserved
 * `exitFlowId` when the branch ends in a `while` loop. A branch that terminated
 * (null exit — explicit `end` or `goto`) gets no continuation.
 */
function joinContinuation(
  builder: Builder,
  branch: Frontier,
  joinId: string,
): void {
  if (branch.exit !== null) {
    addFlow(builder, branch.exit, joinId, undefined, branch.exitFlowId);
  }
}

/**
 * Collect every author-chosen element id (statement names) in the process,
 * recursively descending compound statements. Used to seed the collision set so
 * synthesised flow/end ids never clash with a named element.
 */
function collectNamedIds(process: Process): Set<string> {
  const taken = new Set<string>();
  const visit = (statements: Statement[]): void => {
    for (const stmt of statements) {
      if (
        isStartEvent(stmt) ||
        isEndEvent(stmt) ||
        isUserTask(stmt) ||
        isServiceTask(stmt)
      ) {
        taken.add(stmt.name);
      } else if (isIfStatement(stmt)) {
        visit(stmt.then.statements);
        for (const ei of stmt.elseIfs) visit(ei.body.statements);
        if (stmt.elseBlock) visit(stmt.elseBlock.statements);
      } else if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
        visit(stmt.body.statements);
      } else if (isParallelStatement(stmt)) {
        for (const branch of stmt.branches) visit(branch.statements);
      }
      // GotoStatement contributes no new id (it references an existing one).
    }
  };
  visit(process.body);
  return taken;
}

/**
 * Resolve the value of a single attribute by key into the plain string the IR
 * carries for `assignee` / `formKey` / `javaClass`.
 *
 * Attribute values are full expressions in the grammar, but the current
 * attribute set holds plain BPMN attribute text, not `${…}` expression bodies:
 *   - A **string literal** (`assignee = "demo"`) yields its bare value `demo`.
 *   - A **bareword** value (`class = com.example.X`, parsed as a dotted
 *     `VarRef` with no accessors collapsing to the dotted path) yields the path
 *     verbatim — `com.example.X`.
 *   - Any **other expression** (genuinely dynamic value) falls back to the
 *     canonical `${…}` body via {@link renderExpression}, stored verbatim.
 *
 * Returns the value of the **first** matching attribute; duplicate-key
 * detection is the validator's job, not the desugarer's.
 */
function attrValue(attrs: Attribute[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  if (attr === undefined) {
    return undefined;
  }
  const value = attr.value;
  if (isLiteralString(value)) {
    // The lexer already stripped the surrounding quotes — carry the bare value.
    return value.value;
  }
  if (isVarRef(value) && value.accessors.length === 0) {
    // A bare identifier (e.g. a single-segment class would be unusual but legal).
    return value.name;
  }
  // A dotted/bracketed VarRef (`com.example.X`) or any other expression: render
  // it. For a dotted VarRef this yields `${com.example.X}`; strip the `${…}`
  // wrapper so the IR carries the plain dotted path the BPMN attribute expects.
  const rendered = renderExpression(value);
  if (isVarRef(value)) {
    return stripExpressionWrapper(rendered);
  }
  return rendered;
}

/**
 * Strip a `${…}` wrapper from a rendered expression, returning the bare inner
 * text. Used for dotted-identifier attribute values (`com.example.X`) that the
 * grammar parses as a `VarRef` but that map to plain BPMN attribute text. A
 * string without the wrapper is returned unchanged.
 */
function stripExpressionWrapper(rendered: string): string {
  if (rendered.startsWith('${') && rendered.endsWith('}')) {
    return rendered.slice(2, -1);
  }
  return rendered;
}

/**
 * Extract the process-level `label = "…"` declaration value, if present.
 *
 * The label can be authored either inline after the process id
 * (`process P "Label" { … }`, stored as `process.label`) or as a header
 * `label = "…"` declaration (a `ProcessLabel` in `process.decls`). The inline
 * form takes precedence; otherwise the first `ProcessLabel` declaration wins.
 */
function processLabel(process: Process): string | undefined {
  if (process.label !== undefined) {
    return process.label;
  }
  for (const decl of process.decls) {
    if (decl.$type === 'ProcessLabel') {
      return decl.value;
    }
  }
  return undefined;
}
