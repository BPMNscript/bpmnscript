---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# The print declares every variable it reads

## Context and Problem Statement

A `var x: number` line in the header declares a variable so the validator can check its uses, and nothing else.
BPMN has no slot for it, the compiler writes none, and the process the engine runs is the same with or without it.
A document nobody wrote in this language therefore carries no declaration at all, while a variable the printed script reads in a condition, a count, an `until`, an error mapping's `when` or an `in` mapping needs one or the script warns the moment it is built.

Where should the declarations a rebuilt script needs come from?

## Decision Drivers

- The script the tool prints from a document should build without a warning about the tool's own output, since a warning there names nothing the author can fix.
- One fact, one home: which positions read a variable and which constructs type one are the validator's rule and its symbol table.
  The print should mirror them rather than keep a list of its own.
- A form field and a catch binding already carry a type through the XML, so a second carrier for the same fact would be a second thing to reconcile.

## Considered Options

- Declare on print every variable the body reads bare, typed `any`: it works for a document nobody wrote in this language, which carries no declaration to read back, and adds nothing to the XML and needs no reader, at the cost of the type, a name being declarable only as `any`.
- Carry `var` lines through the XML in an extension element: the type would survive the round trip, but an extension element the engine ignores would be a second home for a fact the form and catch bindings already carry, the importer would have to reconcile the two when they disagree, and a third-party document never carries it, so the derivation on print is needed all the same.
- Keep declaring collections alone: nothing changes, but nearly every decompiled program then warns on rebuild, about the tool's own output.

## Decision Outcome

Chosen option: declare on print every variable the body reads bare, typed `any`, because the print already knows every position it writes a variable in, and a third-party document never carries a declaration, so the derivation is needed whatever the XML holds.

The header gets one `var <name>: any` line per name the body reads in a position the script writes bare and nothing types, in first-appearance order over one fixed walk of the model.
The positions are the ones the validator reads a variable at: a flow's condition, a loop's count and completion condition, a conditional trigger, an error mapping's condition, an `in` mapping's source, and a bare collection.
A body prints bare only when it fits the expression subset, so only those bodies contribute names; a raw `"${...}"` body is opaque to the validator and to the print alike.
The typed set is the validator's symbol table, `DefaultVariableSymbolProvider.collect`.
It holds every form field, every catch binding, every input and output parameter name, every loop element variable, and the four counters `MultiInstanceActivityBehavior` sets once anything repeats.
`externalTask` inside a mapping and the source of an `out` mapping are left out for the reasons the validator leaves them out: the one is resolved on the external task's execution, the other in the called process.
The type is `any` because a read says nothing more.
Every declaration of a name has to agree on its type, so a line for a name a form already types would be an error rather than a duplicate.

The walk reads the model, not the print.
A condition the print had to drop still declares its variable, since the model reads it, the drop is reported beside it, and the declaration is what the author repairing the drop by hand needs.

### Consequences

- Good, because a decompiled script builds clean, the Operaton invoice example included.
- Good, because the document the engine sees is unchanged: nothing new is written to the XML.
- Bad, because a `var x: boolean` comes back as `var x: any`, so the type an author wrote is lost on the way through the XML.
  A fixture that needs the type back declares the variable on a form, whose type the XML carries.
- Bad, because the positions and the typed set are spelled in the language package and mirrored in the transform package.
  A position or a symbol source added on one side has to be added on the other.
  The mirror is stated in one comment on each side, and the round-trip suites turn red on the first program that drifts.
- Neutral, because a variable a dropped condition read is declared and never read in the printed body.

### Confirmation

The row under "the header declares every variable the body reads bare" in `packages/transform/test/ir-to-dsl.test.ts` prints one process reading a variable at every position and typing one through every source, pinning the whole header and an empty diagnostic list on the re-parse.
The two-pass table in `tests/round-trip-constructs.test.ts` requires an empty diagnostic list on every printed script, and its last row is a condition variable coming back declared and re-printing byte for byte.

## More Information

The walk is `variableDecls` in `packages/transform/src/ir-to-dsl.ts`.
The validator's positions are in `checkExpression` in `packages/language/src/bpmn-script-validator.ts` and its symbol table in `packages/language/src/variable-symbol-provider.ts`.
