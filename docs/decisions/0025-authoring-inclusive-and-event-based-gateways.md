---
status: accepted
date: 2026-08-30
decision-makers: Marlon Kranz
---

# Inclusive and Event-Based Gateways: Conditioned `parallel` Branches, a Multi-Branch `await`, and No Gateway Label

## Context and Problem Statement

Every BPMN element the language has taken on so far had a construct to hang off.
`bpmn:inclusiveGateway` and `bpmn:eventBasedGateway` have nothing to attach to, because under ADR-0008 no author ever writes a gateway.
The desugarer synthesizes every gateway from block structure, and the decompiler elides every one it matches.
That elision is what makes the round trip idempotent, and the grammar states the premise in its own header (`packages/language/src/bpmn-script.langium:7-8`).
Both kinds are refused on import today (`packages/transform/src/xml-to-ir.ts:758`).

So the question is not which keyword spells "inclusive gateway".
It is whether block structure can express the intent well enough that the compiler still picks the element.
A gateway's `name` survives XML to IR to XML, then dies at the print hop, where no gateway has a statement form to carry it (`tests/helpers/normalize-ir.ts:65-67`).

## Decision Drivers

- ADR-0013 binds two rules: a keyword names what the user means rather than the BPMN element, and the compiler must not require what it can infer.
- Gateway elision is what ADR-0009's decompiler relies on for idempotence.
  A gateway with textual identity gains an authored id and stops round-tripping under ADR-0010's positional scheme.
- Operaton does not police the two kinds equally: an inclusive gateway gets no structural validation, an event-based gateway five separate restrictions.
- Trigger words are soft identifiers by design (ADR-0016), so a rule proves nothing until a live parser accepts it.
- ADR-0014's contract covers `xmlToIr` only, and `irToDsl` returns a bare `string` (`packages/transform/src/ir-to-dsl.ts:38`).
  A drop on the way out has no channel to be reported through.

## Considered Options

- For the inclusive split, conditioned `parallel` branches headed by `if` and `else`
- For the inclusive split, branches headed by a bare parenthesized condition
- For the inclusive split, a separate construct with its own reserved keyword
- For the fallback branch, the compiler routes the default flow to the join when no `else` is written
- For the fallback branch, a written `else` required whenever every other branch is conditioned
- For the race, a multi-branch `await` opened by a brace instead of a trigger word
- For the race, a distinct keyword such as `race`
- For the race's join, a synthesized exclusive join the block falls through
- For the race's join, self-contained branches that rejoin by `goto`
- For the gateway label, no slot, with the print-side drop reported through a warnings channel out of `irToDsl`
- For the gateway label, a slot on `if`, `while`, `parallel`, and the two new forms
- For the gateway label, no slot, and the drop stays silent
- A `gateway` keyword, or a flat node-and-edge escape hatch

## Decision Outcome

Both gateways stay fully synthesized and fully elided.
Nothing in the surface names a gateway, and ADR-0010's positional ids keep working unchanged.
Every form below parsed with zero ambiguity warnings in a live Langium parser with Chevrotain self-analysis on.

A branch of a `parallel` block may be headed by `if (condition)`, by `else`, or by nothing at all.
The compiler picks the element: no condition anywhere means `bpmn:parallelGateway`, and a condition on any branch means `bpmn:inclusiveGateway` on the fork and the join.

```
parallel {
  if (amount > 10000) { user Audit }
  { service RecordReceipt }
  else { user ManualTriage }
}
```

Operaton takes every non-default flow that has no condition or a true one (`InclusiveGatewayActivityBehavior.java:64-68`), and adds the default only when that set comes out empty (lines 71-83).
The default flow is always emitted and never asked for.
With an `else` it points at that branch; without one it goes straight to the join, the rule `lowerIf` already applies at the same position (`packages/transform/src/ast-to-ir.ts:594`).
That is a lowering rule rather than a validator rule because `parseInclusiveGateway` validates nothing (`BpmnParse.java:2105-2117`).
An all-conditional gateway without a default deploys, runs, then throws a stuck execution when nothing matches (`InclusiveGatewayActivityBehavior.java:71-75`).

The race is a multi-branch `await`.
`await` already means the token stops here until this resolves, and a race is that meaning over a set.

```
await {
  message "PaymentReceived" { service ShipOrder }
  timer after "P3D" { user ChaseCustomer }
}
```

A branch is a trigger header in the payload grammar `on` and `await` share, an optional settings block, then the body.
Two branches are the minimum, enforced by the grammar as `ParallelStatement` already does (`bpmn-script.langium:278-279`).
The triggers are the four `await` already takes, which is also everything Operaton accepts in this position (`BpmnParse.java:1549-1594`).
Reusing the word costs nothing, because `await {` cannot parse today (`bpmn-script.langium:380-383`).

The race falls through to a synthesized exclusive join, reusing `if`'s join and its pruning when every branch terminates (`ast-to-ir.ts:597`).
Operaton gives every catch event behind an event-based gateway the start behavior `CANCEL_EVENT_SCOPE` (`BpmnParse.java:1564-1566`), so exactly one branch of a race ever runs.

An inclusive pair reuses `Gateway_<X>_fork` and `Gateway_<X>_join` unchanged, since exactly one `parallel` statement sits at any structural coordinate.
The race adds one template, `Gateway_<X>_race`, whose segment word joins the reserved-name pattern.

Neither `if`, `while`, `parallel`, nor either new form gains a label slot, and the reason is structural.
One construct lowers to two gateways, so a single slot carries at most half of what an imported document may hold.
Instead `irToDsl` gains a warnings channel and reports the dropped label, along with everything else the print hop drops.
Its signature moves from `string` to a result carrying source and warnings, as ADR-0014 did to `xmlToIr`, since a channel a caller can skip is a silent drop.

This extends the structured surface rather than breaching it.
Every gateway is still derived from block structure, none is written, and none is named, so the grammar header's claim holds word for word.

Both gateways move from a blanket refusal to a carry.
An inclusive gateway carries with no exceptions, reading `name` and `default`, because Operaton refuses nothing about it.
An event-based gateway carries with three refusals, each a shape Operaton's own parser rejects by name:

- an outgoing flow whose target is not a `bpmn:intermediateCatchEvent` (`BpmnParse.java:2162`)
- a downstream catch carrying a link definition (`BpmnParse.java:1583-1585`)
- a downstream catch with an incoming sequence flow other than the one from the gateway (`BpmnParse.java:4371-4377`), which no script can author

### Consequences

- Good, because both gateways stay synthesized and elided, so idempotence, the id scheme, and the control-flow analysis need no new rule and no new IR flag.
- Good, because neither construct spends a reserved word; reserving `race` would take `var race: string` and `user race` out of the language.
- Bad, because a conditioned `parallel` reads as one construct but compiles to either of two BPMN elements, so a BPMN-literate reader must read every branch.
- Bad, because `irToDsl` changes its return shape, touching every call site, for a diagnostic that is cosmetic in every case it reports.
- Bad, because the label comes back on a BPMN-to-BPMN pass but never on a BPMN-to-DSL one, so a decompiled and recompiled document loses every gateway label.
- Bad, because a conditional branch of a race can win without waiting (`EventBasedGatewayActivityBehavior.java:30-46`), which no part of the surface shows.
- Bad, because an inclusive fork closed on an exclusive merge, the common hand-drawn shape, degrades to `goto`s a reader repairs by hand.

### Confirmation

Parser tests pin a `parallel` block mixing an `if` branch, a plain branch and an `else` branch, and a plain branch opening with a nested `if`/`else`.
`await { ... }` parses as a race while `await timer after "PT1H"` still parses as a single catch.
Validation tests pin the four-trigger scope, the two-branch minimum as a parse failure, and an `else` branch with no conditioned sibling.
Transform tests pin element selection, the default-flow rule, the race's join and its pruning, the inclusive carry, and each refusal by name.
They also pin elision of both new pairs and the dropped-label warning reaching the caller.
Golden fixtures assert IR idempotence after normalization and that the decompiled source recompiles cleanly.
A Docker-gated end-to-end test shows the losing race branch canceled and the inclusive join waiting for exactly the branches taken.

## Pros and Cons of the Options

- Conditioned branches on `parallel` add no keyword, no statement, and no id template, but the element choice is invisible in the block's keyword.
- A bare parenthesized condition parses as cleanly, but a parenthesized expression opening a line is a shape this language has nowhere else.
- A separate reserved keyword would make the element visible, but it spends a word and names the BPMN element rather than what the user means.
- Routing the default to the join reuses a rule `lowerIf` already applies, at the cost of a fallback invisible in the source.
- Requiring a written `else` would make that fallback visible, but it is required syntax for something the compiler can infer.
- A multi-branch `await` reserves no word and generalizes a meaning the keyword already carries.
- A distinct keyword could not be confused with anything, but it costs the language a name authors may want.
- A synthesized exclusive join with fall-through reuses `if`'s join and cannot duplicate a token, at the cost of a join that sees one.
- Self-contained branches rejoining by `goto` would match a hosted `on` handler, but would force a `goto` for the common timeout case.
- No label slot with the drop reported keeps every gateway elided and reports every other print-side drop, at the cost of a signature change.
- A label slot is the only way a label survives a full BPMN to DSL to BPMN round trip, but a labeled gateway is an authored gateway.
- Leaving the drop silent costs nothing, and it is the one thing ADR-0014's contract exists to prevent.
- A `gateway` keyword or a flat node-and-edge form would express every gateway shape, but a gateway that prints re-parses with an authored id.

## More Information

Related decisions: ADR-0008 and ADR-0013 set the surface and its two rules, ADR-0009 gains an inclusive pattern and a race pattern, and ADR-0010 gains one id template.
ADR-0014 supplies the import contract extended here to the print hop, ADR-0016 the soft trigger words, and ADR-0017 the payload surface a race branch header reuses.
ADR-0019 supplies the live-parser method, and ADR-0020 the keyword and trigger scope the race inherits.
Operaton behavior was read from `BpmnParse.java`, `InclusiveGatewayActivityBehavior.java`, and `EventBasedGatewayActivityBehavior.java` in the `operaton/operaton` repository, with line numbers as of the time of writing.
The documented restrictions are from <https://docs.operaton.org/docs/documentation/reference/bpmn20/gateways/event-based-gateway/>.
The dataset behind Compagnucci, Corradini, Fornari and Re (BISE 66(1), 2024, DOI 10.1007/s12599-023-00818-7) has an event-based gateway in roughly 12 percent of its 38,863 models and an inclusive gateway in roughly 6 percent.
