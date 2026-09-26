---
status: accepted
date: 2026-09-15
decision-makers: Marlon Kranz
---

# Import tiers follow the engine's parse

## Context and Problem Statement

ADR-0014 draws two tiers: what changes execution refuses, what does not warns.
It left the placement of each construct to the reader of the IR, and an audit of the importer against `BpmnParse` found the two disagreeing in both directions.
The importer refused what the engine deploys: a second listener on one event, a listener naming two bindings, a text beside a nested parameter value, an unknown binding word on a call activity, an `operaton:in` naming two source shapes, a throw whose `errorRef` names no root, an intermediate throw with no definition.
It carried what the engine refuses: an exclusive gateway with two plain routes, an `operaton:inputOutput` on a start event, a second `operaton:formData` on one task, a `jobPriority` of `1.5`, a sub-process with no start, two plain starts on the process.
And it dropped what the engine reads with a note that this tool "keeps" the very category being dropped: an execution listener on a gateway, an `operaton:in` on a thrown signal, a `formKey` on the process's start, a step's `default`.
Where should each tier sit, and what must a warning say when the dropped setting is one the engine runs?

## Decision Drivers

- ADR-0014's own claim: no silent semantic loss, and no refusal of a file the engine deploys.
- The engine's parser is the one reader whose verdict decides whether a document runs, so it is the one reference for where a tier sits.
- A warning that names what the engine does with the dropped setting is the only form under which a reader can tell a cosmetic drop from one that changes a run.
- The Camunda Modeler's default output, and the Operaton invoice example, have to import.

## Considered Options

- Draw each tier where `BpmnParse` draws it, and name the engine method in every refusal and every drop of a setting the engine reads
- Keep the tiers as the surface drew them and correct the wording alone
- Refuse every setting the engine reads that this surface cannot spell

## Decision Outcome

Chosen option: draw each tier where `BpmnParse` draws it, because it is the only option under which the importer accepts exactly what the engine deploys and says what the engine does with what it drops.

The rule has three clauses.
A shape `BpmnParse` fails the deployment on refuses, and the message names the method and quotes its sentence, since there is nothing that runs to write back.
A shape the engine deploys and this surface can spell is carried, with a warning where the spelling changes.
A shape the engine deploys and this surface cannot spell drops with a warning that names the method that reads it and says the document written back runs without it.
It refuses only where the drop changes a value the engine stores, which is a thrown message's result variable beside an expression binding.

The rows below are the tier moves, one per shape, with the engine method that decides it.

| Shape                                                                                                                                                            | Engine method                                                                                                          | Was                                                                  | Now                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `operaton:async="true"` on a job-setting owner                                                                                                                   | `BpmnParse.isAsyncBefore`                                                                                              | dropped as unread, with a warning                                    | carried as `asyncBefore`, warning names the respelling                 |
| `jobPriority` or `taskPriority` neither an integer nor an expression                                                                                             | `BpmnParse.parsePriority`                                                                                              | carried as written                                                   | refused                                                                |
| `operaton:resultVariableName`                                                                                                                                    | `BpmnParse.parseResultVariable`                                                                                        | dropped with a warning                                               | carried as `resultVariable`, warning names the respelling              |
| `resultVariable` beside an `external` or built-in `type` binding on a task                                                                                       | `BpmnParse.parseServiceTaskLike`                                                                                       | carried in silence                                                   | carried, warning says the binding never writes it                      |
| `operaton:decisionRefTenantId`                                                                                                                                   | `BpmnParse.parseTenantId`                                                                                              | dropped with a warning                                               | refused, as `calledElementTenantId` is                                 |
| `calledElementBinding` or `decisionRefBinding` outside the four words                                                                                            | `BpmnParse.parseBinding`, `BaseCallableElement.isLatestBinding`                                                        | refused                                                              | carried as `latest`, warning names the rule                            |
| `operaton:in`/`out` naming two shapes (`source` beside `sourceExpression`, `variables="all"` beside either, a `businessKey` beside them, a second `businessKey`) | `BpmnParse.parseCallableElementProvider`, `parseInputParameter`, `setBusinessKeyValueProvider`                         | refused                                                              | the engine's pick carried, one warning per loser                       |
| `operaton:potentialStarter` on the process                                                                                                                       | `BpmnParse.parseStartAuthorization`                                                                                    | dropped as residual extension content                                | read onto the candidate starter lists, warning names the rewrite       |
| A literal form default the field's type cannot convert                                                                                                           | `LongFormType.convertValue`, `BooleanFormType.convertValue`, `DateFormType`                                            | carried in silence                                                   | carried, warning says the printed script draws an error there          |
| An empty `name`, `label`, `defaultValue`, or `operaton:assignee`                                                                                                 | read as the empty text                                                                                                 | read as absent                                                       | carried as `""`, so the second compile writes the same attribute       |
| A script body holding three consecutive backticks                                                                                                                | none; no fence can enclose it                                                                                          | printed into a script that does not parse                            | refused                                                                |
| A thrown message's `resultVariable` beside `class` or `delegateExpression`                                                                                       | `BpmnParse.parseServiceTaskLike`                                                                                       | dropped with a warning                                               | refused                                                                |
| A thrown message's `resultVariable` beside `expression`                                                                                                          | `BpmnParse.parseServiceTaskLike` into `ServiceTaskExpressionActivityBehavior`                                          | dropped with a warning                                               | refused; the engine stores the value and the throw has no slot         |
| A thrown message's `resultVariable` beside `external` or no binding                                                                                              | `BpmnParse.parseServiceTaskLike`                                                                                       | dropped under a note that this tool keeps it                         | dropped, warning says no binding writes it                             |
| A thrown message's `taskPriority`, `operaton:properties`, `operaton:errorEventDefinition`, or injected field                                                     | `BpmnParse.parseExternalServiceTask`, `parseServiceTaskLike`                                                           | dropped under the same note                                          | dropped, warning names the reader                                      |
| A dangling `errorRef` on a catch                                                                                                                                 | `BpmnParse.parseBoundaryErrorEventDefinition`, `parseErrorStartEventDefinition`                                        | imported as a catch-all                                              | imported as the code spelled by the text, with a warning               |
| A dangling `errorRef` on an error end                                                                                                                            | `BpmnParse.parseEndEvents`                                                                                             | refused                                                              | imported as the code spelled by the text, with a warning               |
| A dangling `escalationRef` on a catch                                                                                                                            | `BpmnParse.createEscalationEventDefinitionForEscalationHandler`                                                        | imported as a catch-all                                              | refused                                                                |
| An absent or dangling `escalationRef` on a throw                                                                                                                 | `BpmnParse.findEscalationForEscalationEventDefinition`                                                                 | imported as a catch-all                                              | refused                                                                |
| An `operaton:errorEventDefinition` with no `errorRef`                                                                                                            | `BpmnParse.parseOperatonErrorEventDefinitions`                                                                         | refused                                                              | skipped with a warning, as the engine skips it                         |
| An `operaton:errorEventDefinition` with a dangling `errorRef` and an `expression`                                                                                | `BpmnParse.parseOperatonErrorEventDefinitions`                                                                         | refused                                                              | imported as the code spelled by the text, with a warning               |
| `operaton:initiator` or `operaton:formData` on a start that is not the process's own                                                                             | `BpmnParse.parseScopeStartEvent`, `parseStartFormHandlers`                                                             | carried                                                              | dropped, warning names the reader that never runs there                |
| An intermediate throw with no event definition                                                                                                                   | `BpmnParse.parseIntermediateThrowEvent` into `IntermediateThrowNoneEventActivityBehavior`                              | refused                                                              | imported as a plain step, warning names the rewrite                    |
| `operaton:inputOutput` on a start event, a gateway, or an event handler                                                                                          | `BpmnParse.ensureNoIoMappingDefined`, `checkActivityInputOutputSupported`                                              | dropped with a warning, or carried                                   | refused                                                                |
| `operaton:outputParameter` on an end event                                                                                                                       | `BpmnParse.checkActivityOutputParameterSupported`                                                                      | dropped with a warning                                               | refused                                                                |
| A second `operaton:inputOutput`, `formData`, `properties`, or `failedJobRetryTimeCycle` on one element                                                           | `Element.elementNS`                                                                                                    | first kept, rest warned                                              | refused                                                                |
| A second listener on one event                                                                                                                                   | `CoreModelElement.addListenerToMap`, `TaskDefinition.addTaskListener`, `addTimeoutTaskListener`                        | refused                                                              | carried in document order                                              |
| A listener naming two or more bindings                                                                                                                           | `BpmnParse.parseExecutionListener`, `parseTaskListener`                                                                | refused                                                              | first in the engine's order kept, one warning per loser                |
| An execution listener with `expression=""`, a task listener with `class=""`, `expression=""`, or `delegateExpression=""`                                         | `ExpressionExecutionListener`, `ExpressionTaskListener`, `ClassDelegateTaskListener`, `DelegateExpressionTaskListener` | refused as naming no binding                                         | carried, warning says the printed script draws an error there          |
| An execution listener with `class=""` or `delegateExpression=""`                                                                                                 | `BpmnParse.parseExecutionListener`                                                                                     | refused as naming no binding                                         | refused quoting "cannot be empty"                                      |
| A timer under a task listener that is not a `timeout`                                                                                                            | `BpmnParse.parseTaskListener`                                                                                          | refused                                                              | dropped with a warning                                                 |
| Body text beside one nested value in a parameter                                                                                                                 | `BpmnParseUtil.parseNestedParamValueProvider`                                                                          | refused                                                              | nested value kept, text warned                                         |
| An exclusive gateway with no route, one conditioned route, a conditioned default, or a plain non-default route                                                   | `BpmnParse.validateExclusiveGateway`                                                                                   | imported and printed as `if (true)`                                  | refused as `UnsupportedGatewayShapeError`                              |
| A condition typed through `xsi:type` as anything but `tFormalExpression`                                                                                         | `BpmnParse.parseConditionExpression`                                                                                   | imported                                                             | refused                                                                |
| A condition or completion condition body with no `${` or `#{` opener, or an empty one                                                                            | `UelExpressionCondition.evaluate`, `MultiInstanceActivityBehavior.completionConditionSatisfied`                        | carried in silence                                                   | carried inside `${...}`, or as no condition when empty, with a warning |
| A sequence flow's `name` differing from the label the rebuilt document derives                                                                                   | none; the engine routes by condition                                                                                   | dropped in silence                                                   | dropped with a `label` warning                                         |
| A `bpmn:subProcess` with no start event                                                                                                                          | `BpmnParse.parseStartEvents`                                                                                           | imported with a start added                                          | refused                                                                |
| A `bpmn:process` with no start event                                                                                                                             | `BpmnParse.parseStartEvents`                                                                                           | imported with a warning                                              | refused                                                                |
| A `bpmn:transaction` with no start event                                                                                                                         | `SubProcessActivityBehavior.execute`                                                                                   | imported with a start added, in silence                              | imported with a start added, with a warning                            |
| Two or more plain or timer starts on the process                                                                                                                 | `BpmnParse.selectInitial`                                                                                              | imported                                                             | refused                                                                |
| A sequence flow into or out of an event handler                                                                                                                  | `BpmnParse.parseSequenceFlow`                                                                                          | caught only through the element's own `incoming`/`outgoing` children | refused off the flow's ends                                            |
| A `default` on a step naming one of its routes                                                                                                                   | `BpmnActivityBehavior.handleNoTransitions`                                                                             | dropped with a warning                                               | carried; a `default` naming a foreign flow still drops with a warning  |
| A collection named in both spellings with different shapes                                                                                                       | `MultiInstanceActivityBehavior.resolveNrOfInstances`                                                                   | BPMN spelling kept                                                   | the expression kept, warning names the rule                            |
| A `language` on a `bpmn:completionCondition`                                                                                                                     | `BpmnParse.parseMultiInstanceLoopCharacteristics`                                                                      | dropped in silence                                                   | dropped with a warning                                                 |

Three rules stand behind the rows.

Listeners repeat per event.
`CoreModelElement.addListenerToMap` and `TaskDefinition.addTaskListener` both append rather than replace, so several `start` listeners run in document order.
`BpmnParse.parseTaskListeners` routes a `timeout` listener to `TaskDefinition.addTimeoutTaskListener`, which keys it by its id, so two `timeout` listeners with distinct ids and timers are the ordinary reminder-then-escalate shape.
The validator's one-listener-per-event error goes, the importer keeps document order as the IR order, and a listener naming two bindings keeps the first in the order `parseExecutionListener` and `parseTaskListener` read them: `class`, `expression`, `delegateExpression`, then the `operaton:script` child.

A thrown message is a service task to the engine.
`parseIntermediateThrowEvent` and `parseEndEvents` hand a message definition to `parseServiceTaskLike`, so off the definition the engine reads every binding word, the injected fields, the result variable, the priority, and the error mappings.
This surface's throw carries the binding alone, so each of the rest drops with a warning naming the reader.
The result variable is the exception: beside a `class` or `delegateExpression` the engine refuses it, and beside an `expression` the engine stores it where the throw cannot spell it, so both refuse.

A drop of what the engine reads names its reader.
`warnUnimportedSetting` says that this tool reads no such setting on the owner's tag and that the document written back carries none, and where the engine does read it there, the sentence continues with the method and says the document written back runs without it.
The note that listed what this tool keeps is gone, since it named the very setting being dropped whenever that setting fell in one of its categories.

### Consequences

- Good, because a document the engine deploys imports, and one it refuses is refused with the engine's own sentence rather than imported into a script that cannot deploy.
- Good, because every warning on a setting the engine reads says which method reads it, so the reader knows whether the drop changes a run.
- Good, because the Modeler's default export and the invoice example, both refused before, import.
- Bad, because the engine's sentences are quoted in the importer and drift with the engine's wording.
- Bad, because a shape the engine deploys and then fails at run time, such as an empty listener `class` on a task, is carried into a script that draws an error at the step, which the reader has to repair by hand.

### Confirmation

The refusal and warning tables in `packages/transform/test/xml-to-ir.test.ts` pin every row above with the whole warning list or the refusal class and detail, and the audit reproductions each row came from are the fixtures.
`tests/review-loop.round-trip.test.ts` and the invoice fixture in `tests/` pin the Modeler-shaped documents end to end.

## Pros and Cons of the Options

### Draw each tier where `BpmnParse` draws it

- Good, because the engine is the one reader whose verdict decides what runs, so the tiers stop being a second opinion.
- Bad, because every row needs the engine method read before its sentence is written.

### Keep the tiers as the surface drew them and correct the wording alone

- Good, because no import result changes and no test moves.
- Bad, because the importer would keep refusing files the engine deploys and carrying files it refuses, which ADR-0014 does not license.

### Refuse every setting the engine reads that this surface cannot spell

- Good, because nothing the engine runs is ever dropped.
- Bad, because a listener on a gateway or a `formKey` on a process start would refuse every Modeler export that carries one, and the drop costs the reader a warning, not a run.

## More Information

The checks sit in `packages/transform/src/xml-to-ir.ts`: `checkExclusiveGateways`, `checkStartEventCount`, `checkHandlerFlows`, `attachDefaultFlows`, `refuseIoMapping`, `onlyExtensionElement`, `resolveListenerBinding`, `readThrownMessageBinding`, and the `ENGINE_READS_ELSEWHERE` table behind `warnUnimportedSetting`.
The consumer-facing summary is the import contract section of `packages/transform/README.md`.

Amends ADR-0014, whose `UnsupportedExtensionFormError`, `UnsupportedErrorMappingError`, and step-`default` bullets and whose gateway-listener line point here.
Amends ADR-0023 (listeners repeat per event), ADR-0033 (the call-mapping shapes that warn rather than refuse), ADR-0037 (form defaults the type cannot convert are carried), ADR-0038 (a thrown message's extras and the error-mapping shapes), ADR-0039 (an `operaton:potentialStarter` reads like a `bpmn:potentialOwner`), and ADR-0043 (the result-variable rules on a task and on a thrown message).

Related decisions: ADR-0049 (the document-level refusals and the collaboration, decided on the same reading of the engine).
ADR-0048 (the validator's mirror of the same parse-time rules on the compile side).
ADR-0053 (how a carried step `default` prints).
