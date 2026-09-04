---
status: accepted
date: 2026-07-24
decision-makers: Marlon Kranz
---

# Intermediate Catch Events: the `await` Keyword, a Synthesized Id, and a Four-Trigger Scope

## Context and Problem Statement

BPMNscript has two ways to react to a trigger so far.
An `on` handler (ADR-0016) is a racing scope guard: it compiles to an event sub-process that competes with the whole container it guards, firing only if its trigger arrives before the container finishes.
`throw`/`emit` (ADR-0016, ADR-0017) go the other way, making the current path fire a trigger outward, ending or continuing depending on the verb.
Neither shape covers a third one BPMN itself has: `bpmn:intermediateCatchEvent`, a node sitting directly on the main sequence flow where the token stops in place and stays stopped until the trigger fires, then carries on to whatever follows.
Nothing in this language lets an author write "pause here for a message" as a single step in a linear flow; the closest available shape, a hosted `on` handler, guards a whole activity rather than blocking one point in a sequence.

Adding that third shape raises the same three questions every earlier event-layer decision has had to answer for its own construct.
What word introduces it, given that the grammar's existing trigger words (`message`, `timer`, `signal`, `condition`, and the timer particles) are deliberately soft identifiers rather than keywords, so a new syntax slot cannot lean on token type to stay unambiguous, only on token position?
Whether the construct needs an author-chosen name at all, since a name is what a `goto` would target and this node has no body to jump back out of?
And which of BPMN's catchable event kinds this specific attachment point exposes, given that error, escalation, and compensation already have a home elsewhere in this language's model and a plain intermediate catch element is not where BPMN itself lets several of them live?

## Decision Drivers

- The grammar already commits every trigger word and every timer particle to being a soft identifier (ADR-0016), so any new rule sharing that vocabulary has to be checked against the same kind of token-level collision ADR-0019's colon separator had to resolve for boundary events.
  A plausible-looking rule is not enough; it has to be run through the parser generator and shown clean.
- The restructuring analysis (ADR-0009) and the round-trip id normalizer (ADR-0010) already have settled rules for what does and does not need special handling: only a node with no incoming edge needs virtual-entry wiring, and only a handful of node kinds get re-keyed on compare.
  A new construct should fit those existing rules rather than add exceptions to either one, if its own shape genuinely allows that.
- The payload surfaces for message, signal, timer, and conditional triggers are already built (ADR-0017) and reused by both `on` handlers and boundary events (ADR-0019).
  A third consumer of the same surfaces should cost one dispatch case per layer, not a second payload grammar.
- The honest import contract (ADR-0014) means an unsupported form on the wire has to be refused with a diagnostic that names what was refused, not silently dropped and not guessed into an approximation.

## Considered Options

For the keyword:

- `await`
- `wait`
- `receive`

For goto-target naming:

- No authored name at all, a synthesized id only
- An optional `name=ID` slot mirroring how a hosted `on` handler is named

For the trigger scope:

- Message, timer, signal, and conditional only
- The full set of BPMN event kinds this language already models somewhere, adding error, escalation, compensation, cancel, and link
- A different hand-picked subset

## Decision Outcome

Three decisions, chosen together for the same reason ADR-0016's and ADR-0019's each were: spend a new reserved word, a new syntax slot, or a wider trigger list only where the alternative genuinely loses something, whether grammar unambiguity, round-trip fidelity, or a meaning this language does not actually have, and reuse what already exists everywhere else.

The keyword is `await`.
Before committing to it, the rule was built into a live Langium parser with Chevrotain's self-analysis switched on (`createServicesForGrammar`), and the full trigger-payload battery was run through it.
Every form parsed with zero ambiguity warnings, including the case that actually matters: `await timer after "PT1H"`, three bare identifiers followed by a string, the same token shape `on timer after "PT1H"` already has, resolved to `trigger='timer'`, `particle='after'`, `time='PT1H'`, never confusing the particle for anything else.
`wait` and `receive` parse exactly as cleanly; the choice between the three is not a parsing question at all, and is settled on what each word actually says.
`receive` names precisely what a message catch does and nothing else: a signal is broadcast, not addressed to anyone to "receive"; a timer is not received from anywhere; a condition is evaluated, not delivered.
Using it across all four triggers would mislabel three of them.
`wait` reads as a generic pause, closer to a fixed delay than to a subscription that resolves when something happens, a fair description of the timer case and a poor one for a message or signal correlation.
`await` carries the meaning every one of the four cases actually shares: execution stops here until this specific thing resolves, then continues with whatever comes next, which is exactly what an intermediate catch event does at runtime and is the same word this audience already reads that way in mainstream asynchronous code.

Reserving `await` costs nothing existing code already pays for.
It collides with no trigger word or timer particle already in the grammar, and it appears as a bare identifier nowhere in the committed corpus.
Unlike `message` or `code`, words ADR-0016 keeps soft precisely because they are ordinary variable names this audience reaches for constantly, `await` is not a word a process author would otherwise want free.

No authored name; the id is synthesized.
A trial grammar carrying an optional `name=ID` slot ahead of the trigger, mirroring how a hosted `on` handler is named, was run through the same live-parser check and reintroduced the exact ambiguity ADR-0019's colon separator exists to avoid.
Chevrotain reported "Ambiguous Alternatives Detected inside IntermediateCatchEvent Rule", and the parser misread `await timer after "PT1H"` as `name='after', code='PT1H'`: the particle swallowed into the name slot, and with it the one piece of information that decides which of BPMN's three timer forms the author meant.
That is not a cosmetic misparse.
`after`, `at`, and `every` map to a duration, a fixed date, and a repeating cycle respectively, three different things the engine schedules, so losing which one was written is a scheduling error hiding behind a name field nobody asked the catch to have in the first place.

Dropping the name slot removes the ambiguity outright, and it costs the surface nothing a `goto` target ever needed: an intermediate catch has no body, so unlike a hosted `on` handler it never has to be an addressable jump-back point.
It also matches the one construct already shaped exactly like it.
`IntermediateThrowEvent`, `emit`'s compiled form, is a one-in/one-out, fall-through main-flow node with no name syntax of its own, and the catch is its topological twin, differing only in whether the token fires forward immediately or stops and waits.
The catch's id is `Catch_<coord>`, generated by `makeIntermediateCatchEventId` from the same structural-coordinate scheme (ADR-0010) `makeThrowEventId` already uses for `Throw_<coord>`, and `/^Catch_/` joins `RESERVED_ID_PATTERNS` so an author can never type a name that would collide with one.
Because there is no name syntax to print in the first place, the decompiler needs none of the reserved-prefix-omission handling a hosted `on` handler's printed name needs; omitting something that was never there is not a rule, it is the absence of one.

One consequence follows from having no name at all, and it is not new.
A hand-drawn diagram whose second edge or `goto` targets an intermediate catch's synthesized id runs into exactly the same wall every other synthesized, unnameable id already does on decompile: the printed source has nothing to write as the jump's target text, so the edge prints as the existing hand-repair marker rather than a resolvable `goto`.
This is the same invariant that already governs every `goto` the decompiler emits, that a jump target has to be something the grammar can actually spell, extended to one more node kind rather than a new mechanism built for this one.

The trigger scope is message, timer, signal, and conditional.
These are exactly the four shapes the shared `readCatchEventDefinition` helper already maps, the same function an `on` handler's start event and a boundary event's catch side both already read through, so admitting them to `await` costs one new dispatch case per layer, not new mapping logic.
They are also the only four kinds this language treats as something a token can genuinely wait on.
Error and escalation are always thrown by `throw`/`emit` and always reacted to by a racing `on` handler (ADR-0016); nothing about either one is a value a linear flow blocks on and then continues past, the way a message correlation or a timer's clock is.
Letting `await` also claim them would mean two independent constructs, a handler and an await, both plausibly "catching" the same trigger, with no rule for which one actually fires when it arrives.
Compensation has exactly one meaning in this language: the undo block a subprocess declares with `on compensation` (ADR-0018), invoked only by the engine's own compensation machinery, never something with an independent arrival a token waits for.
Cancel is excluded because BPMN gives it no position an `await` could occupy: a transaction sub-process's boundary catches one, and an end event inside that sub-process raises it.
ADR-0028 surfaces that container as the `attempt` block and admits both of those positions there, neither of them the pass-through step on the main flow an `await` compiles to.
Link is BPMN's own off-page connector, built for splitting one diagram across pages; this language's `goto` already does the job of naming a jump inside one textual source, so link would duplicate an existing mechanism for a diagramming problem a single `.bpmnscript` file never has.
A catch carrying more than one event definition, or `parallelMultiple="true"`, waiting on several triggers on one element at once, is a different modeling shape from the one-trigger-per-`await` grammar this rule commits to, and nothing in the surface's design calls for it.

On import, `bpmn:intermediateCatchEvent` moves from a blanket `UnsupportedElementError` to an honest refuse-or-map split, matching the contract ADR-0014 already sets for every other construct: the four supported kinds map through `readCatchEventDefinition` unchanged, and a link, error, escalation, compensation, or cancel definition, or more than one definition on the same element, is refused by name rather than silently dropped or approximated.
The XML schema itself does not stop a document from placing one of the excluded definitions on an intermediate catch element, so the refusal is a real check against real input a foreign tool or a hand-edited file can produce, not a defensive branch that never fires.

The catch's topology settles the two passes that would otherwise need new cases for it.
The restructuring analysis wires only start events and boundary events to its virtual entry (`buildGraph`, `cfg-analysis.ts`); every other flow element, including the existing intermediate throw, is an ordinary node reached by a normal incoming edge, and the catch is one more ordinary node of that kind, so it needs no dominance handling that is not already there.
The round-trip id normalizer re-keys only gateways, event sub-processes, and boundary events on compare; task and event ids, the catch's own `Catch_<coord>` among them, round-trip verbatim exactly like `Throw_<coord>` already does.
Both claims are confirmed by dedicated regression cases rather than left as an assumption the construct happens not to violate.

### Consequences

- Good, because the full payload battery parses with zero ambiguity warnings, so `await` reserves one word and touches no existing grammar rule's disambiguation.
- Good, because `await` names exactly the behavior all four supported triggers share, execution stops until this resolves, in a word this audience already reads that way, rather than a word accurate for one trigger and approximate for the other three.
- Good, because dropping the name slot removes the trial ambiguity outright and costs nothing a `goto` target ever needed, since the catch has no body to jump back out of.
- Good, because the catch is a topological twin of the intermediate throw, so forward emit, decompile, the restructuring analysis, and the round-trip normalizer all reuse existing machinery through one new dispatch case each, rather than new passes.
- Good, because the four-trigger scope matches `readCatchEventDefinition` exactly, so import gains an honest refusal for exactly the forms it cannot represent instead of either a blanket refusal or a silent drop.
- Bad, because an author can never give a specific `await` a name to `goto`.
  The only way to reach one is to write it inline where it belongs, and a hand-drawn diagram's stray edge into one prints as a hand-repair marker rather than a resolvable jump, the same limit every other unnameable synthesized id already carries.
- Bad, because error, escalation, compensation, and cancel stay permanently unreachable from `await` even on a hand-crafted document where the shape looks unremarkable to a reader who does not already know BPMN restricts a plain intermediate catch element to a smaller set of event kinds than a boundary event or an event sub-process's start accepts.

### Confirmation

`packages/language/test/parsing.test.ts` pins the `await` disambiguation directly: each of `await message "..."`, `await timer after/at/every "..."`, `await signal "..."`, and `await condition (...)` parses to the field shape its trigger implies, with the timer case pinning that the particle survives as `particle`, not swallowed into a name.
A soft-word survival pin confirms `var await` fails to parse, proving the reservation, while `var message: string` and a step named `every` still parse clean.
`packages/language/test/validating.test.ts` pins the four-trigger acceptance and each trigger's missing payload, alongside the rejection of `await error`, `await escalation`, and `await compensation`, matched on the substrings that name the four legal words and the shape each of those kinds takes instead.
`await cancel` is refused there too, matched against its whole message, which points at the `end <name> cancel` that gives an `attempt` block up and the `on <block>: cancel` that catches it.
The refusal of an unknown word after `await` is matched whole as well, so the four accepted kinds and the place each refused kind is written instead are fixed in one string.
`packages/transform/test/ast-to-ir.test.ts` pins the four lowering cases and that two catches in one body receive distinct `Catch_<coord>` ids.
`packages/transform/test/ir-to-xml.test.ts` pins the four emitted `*EventDefinition` shapes and that no `name` attribute is stamped on the element.
`packages/transform/test/xml-to-ir.test.ts` pins the four mapped shapes and the refusal of an unsupported trigger, of multiple definitions on one element, and of conditional narrowing attributes inherited from ADR-0017.
`packages/transform/test/ir-to-dsl.test.ts` pins the four decompiled render lines, each with no `Catch_` token in the output.
`packages/transform/test/cfg-analysis.test.ts` pins the CFG no-op as an explicit regression case: a catch on the main flow gets a normal immediate dominator, never the virtual entry.
`packages/transform/test/synthesize-ids.test.ts` pins the id template and its reserved-pattern match.
The frozen `tests/golden/intermediate-catch.bpmn` fixture and `tests/intermediate-catch.round-trip.test.ts` exercise all four triggers together across a full DSL -> XML -> IR -> DSL cycle, asserting both IR idempotence and that the decompiled source recompiles with zero validation errors.
A Docker-gated end-to-end test deploys an example awaiting a message mid-flow, correlates it over REST, and proves the instance was genuinely waiting before correlation and reaches completion after, the one property none of the other layers can show on their own, since blocking is a runtime property rather than a compile-time one.

## Pros and Cons of the Options

### `await`

- Good, because it names the one behavior all four supported triggers share, not just the one it happens to fit best.
- Good, because it reserves a word that costs nothing existing code already relies on.
- Neutral, because it is one more reserved word alongside `on`, `throw`, `emit`, and `alongside`, a small, fixed set this language already keeps deliberately short.

### `wait`

- Good, because it parses exactly as unambiguously as `await`.
- Bad, because it reads closer to a fixed delay than to a subscription that resolves when something happens, a description that fits the timer case and undersells the other three.

### `receive`

- Good, because it names the message case precisely.
- Bad, because it is wrong for the other three: nothing is received from a timer, a signal is broadcast rather than addressed, and a condition is evaluated rather than delivered.

### An optional `name=ID` slot

- Good, because it would let an author give a catch an explicit `goto` target.
- Bad, because it reintroduces the exact ambiguity ADR-0019's colon separator exists to avoid: Chevrotain flags it directly, and the parser reads a timer's particle as a name, losing which of the three timer forms was meant.

### Every BPMN catchable trigger, including error, escalation, compensation, cancel, and link

- Good, because it would need no exclusion list and no refusal diagnostics for the excluded forms.
- Bad, because error, escalation, and compensation have no "something to wait for" meaning in this language's model.
  They are always thrown and always handled by a racing `on`, and letting `await` also claim them creates two constructs that both plausibly catch the same trigger, with no rule for which one runs.
- Bad, because BPMN admits no cancel on a plain intermediate catch at all, only on a transaction sub-process's boundary and on the end event that gives that sub-process up, and link duplicates a job `goto` already does for a diagramming problem a single text file never has.
  ADR-0028 surfaces that sub-process as the `attempt` block, where a cancel is written `end <name> cancel` inside the block and caught by `on <block>: cancel` beside it, positions no `await` on the main flow could have taken.

## More Information

Related decisions: ADR-0016 (soft trigger words and the `throw`/`emit` terminality rule, under which `await`'s own trigger and particle words stay soft identifiers, and from whose throw/handler split the reasoning that error and escalation are always thrown, never awaited, follows directly).
ADR-0017 (the payload surfaces for message, signal, timer, and conditional, all four of which `await` reuses verbatim, including the timer particle-to-definition mapping and the deferred conditional-narrowing refusal).
ADR-0018 (compensation as a subprocess undo block, the reason compensation gives an `await` nothing to wait for).
ADR-0019 (boundary events, the source of the live-parser ambiguity-check method this decision reuses twice, and the six-trigger boundary scope this decision's four-trigger catch scope deliberately does not match, since a boundary event's attachment and an intermediate catch's inline wait answer different questions about the same trigger vocabulary).
ADR-0014 (the honest import contract that `bpmn:intermediateCatchEvent` now follows instead of a blanket refusal).
ADR-0009 (the dominator-based restructuring analysis the catch needs no new entry-wiring case for, being an ordinary node reached by a normal incoming edge).
ADR-0010 (the structural-coordinate id scheme `Catch_<coord>` follows, and the re-keying rule that already excludes task and event ids, so the catch's id needs no new normalizer case either).

Extended by ADR-0028 (work that can be given up), which surfaces the transaction sub-process as the `attempt` block and gives cancel the two positions BPMN does allow it, leaving this decision's four-trigger scope where it stands: a cancel is written on the end that gives a block up and caught beside that block, never awaited.
