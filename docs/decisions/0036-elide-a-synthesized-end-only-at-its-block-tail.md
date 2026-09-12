---
status: accepted
date: 2026-09-12
decision-makers: Marlon Kranz
---

# Elide a synthesized end only at its block tail

## Context and Problem Statement

The decompiler leaves out a plain end event whose id carries a synthesized prefix and holds nothing printable.
The argument was that the compiler mints one at the same position when the printed source is read back, so nothing is lost.
That argument lived in a code comment on `isElidedOnPrint` and nowhere else, and it is wrong by one word.
The compiler mints a synthesized end in two places, `lowerContainerBody` and `lowerBoundaryHandler`, and both put it at the tail of a block.
It never mints one inside a branch or loop body, whose exit it wires to the join or the loop head instead.
So "the same position" holds only where the elided end was that tail: at its block's own depth, with no flow statement of the same block printed after it.

The printer has several reasons to print a flow statement after such an end.
A second start's chain, an orphan chain such as a link catch's or one reached only by `goto`, and the final `goto` sweep all append to the same block.
Sequence flow is never written out, so the compiler wires the statement before the missing end into whatever follows it on the page.
The end's predecessor, which ended the process in the model, now continues into another chain.

The smallest source that shows it:

```bpmnscript
process p {
  error E
  var x: boolean
  start S
  step A
  if (x) {
    throw error Named(E)
  }
  step X
}
```

The compiler ends `X` in `EndEvent_p`.
Walking the guard, the printer wrote the then-branch as `goto Named`, then `step X`, left `EndEvent_p` out, and appended the orphan chain `throw error Named(E)` right after it.
Read back, `Flow_X_EndEvent_p` had become `Flow_X_Named`, and not one warning said so.
`X` ended the process in the model and threw in the document that came back.
A modeller reaches the same shape without writing any of this: the `EndEvent_1` a modelling tool mints, drawn as the else-path of a guard whose then-branch throws, is the repro's model.
Seven shapes lose a terminal this way.
Five of them hold one start: the repro, a tool-minted end as a guard's else-path or as its then-branch, two branches each to its own end, and a race whose branches each end.
The other two hold several: two starts each with its own end, and one chain holding both an elided start and an elided end.
ADR-0034 made those two loud, since a start after a live chain is now an error; the five with one start reported nothing.
What should the printer do with a plain synthesized end it cannot leave out without rewiring its chain?

## Decision Drivers

- The page says what the graph does.
  Steps run top to bottom and the flow between them is never written out, so a statement missing from the page is a flow the reader cannot see.
- The honest import contract (ADR-0014): what the round trip cannot carry is reported, never dropped without a word.
- No change to the printed form of an existing document.
  Every synthesized plain end in the golden pairs under `tests/golden/` sits at a container or boundary tail.
- One mechanism rather than two.
  ADR-0034 already prints a second plain start under its reserved id and reports it, and the same shape serves an end.
- The reserved-name error (ADR-0010) as the channel that names the fix: the validator's message on the printed line tells the reader which element to rename.

## Considered Options

- Print the end under its reserved id wherever it is not its block's tail, with the existing `refusedStatement` report
- Inline an authored terminal in a guard clause when the split's route is its only incoming flow, in `branchStaysInRegion`
- Defer the chain holding the elided end to the last position in its block

## Decision Outcome

Chosen: print the end under its reserved id wherever it is not its block's tail, because it closes every shape with the mechanism ADR-0034 already established and moves no golden.

`isElidedOnPrint` stays the model-level predicate and keeps answering "the printer may drop this end".
`warnRefusedStatements`, `forwardToRealTarget` and the importer's `warnElidedNamedDrop` read that answer and keep their meaning.
Whether the printer does drop the end is a fact about print order, known only once every chain of the block is on the page, so that half of the decision moves into the emitter.
Inside a nested body, `emitNode` prints the end at once and reports it.
The compiler wires such a body to its join or loop head and mints no end there, so there is nothing to re-derive one from.
At the top level, `emitNode` records the end with the position it would have printed at and pushes nothing.
Once the block's passes have run, `Emitter.emit` walks those records.
An end nothing followed was the tail and stays out.
Any other is spliced back at its position and reported under the `refusedStatement` category, one report per printed end, in page order.
A boundary handler body is one chain in an array of its own, so its end always sits at that array's end and stays elided, which is the implicit end ADR-0019 describes.
The printed source draws exactly one validator error, on the printed `end` line, and nothing else.
Renaming the id in the model makes the source clean and round-trips the document structurally unchanged.

The import warning on a labelled plain end changes with it.
The importer cannot know which position the printer will give an end, so its message now describes both outcomes.
Where the script can do without the end, it is left out and its label with it; anywhere else it prints under a name the script refuses.
Either way the fix it names is a rename in the diagram.
The message for a start was exact and does not change.

### Consequences

- Good, because all seven shapes close, five of them going from an unreported rewrite to a refused source.
- Good, because no golden's printed form changes, so a document decompiled before this decision decompiles to the same text after it.
- Good, because the shape the reader meets is the one ADR-0034 already taught for a second plain start.
  The reader finds a reserved id on the page, a print warning, and a validator error naming the element to rename.
- Bad, because a modeller's document with a default-named plain end that is not last now prints a reserved id and is refused until renamed, where before it printed clean and ran differently.
- Bad, because the import-side label warning can no longer say what happens to the label, only the two things that can.
- Neutral, because a jump into such an end is still dropped and marked (ADR-0009).
  `forwardToRealTarget` reads the model-level answer, and at the top level the jump is printed before the end's position is known.
  For a plain end in the same container the re-derived tail end is the same terminal, so the process runs the same and the marker is the only cost.
- Neutral, because inlining an authored terminal in a guard clause landed as a change of its own, printing `event-handlers` and `transactions` inline instead of as `goto` plus a trailing statement.

### Confirmation

The table `irToDsl: a synthesized plain end that is not its block's tail` in `packages/transform/test/ir-to-dsl.test.ts` holds four rows.
The guard shape is resolved by inlining the terminal, which the first row shows: `a guard's throw with a single incoming flow inlines, so its tail end stays elided rather than deferred`.
The other three rows pin the deferral: `a plain end whose chain a later goto-reached step follows prints before that step, and its label rides along`, `a plain end inside a branch prints at once, so the branch does not fall through`, and `of three chains each ending in its own plain end, the first two print in place and the last stays elided`.
Every row asserts the whole printed source and the whole report list, re-validates the source with the reserved-id error alone, and re-desugars it to the same graph up to id normalization.
Every round-trip suite under `tests/` validates the source printed from its golden with zero error diagnostics, and none of them changed, which is the proof that no golden's printed form moved.
The documentation row `a start and an end whose ids this tool writes for itself carry it and report that no script can spell it back` in `packages/transform/test/xml-to-ir.test.ts` pins the import warning's wording.

## Pros and Cons of the Options

### Print the end under its reserved id wherever it is not its block's tail

- Good, because it covers every shape: the position test does not care why a statement followed the end.
- Good, because the printed source is refused with one error that names the line, and the fix is a rename in the model.
- Good, because the goldens keep their printed form.
- Bad, because a modeller's document that used to print clean is now refused until renamed.
- Bad, because "tail" is decidable only after the block's passes, so the emitter carries a deferred list and a resolve step that a reader has to find.

### Inline an authored terminal in a guard clause

Extend `branchStaysInRegion` so a branch entry that terminates before the join, and whose only incoming flow is the split's route, prints inside the branch whether or not its id is synthesized.

- Good, because it fixes the guard shape at its root: the throw prints inside the `if`, the end after it is the tail again, and nothing is deferred.
- Good, because two goldens, `event-handlers` and `transactions`, would print closer to their authored sources.
- Bad, because it fixes two of the seven shapes and none of the others: a guard is not what puts a second start's chain or a race branch after the end.
- Bad, because it changes printed output for documents people already have.

### Defer the chain holding the elided end to the last position in its block

- Bad, because it conflicts with the elided-start-first rule of ADR-0034 whenever one chain holds both an elided start and an elided end.
- Bad, because with several elided ends only one chain can be last.
- Bad, because printing the end in place covers every shape this would, so it is dominated.

## More Information

Amends ADR-0014, whose warned-construct list said the statement carrying a synthesized start's or end's label is left out whole; that holds for a start, and for an end only at its block's tail.

Related decisions: ADR-0009 (the dropped-jump rule this decision leaves in place).
ADR-0010 (the reserved-name error that names the fix, and the consequence bullet this decision makes precise).
ADR-0019 (the boundary body whose end stays elided).
ADR-0034 (the elided-start-first rule this decision composes with, and the second-plain-start shape it reuses).
