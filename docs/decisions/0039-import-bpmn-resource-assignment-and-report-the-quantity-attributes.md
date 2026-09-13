---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# Import BPMN resource assignment, and report the quantity attributes

## Context and Problem Statement

A user task drawn in the Modeler can say who does it in BPMN's own words: one `bpmn:humanPerformer` and any number of `bpmn:potentialOwner` elements, each carrying a formal expression.
`BpmnParse.parseTaskDefinition` reads both into the same assignee and candidate lists that `operaton:assignee`, `operaton:candidateUsers`, and `operaton:candidateGroups` fill, so the deployed task is the same whichever spelling the document used.
This surface writes the Operaton spelling alone, and the import dropped every resource role with a warning.
ADR-0014 admitted that drop as the one warned item that changes what runs, since it changes who may claim the task.

Separately, BPMN declares `startQuantity` and `completionQuantity` on every activity with a default of `1`, and ADR-0014 named `startQuantity` as its example of an attribute neither read nor reported.
`BpmnParse` contains no line reading either, so a document setting one away from `1` runs as if it read `1`, and the import said nothing.

## Considered Options

- Refuse the BPMN spelling
- Carry both spellings in the IR and the script
- Import the two roles onto the Operaton attributes, with a warning naming the rewrite

## Decision Outcome

Chosen: import onto the Operaton attributes with a warning, and report a quantity away from `1`.

The merge follows the engine's order.
`parseTaskDefinition` runs `parseHumanPerformer` and `parsePotentialOwner` before `parseUserTaskCustomExtensions`, so role-derived entries come first and the attribute's entries after, joined with a comma.
The one `bpmn:humanPerformer` gives the assignee.
Each `bpmn:potentialOwner` is split as `parseCommaSeparatedList` splits, where a comma inside a `${...}` or `#{...}` body does not split.
An entry `user(x)` is a candidate user, and `group(x)` or a bare entry is a candidate group.
The exported document then carries the Operaton attributes alone, and the engine builds the same identity links from them.
One warning per role element names the rewrite, so a reader knows the script says `assignee: "demo"` where the document said `bpmn:humanPerformer`.

Two shapes refuse as `UnsupportedAssignmentError`, because the engine refuses to deploy them.
A `bpmn:humanPerformer` beside `operaton:assignee`, which `parseUserTaskCustomExtensions` rejects as a duplicate assignee, and more than one `bpmn:humanPerformer`, which `parseHumanPerformer` rejects.
The rest drops with a warning naming the method that reads nothing off it.
A role with no `bpmn:formalExpression` child, a plain `bpmn:performer` or bare `bpmn:resourceRole`, and a role's `resourceRef` or parameter binding are each read by no line of `BpmnParse`.
A `bpmn:expression` child typed `tFormalExpression` through `xsi:type` drops the same way, since the engine fetches the child by its tag name and finds none.
On every activity other than a user task the roles stay a generic drop, since the engine reads none of them there.

A `startQuantity` or `completionQuantity` other than `1` warns as an `unmappedConstruct`, naming the attribute and that `BpmnParse` never reads it.
The moddle default is `1`, so a written `="1"` is silent, as ADR-0014 already holds for a BPMN attribute set to the value it reads back as when nothing is written.

### Consequences

- Good, because a Modeler-drawn user task deploys with the same assignee and candidates whichever spelling the document used.
- Good, because the one warned drop that changed who may claim a task is gone from the import contract.
- Bad, because the round trip rewrites the document: a `bpmn:potentialOwner` comes back as `operaton:candidateGroups`.
- Bad, because a `bpmn:expression` typed `tFormalExpression` is a legal BPMN spelling the engine reads nothing of, so it drops under a warning that reads as a lost assignment.

### Confirmation

The import tables in `packages/transform/test/xml-to-ir.test.ts` pin the merge, the split, the two refusals, each drop, and the quantity warning.
`tests/e2e/forms-and-external-tasks.test.ts` deploys the re-export of a task assigned in BPMN's own words to a real engine and reads the identity links back.

## Pros and Cons of the Options

### Refuse the BPMN spelling

- Good, because the import never rewrites a document.
- Bad, because it rejects a file the engine deploys and runs, which ADR-0014 does not license.

### Carry both spellings

- Good, because the round trip is byte-stable on the roles.
- Bad, because the language then has two spellings for one assignment, and the IR two fields the engine merges into one.

### Import onto the Operaton attributes with a warning

- Good, because the deployed task is the same, and the warning names the rewrite as the `bpmn:manualTask` warning does.
- Bad, because the document written back differs from the one read.

## More Information

Amends ADR-0014 (the refusal list gains `UnsupportedAssignmentError`; the warned list narrows the resource-assignment drop to the roles the engine never reads and gains the quantity attributes; `startQuantity` leaves the unreported list).

Related decisions: ADR-0022 (engine attributes as named IR fields, where `assignee`, `candidateUsers`, and `candidateGroups` live).
