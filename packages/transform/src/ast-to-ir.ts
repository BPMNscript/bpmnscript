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
 * ## Structural-coordinate scheme `<X>`
 *
 * The scheme changes only in lockstep with `synthesize-ids.ts`, `ir-to-dsl.ts`,
 * and the round-trip normalizer (`tests/helpers/normalize-ir.ts`) — decompile
 * round-trip id stability depends on reproducing the same coordinates.
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
 *       subprocess body       <X>          (sole block ⇒ no segment needed)
 *       `on` handler body     <X>          (sole block ⇒ no segment needed)
 *
 *     A loop owns exactly one block, so its body has no sibling to collide with
 *     and needs no segment; a `subprocess` is likewise a single-block compound,
 *     so its body's enclosing coordinate is the sub-process's own <X>. Rooting
 *     the body at the sub-process *name* instead would be shorter but unsafe:
 *     gateway ids skip `resolveCollision`, so a sub-process named like a
 *     structural coordinate could duplicate a gateway id elsewhere. Positional
 *     coordinates have no such hole.
 *
 *     An `on` handler is also a single-block compound: at index i of block C it
 *     has coordinate <X> = C_i and id `EventSubProcess_<X>`, and — like a loop
 *     body — its body's enclosing coordinate is that same <X>, so nested
 *     gateways come out `Gateway_<X>_<j>_…`. Its implicit start/end seed from
 *     the handler id (`StartEvent_<id>` / `EndEvent_<id>`). An unnamed
 *     `throw`/`emit` at index i of block C is a leaf event with id
 *     `Throw_<C>_<i>` (an authored id is used verbatim instead).
 *
 * ## Implicit-event seeding by container id
 *
 * A container's implicit start/end are seeded from the container's own id — the
 * process id at the top level, the sub-process *name* inside a sub-process
 * (`StartEvent_<name>` / `EndEvent_<name>`) — and routed through
 * `resolveCollision` against a single process-wide `taken` set, so every
 * synthesised id is document-unique across all containers.
 *
 * Example: a `while` nested at index 0 of the `then` block of an `if` at body
 * index 2 of `process invoice-approval` →
 *       then block coord = `invoice-approval_2_t`,
 *       <X> = `invoice-approval_2_t_0`,
 *       loop gateway id = `Gateway_invoice-approval_2_t_0_loop`.
 *
 * The coordinate is passed down explicitly while walking; it never depends on
 * how many gateways were emitted before. Gateway ids are NOT routed through the
 * `taken`/`resolveCollision` guard — two distinct structural coordinates never
 * produce the same gateway id. Names that would collide with a synthesised
 * gateway id pattern are rejected upstream by the validator
 * (see `bpmn-script-validator.ts`).
 *
 * ## Entry / exit contract
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
 *
 * An `on` handler is the exception: it is lowered **out of the sequence chain**
 * and returns no frontier at all. It contributes nodes to the container but
 * never participates in its flow — the statement before it flows directly to
 * the statement after it, so a handler placed anywhere (including mid-body,
 * which the validator rejects) still yields correct flow.
 *
 * Which nodes it contributes depends on its host slot. A host-less handler
 * guards the whole surrounding body and becomes one `triggeredByEvent`
 * sub-process wrapping its body. A hosted handler (`on <Host>: <trigger>`)
 * guards a single running activity and becomes a `boundaryEvent` attached to
 * it, lowered **inline into the host's own container**: the event node and
 * every statement of its body land in the same arrays as the main flow, chained
 * from the boundary event to an end event of the escape path's own. Sharing one
 * container is what lets a `goto` cross between the escape chain and the main
 * flow — the only route back, since nothing rejoins implicitly.
 */

import {
  isStartEvent,
  isEndEvent,
  isUserTask,
  isServiceTask,
  isExternalTask,
  isScriptTask,
  isIfStatement,
  isWhileStatement,
  isDoWhileStatement,
  isParallelStatement,
  isGotoStatement,
  isSubProcess,
  isCallActivity,
  isOnHandler,
  isThrowStatement,
  isEmitStatement,
  isIntermediateCatchEvent,
  isErrorDecl,
  isLiteralString,
  isLiteralBool,
  isLiteralInt,
  isLiteralDecimal,
  isVarRef,
  renderExpression,
} from '@bpmn-script/language';
import type {
  Model,
  Process,
  Statement,
  Block,
  Expr,
  StartEvent as AstStartEvent,
  EndEvent as AstEndEvent,
  UserTask as AstUserTask,
  ServiceTask as AstServiceTask,
  ExternalTask as AstExternalTask,
  ScriptTask as AstScriptTask,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ParallelStatement,
  GotoStatement,
  SubProcess as AstSubProcess,
  CallActivity as AstCallActivity,
  OnHandler,
  ThrowStatement,
  EmitStatement,
  IntermediateCatchEvent,
  VariableMapping,
  Attribute,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  CalledElementBinding,
  CallVariableMapping,
  EventDefinition,
  FlowElement,
  FormField,
  FormFieldType,
  SequenceFlow as IrSequenceFlow,
  ServiceTaskBinding,
  StartEvent as IrStartEvent,
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
  makeThrowEventId,
  makeEventSubProcessId,
  makeBoundaryEventId,
  makeIntermediateCatchEventId,
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
 * Mutable accumulator threaded through the recursive walk. Each flow container
 * (the process and every sub-process body) gets its own `flowElements` /
 * `sequenceFlows` arrays, but shares one `taken` set with the whole document.
 *
 * `taken` seeds collision resolution: it is pre-populated with **every named
 * element id** in the process before lowering begins, so synthesised flow/end
 * ids never clash with an author-chosen statement name — anywhere in the
 * document, including inside a nested sub-process. A single shared set keeps
 * every synthesised id document-unique, which BPMN requires (`id` is an XML
 * ID). `makeSequenceFlowId`/`makeStartEventId`/`makeEndEventId` mutate it in
 * place.
 */
interface Builder {
  readonly flowElements: FlowElement[];
  readonly sequenceFlows: IrSequenceFlow[];
  readonly taken: Set<string>;
}

/**
 * Convert an AST `Model` into a {@link BpmnProcess}.
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
    flowElements: [],
    sequenceFlows: [],
    taken: collectNamedIds(process),
  };

  // The process body is the top-level container: both its structural coordinate
  // and its implicit-event seed are the process id.
  lowerContainerBody(builder, process.body, process.name, process.name);

  const label = processLabel(process);
  const errorMessages = collectErrorMessages(process);

  return {
    id: process.name,
    ...(label !== undefined ? { name: label } : {}),
    isExecutable: true,
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
    ...(errorMessages.length > 0 ? { errorMessages } : {}),
  };
}

/**
 * Collect the process-header `error "CODE" message "…"` declarations into the
 * IR's `errorMessages`, in declaration order.
 *
 * The declared message text is the one piece of root-element data usage alone
 * cannot recover (two throws of a code share one root, so the text cannot live
 * on a throw). A duplicate declaration of the same code keeps the **first** — the
 * desugarer stays total; the validator owns the duplicate diagnostic. Every
 * declaration contributes its entry regardless of the exact words written for
 * its kind/field (those are validated in position, not here).
 */
function collectErrorMessages(
  process: Process,
): { code: string; message: string }[] {
  const messages: { code: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const decl of process.decls) {
    if (isErrorDecl(decl) && !seen.has(decl.code)) {
      seen.add(decl.code);
      messages.push({ code: decl.code, message: decl.message });
    }
  }
  return messages;
}

/**
 * Lower one flow container's body — the process body, or a sub-process body —
 * into the supplied builder: the statement list plus the implicit start/end
 * events synthesised when the body does not declare them explicitly.
 *
 * The process and every sub-process share this exact shape (a node set + edge
 * set), so one function serves both. It mutates `builder` in place and returns
 * nothing.
 *
 * @param coord       Structural coordinate of the body's enclosing block —
 *   compound children index against it to form their own `<X>`. For the process
 *   body this is the process id; for a sub-process body it is the sub-process's
 *   own structural coordinate `<X>` (the single-block compound rule, like a
 *   loop body).
 * @param containerId Seed for the implicit start/end ids
 *   (`StartEvent_<containerId>` / `EndEvent_<containerId>`) — the process id at
 *   the top level, the sub-process name inside a sub-process. Routed through
 *   `resolveCollision` against the shared `taken` set so the ids stay
 *   document-unique.
 */
function lowerContainerBody(
  builder: Builder,
  statements: Statement[],
  coord: string,
  containerId: string,
): void {
  // 1. Lower the statement list. `entry`/`exit` mark where an implicit start
  //    flows in and where an implicit end (if any) flows out.
  const body = lowerBlockStatements(builder, statements, coord);

  // 2. Materialise the implicit start event when the body does not open with an
  //    explicit `start`. The start always flows to the body's entry.
  if (body.entry !== null) {
    const firstIsExplicitStart =
      statements.length > 0 && isStartEvent(statements[0]!);
    if (!firstIsExplicitStart) {
      // `makeStartEventId` resolves a collision with an author-chosen id and
      // records the result in `builder.taken` itself.
      const startId = makeStartEventId(containerId, builder.taken);
      builder.flowElements.unshift({ kind: 'startEvent', id: startId });
      addFlow(builder, startId, body.entry);
    }
  }

  // 3. Materialise the implicit end event when control falls off the body end
  //    and the last statement is not an explicit `end`.
  if (body.exit !== null) {
    const last = statements[statements.length - 1];
    const lastIsExplicitEnd = last !== undefined && isEndEvent(last);
    if (!lastIsExplicitEnd) {
      const endId = makeEndEventId(containerId, builder.taken);
      builder.flowElements.push({ kind: 'endEvent', id: endId });
      // Honour a reserved exit-flow id (e.g. when the body ends in a `while`,
      // the loop's default-exit flow id is stamped on the flow to the end).
      addFlow(builder, body.exit, endId, undefined, body.exitFlowId);
    }
  } else if (body.entry === null) {
    // The body has no flow step at all (empty, or every statement is an `on`
    // handler contributing no entry): neither branch above ran, so the
    // container would otherwise end up with no start event — invalid BPMN.
    // Synthesise a bare start → end pair, the same shape `ensureHandlerStart`
    // gives an empty event-sub-process body.
    const startId = makeStartEventId(containerId, builder.taken);
    const endId = makeEndEventId(containerId, builder.taken);
    builder.flowElements.unshift({ kind: 'startEvent', id: startId });
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    addFlow(builder, startId, endId);
  }
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
    // An `on` handler contributes nodes but never joins the sequence chain: it
    // catches an event (error, escalation, compensation, message, signal,
    // timer, or condition), it is not a flow step. Both forms are lowered
    // out-of-chain, leaving `prevExit`/`entry` untouched, so the statement
    // before the handler flows directly to the statement after it.
    //
    // The host slot decides *which* BPMN construct catches: a host-less handler
    // guards the whole surrounding body and becomes an event sub-process; a
    // hosted one guards a single running activity and becomes a boundary event
    // attached to it, lowered inline into this same container.
    if (isOnHandler(stmt)) {
      if (stmt.host !== undefined) {
        // `$refText` is the host id verbatim (cross-refs key on `name=ID`) and
        // is present even when the linker could not resolve the reference — the
        // same totality `lowerGoto` relies on. Dispatching on the *slot* rather
        // than on its resolution also keeps this in step with the scope
        // provider, whose container walk is transparent for any handler that
        // carries a host, resolved or not.
        lowerBoundaryHandler(builder, stmt, stmt.host.$refText, coord, index);
      } else {
        lowerOnHandler(builder, stmt, coord, index);
      }
      return;
    }

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
  if (isExternalTask(stmt)) {
    return lowerExternalTask(builder, stmt);
  }
  if (isScriptTask(stmt)) {
    return lowerScriptTask(builder, stmt);
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
  if (isSubProcess(stmt)) {
    return lowerSubProcess(builder, stmt, `${coord}_${index}`);
  }
  if (isCallActivity(stmt)) {
    return lowerCallActivity(builder, stmt);
  }
  if (isThrowStatement(stmt)) {
    return lowerThrow(builder, stmt, coord, index);
  }
  if (isEmitStatement(stmt)) {
    return lowerEmit(builder, stmt, coord, index);
  }
  if (isIntermediateCatchEvent(stmt)) {
    return lowerIntermediateCatch(builder, stmt, coord, index);
  }
  // `OnHandler` is intercepted by `lowerBlockStatements` (it is not a flow step),
  // so it never reaches here. Every other Statement member is handled above.
  throw new Error(
    `astToIr: unexpected statement type '${(stmt as { $type: string }).$type}'.`,
  );
}

// ---------------------------------------------------------------------------
// Simple statements
// ---------------------------------------------------------------------------

/** Lower an explicit `start` event, mapping any `form { … }` block. */
function lowerStartEvent(builder: Builder, stmt: AstStartEvent): Frontier {
  const formFields = lowerFormFields(stmt);
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(formFields !== undefined ? { formFields } : {}),
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

/** Lower a `user` task, mapping `assignee`/`formKey` and any `form` block. */
function lowerUserTask(builder: Builder, stmt: AstUserTask): Frontier {
  const assignee = attrValue(stmt.attrs, 'assignee');
  const formKey = attrValue(stmt.attrs, 'formKey');
  const formFields = lowerFormFields(stmt);
  builder.flowElements.push({
    kind: 'userTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(formKey !== undefined ? { formKey } : {}),
    ...(formFields !== undefined ? { formFields } : {}),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/** DSL form-field types that map to an Operaton `operaton:formField`. */
const FORM_FIELD_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'date',
]);

/**
 * Map the fields of an element's `form { … }` block(s) into IR
 * {@link FormField}s, or `undefined` when the element declares no fields.
 *
 * The grammar allows a `form` block on any element and permits every
 * {@link VarType}; the validator restricts it to `start`/`user` with the four
 * form-compatible types before this runs. Multiple blocks are flattened
 * defensively — the validator flags a second block as a duplicate.
 */
function lowerFormFields(
  node: AstStartEvent | AstUserTask,
): FormField[] | undefined {
  const fields = node.forms.flatMap((f) => f.fields);
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map((f) => ({
    id: f.id,
    type: toFormFieldType(f.type),
    ...(f.label !== undefined ? { label: f.label } : {}),
    ...(f.defaultValue !== undefined
      ? { defaultValue: renderFormDefault(f.defaultValue) }
      : {}),
  }));
}

/**
 * Narrow a {@link VarType} to a {@link FormFieldType}. `json`/`any` have no form
 * representation and are rejected by the validator; reaching one here is an
 * internal invariant violation.
 */
function toFormFieldType(type: string): FormFieldType {
  if (FORM_FIELD_TYPES.has(type)) {
    return type as FormFieldType;
  }
  throw new Error(
    `astToIr: unsupported form field type '${type}' (expected string, number, boolean, or date).`,
  );
}

/**
 * Render a form field's default-value expression to the plain text the
 * `operaton:formField` `defaultValue` attribute carries. Literals yield their
 * bare value; any other expression falls back to its `${…}` body (Operaton
 * evaluates it as EL).
 */
function renderFormDefault(expr: Expr): string {
  if (isLiteralString(expr)) {
    return expr.value;
  }
  if (isLiteralBool(expr)) {
    return expr.value;
  }
  if (isLiteralInt(expr) || isLiteralDecimal(expr)) {
    return String(expr.value);
  }
  return renderExpression(expr);
}

/**
 * Lower a `service` task, reading whichever of `class` / `expression` /
 * `delegate` is present to build the matching {@link ServiceTaskBinding}
 * variant (see {@link serviceTaskBinding}).
 */
function lowerServiceTask(builder: Builder, stmt: AstServiceTask): Frontier {
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    binding: serviceTaskBinding(stmt.attrs),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Build a `service` task's {@link ServiceTaskBinding} from whichever binding
 * key is present.
 *
 * `class` is a bareword path ({@link attrValue}'s bareword handling strips the
 * `${…}` wrapper down to `com.example.X`, correct for a plain Java class
 * path). `expression` and `delegate` are JUEL EL text — most commonly a quoted
 * `"${…}"` raw template, but the grammar also accepts an unquoted value (a
 * bareword or dotted `VarRef`) — and must keep the `${…}` wrapper verbatim
 * either way, since that text is exactly the `operaton:expression` /
 * `operaton:delegateExpression` attribute value Operaton evaluates as EL, not
 * a literal string. They are read via {@link rawExpressionAttrValue}, not
 * `attrValue`, so a bareword is wrapped rather than stripped. `delegate` is
 * the friendly DSL alias for `delegateExpression`.
 *
 * Exactly one binding key is expected on a valid program (the validator
 * enforces this); when none is present the desugarer stays total by falling
 * back to an empty `class` binding rather than throwing.
 */
function serviceTaskBinding(attrs: Attribute[]): ServiceTaskBinding {
  const className = attrValue(attrs, 'class');
  if (className !== undefined) {
    return { kind: 'class', className };
  }
  const expression = rawExpressionAttrValue(attrs, 'expression');
  if (expression !== undefined) {
    return { kind: 'expression', expression };
  }
  const delegate = rawExpressionAttrValue(attrs, 'delegate');
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }
  return { kind: 'class', className: '' };
}

/**
 * Lower an `external` task to a `serviceTask` IR node carrying an `external`
 * binding. Modelled as a serviceTask binding variant, not its own IR kind, so
 * it emits/imports as a `bpmn:serviceTask` with `operaton:type="external"`.
 * `topic` is a plain string-literal attribute.
 */
function lowerExternalTask(builder: Builder, stmt: AstExternalTask): Frontier {
  const topic = attrValue(stmt.attrs, 'topic') ?? '';
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    binding: { kind: 'external', topic },
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Fence-tag aliases and the canonical Operaton `scriptFormat` they normalize
 * to. The IR and XML carry the canonical value; the printer emits the
 * canonical tag, so a round-trip normalizes an alias like `js` to
 * `javascript`.
 */
const SCRIPT_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  javascript: 'javascript',
  groovy: 'groovy',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  feel: 'feel',
};

/**
 * Split a raw `FENCED_SCRIPT` token (the whole ```` ```<tag>\n…\n``` ````
 * block, captured verbatim by the grammar) into its language tag and inner
 * code body.
 *
 * The tag is the maximal run of ASCII letters immediately following the
 * opening fence. A single line terminator directly after the tag — `\r\n` or
 * `\n`, the delimiter separating the tag line from the body — is dropped;
 * nothing else is touched, so indentation and trailing newlines inside the
 * body survive verbatim. A fence with no such line terminator (e.g. a
 * same-line ` ```jsfoo``` `) has no distinguishable tag/body split: the whole
 * letter run becomes the tag and the body is empty.
 */
function splitFencedScript(raw: string): { tag: string; code: string } {
  const inner = raw.slice(3, -3); // strip the opening/closing ``` delimiters
  const tag = /^[a-zA-Z]+/.exec(inner)?.[0] ?? '';
  const rest = inner.slice(tag.length);
  const code = rest.startsWith('\r\n')
    ? rest.slice(2)
    : rest.startsWith('\n')
      ? rest.slice(1)
      : rest;
  return { tag, code };
}

/**
 * Lower a `script` task: split the fenced body into its language tag and
 * inner code (see {@link splitFencedScript}), map the tag to the canonical
 * Operaton `scriptFormat` via {@link SCRIPT_FORMAT_ALIASES}. An unrecognized
 * tag is carried through as-is rather than rejected here — the validator (a
 * later stage) rejects an unsupported tag before it reaches a bad IR.
 */
function lowerScriptTask(builder: Builder, stmt: AstScriptTask): Frontier {
  const { tag, code } = splitFencedScript(stmt.body);
  builder.flowElements.push({
    kind: 'scriptTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    format: SCRIPT_FORMAT_ALIASES[tag] ?? tag,
    code,
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
 * - When an `else` is present and every branch (every conditioned branch plus
 *   the else) terminates, the join ends up with zero incoming flows — nothing
 *   ever reaches it — so it is pruned (see {@link pruneUnreachableJoin}) and
 *   the construct reports `exit: null`, exactly like an explicit `end`. An
 *   `if` without an `else` can never reach this: its implicit fall-through
 *   always wires an unconditioned split→join flow.
 *
 * Entry is the split gateway; exit is the join gateway, or `null` when pruned.
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

  return { entry: splitId, exit: pruneUnreachableJoin(builder, joinId) };
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
 * Entry is the fork; exit is the join — or `null` when every branch
 * terminates and the join is left with zero incoming flows, in which case it
 * is pruned (see {@link pruneUnreachableJoin}).
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

  return { entry: forkId, exit: pruneUnreachableJoin(builder, joinId) };
}

/**
 * Lower a `subprocess` into a nested {@link SubProcess} flow container.
 *
 * A sub-process is a single-block compound statement: its body is lowered into
 * a **nested builder** with its own `flowElements`/`sequenceFlows` arrays but
 * the **same `taken` set** as the parent, so every synthesised id stays
 * document-unique across the whole process (BPMN `id` is an XML ID). The body's
 * enclosing-block coordinate is the sub-process's own structural coordinate
 * `<X>` (the sole-block rule loop bodies already follow), so gateways inside
 * the body come out positional — `Gateway_<X>_<i>_…` — and never collide with a
 * gateway elsewhere in the document. Implicit start/end inside the body are
 * seeded from the sub-process **name** (`StartEvent_<name>` / `EndEvent_<name>`,
 * mirroring the top level, which seeds from the process id).
 *
 * The finished container is pushed onto the **parent** builder as one opaque
 * activity node: an incoming flow targets it by id and a fall-through flow
 * leaves it by id, so `entry === exit === name`. An empty or handler-only body
 * still needs a valid start event, so it gets the same bare start → end pair
 * a bodyless process body does.
 */
function lowerSubProcess(
  builder: Builder,
  stmt: AstSubProcess,
  x: string,
): Frontier {
  const nested: Builder = {
    flowElements: [],
    sequenceFlows: [],
    taken: builder.taken,
  };
  lowerContainerBody(nested, stmt.body.statements, x, stmt.name);

  builder.flowElements.push({
    kind: 'subProcess',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
  });
  return { entry: stmt.name, exit: stmt.name };
}

// ---------------------------------------------------------------------------
// Event handlers, throws, and emits
// ---------------------------------------------------------------------------

/**
 * Lower an `on` handler into a `triggeredByEvent` {@link SubProcess} — an event
 * sub-process — pushed onto the **parent** container.
 *
 * A handler is a single-block compound, so its structural coordinate `<X>` is
 * `<coord>_<index>` and its id is `EventSubProcess_<X>`. Its body lowers through
 * the same container machinery every sub-process uses (a nested builder sharing
 * the one `taken` set), with the handler id as the implicit-event seed
 * (`StartEvent_<id>` / `EndEvent_<id>`) — the container-id rule.
 *
 * The caught trigger lands on the body's start event (explicit or synthesized):
 * `eventDefinition` from the trigger word, code, and catch bindings, plus
 * `isInterrupting: false` when the handler is marked `alongside`. Unlike a plain
 * sub-process an event sub-process is **not** wired into the parent's flow, so
 * this returns nothing and the caller keeps the sequence chain flowing around
 * it.
 *
 * An event sub-process is invalid BPMN without its trigger start event, so an
 * empty handler body still synthesizes start → flow → end (the same bare pair
 * every empty or handler-only flow container gets); `ensureHandlerStart` below
 * then attaches the trigger to it.
 */
function lowerOnHandler(
  builder: Builder,
  stmt: OnHandler,
  coord: string,
  index: number,
): void {
  const x = `${coord}_${index}`;
  const id = makeEventSubProcessId(x);

  const nested: Builder = {
    flowElements: [],
    sequenceFlows: [],
    taken: builder.taken,
  };
  lowerContainerBody(nested, stmt.body.statements, x, id);

  const start = ensureHandlerStart(nested, id);
  start.eventDefinition = handlerEventDefinition(stmt);
  if (stmt.alongside) {
    start.isInterrupting = false;
  }

  builder.flowElements.push({
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
  });
}

/**
 * Lower a hosted `on <Host>: <trigger>` handler into a boundary event **inline
 * in the host's own container** — the node itself plus its whole body, pushed
 * onto the very builder the host was lowered into.
 *
 * There is no wrapping container. The body's statements become siblings of the
 * main flow, so a `goto` crosses between the two in either direction and lands
 * as a plain sequence flow — which is the only way an escape chain can rejoin
 * the main flow at all. Nothing rejoins implicitly: the chain runs boundary →
 * body → its own end event, and where control goes after the catch is the
 * author's decision, written as a `goto`.
 *
 * The escape chain's implicit end is seeded from the **boundary event id**
 * (`EndEvent_<boundaryId>`) rather than from the container id, so the main
 * flow's own `EndEvent_<containerId>` keeps its number whatever handlers the
 * container carries, and the inline lowering needs no container id threaded
 * into it. An empty body still gets boundary → end: an escape path that leads
 * nowhere is not well-formed BPMN.
 *
 * Element order is a real constraint, not a cosmetic one: `bpmn-auto-layout`
 * positions an attached event from `attachedTo.di.bounds`, so the host shape
 * has to exist before the attacher is laid out. The boundary node is pushed
 * when the handler statement is reached, and a handler always follows its host
 * in the statement list, so the host always precedes it in `flowElements`.
 *
 * The trigger payload is built by the same {@link handlerEventDefinition} an
 * event sub-process uses — a caught error is a caught error wherever it is
 * caught. `alongside` stores `cancelActivity: false`, the non-interrupting
 * boundary; interrupting is the BPMN default and is left unwritten.
 *
 * @param hostId Id of the activity the event attaches to — the host reference's
 *   text, which is the host statement's authored name verbatim.
 */
function lowerBoundaryHandler(
  builder: Builder,
  stmt: OnHandler,
  hostId: string,
  coord: string,
  index: number,
): void {
  const id = makeBoundaryEventId(hostId, stmt.trigger, builder.taken);
  builder.flowElements.push({
    kind: 'boundaryEvent',
    id,
    attachedToRef: hostId,
    eventDefinition: handlerEventDefinition(stmt),
    ...(stmt.alongside ? { cancelActivity: false } : {}),
  });

  // A handler is a single-block compound, so its body's enclosing coordinate is
  // the handler's own `<X>` — the sole-block rule loop bodies follow.
  const body = lowerBlockStatements(
    builder,
    stmt.body.statements,
    `${coord}_${index}`,
  );
  if (body.entry !== null) {
    addFlow(builder, id, body.entry);
  }

  // Terminate the escape chain. An empty body has no entry at all, so the
  // boundary event itself is what falls through to the end.
  const exit = body.entry === null ? id : body.exit;
  if (exit !== null) {
    const endId = makeEndEventId(id, builder.taken);
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    // Honour a reserved exit-flow id the same way a container body does (a body
    // ending in a `while` hands down its loop's default-exit flow id).
    addFlow(builder, exit, endId, undefined, body.exitFlowId);
  }
}

/**
 * Return the handler body's single start event — the trigger-carrying start.
 *
 * `lowerContainerBody` always leaves one behind (explicit, or synthesized,
 * including the bare start → end pair for an empty or handler-only body), so
 * this normally just finds and returns it; the synthesis below is a fallback
 * for the case that guarantee ever stops holding.
 */
function ensureHandlerStart(nested: Builder, id: string): IrStartEvent {
  const existing = nested.flowElements.find(
    (fe): fe is IrStartEvent => fe.kind === 'startEvent',
  );
  if (existing !== undefined) {
    return existing;
  }
  const startId = makeStartEventId(id, nested.taken);
  const endId = makeEndEventId(id, nested.taken);
  const start: IrStartEvent = { kind: 'startEvent', id: startId };
  nested.flowElements.push(start, { kind: 'endEvent', id: endId });
  addFlow(nested, startId, endId);
  return start;
}

/**
 * Build the caught {@link EventDefinition} for an `on` handler from its trigger
 * word, code, particle/time, condition, and catch bindings.
 *
 * The trigger word is a soft identifier validated in position, so the desugarer
 * stays total over any text — every branch below produces a well-formed
 * definition regardless of what else the handler carries, leaving word/shape
 * legality to the validator:
 *   - `escalation` — the escalation kind; carries a code and its `code` binding.
 *   - `compensation` — the payload-less undo-block kind, `{ kind: 'compensation'
 *     }`; a stray code, binding, or condition on the handler is ignored (there
 *     is nothing to bind). `alongside` still stamps `isInterrupting: false`,
 *     exactly as for every other trigger kind.
 *   - `message` — `{ kind: 'message', messageName: code ?? '' }`; bindings are
 *     ignored (a message has no catch bindings).
 *   - `signal` — `{ kind: 'signal', signalName: code ?? '' }`; bindings ignored.
 *   - `timer` — `{ kind: 'timer', timerKind, expression }`; `timerKind` comes
 *     from the particle via {@link timerParticleKind} and `expression` is the
 *     time text, falling back to `code` (the shape a bare `on timer "PT1H"`
 *     parses to when no particle is written) and then `''`.
 *   - `condition` — `{ kind: 'conditional', condition }`; the condition renders
 *     through `renderExpression` exactly like an `if`, or the total placeholder
 *     `${true}` when the handler carries none.
 *   - every other word (including a typo) — the error kind, exactly as before.
 *
 * A binding whose field is neither `code` nor `message` is ignored for the same
 * totality reason. A missing code is catch-all (the field is omitted).
 * Escalations carry a code but no message, so a `message` binding on an
 * escalation handler is dropped.
 */
function handlerEventDefinition(stmt: OnHandler): EventDefinition {
  if (stmt.trigger === 'escalation') {
    const codeVariable = bindingVariable(stmt, 'code');
    return {
      kind: 'escalation',
      ...(stmt.code !== undefined ? { escalationCode: stmt.code } : {}),
      ...(codeVariable !== undefined ? { codeVariable } : {}),
    };
  }
  if (stmt.trigger === 'compensation') {
    return { kind: 'compensation' };
  }
  if (stmt.trigger === 'message') {
    return { kind: 'message', messageName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'signal') {
    return { kind: 'signal', signalName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'timer') {
    return {
      kind: 'timer',
      timerKind: timerParticleKind(stmt.particle),
      expression: stmt.time ?? stmt.code ?? '',
    };
  }
  if (stmt.trigger === 'condition') {
    return {
      kind: 'conditional',
      condition:
        stmt.condition !== undefined
          ? renderExpression(stmt.condition)
          : '${true}',
    };
  }
  const codeVariable = bindingVariable(stmt, 'code');
  const messageVariable = bindingVariable(stmt, 'message');
  return {
    kind: 'error',
    ...(stmt.code !== undefined ? { errorCode: stmt.code } : {}),
    ...(codeVariable !== undefined ? { codeVariable } : {}),
    ...(messageVariable !== undefined ? { messageVariable } : {}),
  };
}

/**
 * Map an `on timer` particle word (`after` / `at` / `every`) to the BPMN
 * `timerKind` it selects. Total over any other word (a missing particle, or an
 * unrecognized one) by falling back to `duration` — the same fallback a bare
 * `on timer "PT1H"` (no particle at all) needs to lower sensibly.
 */
function timerParticleKind(
  particle: string | undefined,
): 'duration' | 'date' | 'cycle' {
  if (particle === 'at') {
    return 'date';
  }
  if (particle === 'every') {
    return 'cycle';
  }
  return 'duration';
}

/**
 * Resolve the process variable a handler binds for a given catch field
 * (`code` / `message`), or `undefined` when the handler declares no such
 * binding. A binding with an unrecognized field is never matched, so it is
 * silently ignored — word legality is the validator's job.
 */
function bindingVariable(stmt: OnHandler, field: string): string | undefined {
  return stmt.bindings.find((b) => b.field === field)?.variable;
}

/**
 * Lower a `throw` to a typed end event — the terminal frontier, exactly like an
 * explicit `end`. Its exit is `null`: `throw` always ends this path (like every
 * programming language), so no fall-through flow reaches the next statement.
 *
 * The id is the authored `name` when present, else the positional
 * `Throw_<coord>_<index>`. `escalation` maps to the escalation kind, `signal`
 * to the signal kind; any other trigger word lowers as `error` (totality — the
 * validator polices the word).
 */
function lowerThrow(
  builder: Builder,
  stmt: ThrowStatement,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'endEvent',
    id,
    eventDefinition: throwEventDefinition(stmt),
  });
  return { entry: id, exit: null };
}

/**
 * Lower an `emit` to an intermediate throw event — a plain fall-through node:
 * `emit` fires the event and keeps going, so entry === exit === the node's id.
 *
 * The id is the authored `name` when present, else the positional
 * `Throw_<coord>_<index>`. `signal` maps to the signal kind; `compensation`
 * maps to the payload-less compensation kind (a stray code string is
 * ignored — there is nothing to carry it); every other trigger word
 * (including a typo) lowers as an escalation regardless: BPMN has no
 * intermediate error throw, so `emit error` (and any other word) lowers as an
 * escalation and the validator teaches `throw error` instead.
 */
function lowerEmit(
  builder: Builder,
  stmt: EmitStatement,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'intermediateThrowEvent',
    id,
    eventDefinition:
      stmt.trigger === 'signal'
        ? { kind: 'signal', signalName: stmt.code ?? '' }
        : stmt.trigger === 'compensation'
          ? { kind: 'compensation' }
          : { kind: 'escalation', escalationCode: stmt.code },
  });
  return { entry: id, exit: id };
}

/**
 * Lower an `await` to an intermediate catch event — a plain fall-through node
 * on the main flow, exactly like {@link lowerEmit}'s intermediate throw,
 * except it waits for the trigger instead of firing it: entry === exit === the
 * node's id. The surface carries no name slot (a trial `name=ID` slot
 * collided with the timer particle at the token level), so the id is always
 * the positional `Catch_<coord>_<index>` — there is no authored-id branch to
 * mirror from `lowerEmit`.
 */
function lowerIntermediateCatch(
  builder: Builder,
  stmt: IntermediateCatchEvent,
  coord: string,
  index: number,
): Frontier {
  const id = makeIntermediateCatchEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'intermediateCatchEvent',
    id,
    eventDefinition: catchEventDefinition(stmt),
  });
  return { entry: id, exit: id };
}

/**
 * Build the thrown {@link EventDefinition} for a `throw`: `escalation` maps to
 * the escalation kind, `compensation` to the payload-less compensation kind,
 * `signal` to the signal kind, every other trigger word (including a typo) to
 * `error`. The code is optional at the grammar level (compensation — the undo
 * block — never carries one, so no fallback is needed for that arm), so
 * `signalName` falls back to `''` the same way `handlerEventDefinition` does
 * above; the empty name is only reachable for validator-rejected programs. A
 * stray code string on `throw compensation` is ignored (there is nothing to
 * carry it).
 */
function throwEventDefinition(stmt: ThrowStatement): EventDefinition {
  if (stmt.trigger === 'escalation') {
    return { kind: 'escalation', escalationCode: stmt.code };
  }
  if (stmt.trigger === 'compensation') {
    return { kind: 'compensation' };
  }
  if (stmt.trigger === 'signal') {
    return { kind: 'signal', signalName: stmt.code ?? '' };
  }
  return { kind: 'error', errorCode: stmt.code };
}

/**
 * Build the caught {@link EventDefinition} for an `await`: `message`/`signal`
 * map to their named catch kinds (name falling back to `''`, mirroring
 * `handlerEventDefinition`); `timer` combines the particle-derived
 * `timerKind` ({@link timerParticleKind}) with the time text, falling back to
 * `code` and then `''`; `condition` renders through `renderExpression`
 * exactly like an `if`, or the total placeholder `${true}` when the catch
 * carries none. The catch's `eventDefinition` field is narrowed to these four
 * kinds — an error/escalation/compensation catch is unrepresentable (they are
 * raised with `throw`/`emit`, never awaited inline) — so any other trigger
 * word (a validator-rejected program) also falls back to the always-true
 * conditional catch: total over any input without ever producing an
 * unrepresentable kind. The catch has no bindings to read, so this does not
 * route through `handlerEventDefinition`.
 */
function catchEventDefinition(
  stmt: IntermediateCatchEvent,
): Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
> {
  if (stmt.trigger === 'message') {
    return { kind: 'message', messageName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'signal') {
    return { kind: 'signal', signalName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'timer') {
    return {
      kind: 'timer',
      timerKind: timerParticleKind(stmt.particle),
      expression: stmt.time ?? stmt.code ?? '',
    };
  }
  if (stmt.trigger === 'condition') {
    return {
      kind: 'conditional',
      condition:
        stmt.condition !== undefined
          ? renderExpression(stmt.condition)
          : '${true}',
    };
  }
  return { kind: 'conditional', condition: '${true}' };
}

/**
 * Lower a `call` statement to a {@link CallActivity} leaf node.
 *
 * A call activity is a plain named step, not a compound: it contributes no
 * gateway and no nested container, so its frontier is the trivial
 * `entry === exit === stmt.name`, exactly like a `user`/`service` task.
 * `builder` is whichever container the caller is currently lowering into
 * (the process body, or a nested sub-process builder), so a call written
 * inside a `subprocess` body lands in that nested container automatically —
 * the same mechanism every other leaf statement already relies on.
 *
 * `calledElement` falls back to the empty string when the `process` attribute
 * is absent, keeping the desugarer total over a program the validator will
 * reject. `binding`/`businessKey`/`inMappings`/`outMappings` are omitted
 * entirely when not applicable, per the file's spread-conditional house style.
 */
function lowerCallActivity(builder: Builder, stmt: AstCallActivity): Frontier {
  const calledElement = attrValue(stmt.attrs, 'process') ?? '';
  const binding = callActivityBinding(stmt.attrs);
  const businessKey = rawExpressionAttrValue(stmt.attrs, 'businessKey');
  const { inMappings, outMappings } = lowerCallMappings(stmt.mappings);

  builder.flowElements.push({
    kind: 'callActivity',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    calledElement,
    ...(binding !== undefined ? { binding } : {}),
    ...(businessKey !== undefined ? { businessKey } : {}),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Derive a call activity's version-resolution {@link CalledElementBinding}
 * from its `binding`/`version` attributes — the exact inverse of
 * `renderCallActivity` in `ir-to-dsl.ts`.
 *
 * `version` wins whenever present, even alongside a stray `binding` attribute:
 * the two keys together are a validator error (not this function's job to
 * flag), so the desugarer just picks the one BPMN can actually use. Absent a
 * `version`, a `binding` attribute resolves only when it is a bare `latest` or
 * `deployment` identifier; any other bareword (or a quoted value, which the
 * grammar also accepts here) is not a resolvable strategy, so the binding
 * comes back absent rather than guessing — again, the validator's job to
 * flag.
 */
function callActivityBinding(
  attrs: Attribute[],
): CalledElementBinding | undefined {
  const versionAttr = attrs.find((a) => a.key === 'version');
  if (versionAttr !== undefined) {
    return { kind: 'version', version: callVersionValue(versionAttr.value) };
  }
  const bindingAttr = attrs.find((a) => a.key === 'binding');
  if (
    bindingAttr !== undefined &&
    isVarRef(bindingAttr.value) &&
    bindingAttr.value.accessors.length === 0
  ) {
    if (bindingAttr.value.name === 'latest') {
      return { kind: 'latest' };
    }
    if (bindingAttr.value.name === 'deployment') {
      return { kind: 'deployment' };
    }
  }
  return undefined;
}

/**
 * Read a call activity's `version` attribute value into the plain string the
 * IR's `version` binding carries: an int/decimal literal renders as its bare
 * digits, a string literal as its bare text, and anything else (a raw
 * `${…}` template, a bareword variable reference, …) through
 * {@link renderExpression} — so `version = "${v}"` keeps its `${…}` body
 * verbatim.
 */
function callVersionValue(expr: Expr): string {
  if (isLiteralInt(expr) || isLiteralDecimal(expr)) {
    return String(expr.value);
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return renderExpression(expr);
}

/**
 * Partition a call activity's mappings into `inMappings`/`outMappings` by
 * `direction`, preserving each direction's relative source order.
 */
function lowerCallMappings(mappings: VariableMapping[]): {
  inMappings: CallVariableMapping[];
  outMappings: CallVariableMapping[];
} {
  const inMappings: CallVariableMapping[] = [];
  const outMappings: CallVariableMapping[] = [];
  for (const mapping of mappings) {
    const lowered = lowerCallMapping(mapping);
    (mapping.direction === 'in' ? inMappings : outMappings).push(lowered);
  }
  return { inMappings, outMappings };
}

/**
 * Lower one `in`/`out` mapping entry to a {@link CallVariableMapping}.
 *
 * - `all` (`*`) copies every variable.
 * - A bare `target` with no `source` is the same-name shorthand: `source`
 *   defaults to `target`.
 * - A `source` that is a plain single-segment variable reference (no dotted/
 *   indexed accessors — the grammar's `VarRef` with an empty `accessors`
 *   list) copies that one variable by name.
 * - Any other `source` expression (a dotted accessor, an operator, a literal,
 *   …) is a computed value: it renders through {@link renderExpression} into
 *   the `${…}` body the IR's `expression` variant carries.
 *
 * `local` is stamped only when the mapping's `local` modifier is set — an
 * absent `local` is the non-local default, so the IR never carries `local:
 * false`.
 */
function lowerCallMapping(mapping: VariableMapping): CallVariableMapping {
  const local = mapping.local ? ({ local: true } as const) : {};
  if (mapping.all) {
    return { kind: 'all', ...local };
  }
  const target = mapping.target ?? '';
  if (mapping.source === undefined) {
    // Same-name shorthand: `in orderId` copies the variable `orderId`.
    return { kind: 'variable', source: target, target, ...local };
  }
  if (isVarRef(mapping.source) && mapping.source.accessors.length === 0) {
    return { kind: 'variable', source: mapping.source.name, target, ...local };
  }
  return {
    kind: 'expression',
    sourceExpression: renderExpression(mapping.source),
    target,
    ...local,
  };
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
 * from the preceding statement lands directly on the target as a raw flow.
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
 * After every branch of an `if`-with-`else` or a `parallel` has been lowered,
 * decide whether the synthesized join gateway `joinId` still has anything
 * flowing into it. It does whenever at least one branch is empty (routed
 * straight through by its caller) or falls through ({@link joinContinuation}
 * wired its exit into the join); it does not when every branch terminates
 * (`end`/`throw`/`goto`, or a nested compound that itself never falls
 * through). A join with zero incoming flows is invalid BPMN, so this removes
 * the join {@link FlowElement} that was pushed for it — never an authored
 * node, only the gateway `lowerIf`/`lowerParallel` synthesized — and reports
 * no exit, exactly like a branch ending in an explicit `end`.
 *
 * @returns `joinId` when it stays reachable, or `null` once pruned.
 */
function pruneUnreachableJoin(builder: Builder, joinId: string): string | null {
  if (builder.sequenceFlows.some((flow) => flow.targetRef === joinId)) {
    return joinId;
  }
  const index = builder.flowElements.findIndex((fe) => fe.id === joinId);
  if (index !== -1) {
    builder.flowElements.splice(index, 1);
  }
  return null;
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
        isServiceTask(stmt) ||
        isExternalTask(stmt) ||
        isScriptTask(stmt) ||
        isCallActivity(stmt)
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
      } else if (isSubProcess(stmt)) {
        // The sub-process name is itself a document id (a goto target); its body
        // is a nested container whose named steps share the one taken set.
        taken.add(stmt.name);
        visit(stmt.body.statements);
      } else if (isOnHandler(stmt)) {
        // The handler id is positional (collision-free, never registered), but
        // its body's named steps share the one document-wide taken set.
        visit(stmt.body.statements);
      } else if (isThrowStatement(stmt) || isEmitStatement(stmt)) {
        // An authored id on a throw/emit is used verbatim, so it is a document
        // id; an unnamed one gets a positional id that never needs reserving.
        if (stmt.name !== undefined) {
          taken.add(stmt.name);
        }
      }
      // GotoStatement contributes no new id (it references an existing one).
    }
  };
  visit(process.body);
  return taken;
}

/**
 * Resolve the value of a single attribute by key into the plain string the IR
 * carries for `assignee` / `formKey` / `class` / `topic`. NOT used for
 * `expression` / `delegate` — see {@link rawExpressionAttrValue}, which keeps
 * their `${…}` wrapper verbatim instead of stripping it.
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
 * Resolve the value of a single attribute by key into the `${…}` body text a
 * raw JUEL expression attribute (`expression` / `delegate`) carries verbatim.
 *
 * Unlike {@link attrValue}, this never strips the `${…}` wrapper: it renders
 * the attribute's value through {@link renderExpression} as-is, so a quoted
 * `"${…}"` raw template passes through unchanged and a bareword or dotted
 * `VarRef` (parsed the same way a `class` path is) is *wrapped* in `${…}`
 * rather than unwrapped — the correct behaviour for a field Operaton
 * evaluates as EL, not a literal string.
 *
 * Returns the value of the **first** matching attribute; duplicate-key
 * detection is the validator's job, not the desugarer's.
 */
function rawExpressionAttrValue(
  attrs: Attribute[],
  key: string,
): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : renderExpression(attr.value);
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
