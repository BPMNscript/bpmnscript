---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# The print declares every variable it reads bare, typed any

## Context and Problem Statement

A `var x: number` line in the header declares a variable so the validator can check its uses, and nothing else.
BPMN has no slot for it, the compiler writes none, and the process the engine runs is the same with or without it.
The print used to derive a declaration only for a bare `for each ... in <name>` collection, and relied on form fields and catch bindings, which the XML does carry, to type everything else.
A variable read in a condition, a count, an `until`, an error mapping's `when` or an `in` mapping came back undeclared, so the script `bpmns parse` wrote warned the moment it was built.
That was every decompiled example, the Operaton invoice example, and 779 of the programs a fuzz run put through the round trip.
The golden fixtures avoided it by declaring every condition variable on a start form, which is a workaround rather than a contract.
Where should the declarations a rebuilt script needs come from?

## Decision Drivers

- The script the tool prints from a document should build without a warning about the tool's own output, since a warning there names nothing the author can fix.
- One fact, one home: which positions read a variable and which constructs type one are the validator's rule and its symbol table.
  The print should mirror them rather than keep a list of its own.
- A form field and a catch binding already carry a type through the XML, so a second carrier for the same fact would be a second thing to reconcile.

## Considered Options

- Declare on print every variable the body reads bare, typed `any`
- Carry `var` lines through the XML in an extension element
- Keep declaring collections alone

## Decision Outcome

Chosen option: declare on print every variable the body reads bare, typed `any`, because the print already knows every position it writes a variable in.
A third-party document never carries a declaration, so the derivation is needed whatever the XML holds.

The header gets one `var <name>: any` line per name the body reads in a position the script writes bare and nothing types, in first-appearance order over one fixed walk of the model.
The positions are the ones the validator reads a variable at.
They are a flow's condition, a loop's count and completion condition, a conditional trigger, an error mapping's condition, an `in` mapping's source, and a bare collection.
A body prints bare only when it fits the expression subset, so only those bodies contribute names; a raw `"${...}"` body is opaque to the validator and to the print alike.
The typed set is the validator's symbol table, `DefaultVariableSymbolProvider.collect`.
It holds every form field, every catch binding, every input and output parameter name, every loop element variable, and the four counters `MultiInstanceActivityBehavior` sets once anything repeats.
`externalTask` inside a mapping and the source of an `out` mapping are left out for the reasons the validator leaves them out.
The one is resolved on the external task's execution, the other in the called process.
The type is `any` because a read says nothing more.
Every declaration of a name has to agree on its type, so a line for a name a form already types would be an error rather than a duplicate.

The walk reads the model, not the print.
A condition the print had to drop still declares its variable, since the model reads it, the drop is reported beside it, and the declaration is what the author repairing the drop by hand needs.

### Consequences

- Good, because a decompiled script builds clean, the invoice example included.
- Good, because the document the engine sees is unchanged: nothing new is written to the XML.
- Bad, because a `var x: boolean` comes back as `var x: any`, so the type an author wrote is lost on the way through the XML.
  A fixture that needs the type back declares the variable on a form, whose type the XML carries.
- Bad, because the positions and the typed set are spelled in the language package and mirrored in the transform package.
  A position or a symbol source added on one side has to be added on the other.
  The mirror is stated in one comment on each side, and the round-trip suites turn red on the first program that drifts.
- Neutral, because a variable a dropped condition read is declared and never read in the printed body.

### Confirmation

The row under "the header declares every variable the body reads bare" in `packages/transform/test/ir-to-dsl.test.ts` prints one process reading a variable at every position and typing one through every source.
It pins the whole header and an empty diagnostic list on the re-parse.
The two-pass table in `tests/round-trip-constructs.test.ts` requires an empty diagnostic list on every printed script, and its last row is a condition variable coming back declared and re-printing byte for byte.

## Pros and Cons of the Options

### Declare on print every variable the body reads bare, typed `any`

- Good, because it works for a document nobody wrote in this language, which carries no declaration to read back.
- Good, because it adds nothing to the XML and needs no reader.
- Bad, because the type is lost, and a name can only be declared as `any`.

### Carry `var` lines through the XML in an extension element

- Good, because the type would survive the round trip.
- Bad, because an extension element the engine ignores would be a second home for a fact the form and catch bindings already carry.
  The importer would have to reconcile the two when they disagree.
- Bad, because a third-party document never carries it, so the derivation on print is needed all the same.

### Keep declaring collections alone

- Good, because nothing changes.
- Bad, because nearly every decompiled program warns on rebuild, about the tool's own output.

## More Information

The walk is `variableDecls` in `packages/transform/src/ir-to-dsl.ts`.
The validator's positions are in `checkExpression` in `packages/language/src/bpmn-script-validator.ts` and its symbol table in `packages/language/src/variable-symbol-provider.ts`.

Related decisions: ADR-0027 (the collection declaration this generalizes, and the seeded loop counters).
ADR-0014 (the honest import contract the clean rebuild belongs to).
