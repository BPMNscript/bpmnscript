# Architecture decision records

Each file in this directory records one design decision behind BPMNscript: the problem, the options weighed, the choice, and what it costs.
Every record follows the MADR shape in [adr-template.md](adr-template.md), and states the decision as it stands today.
Where a record names what the engine does, that behaviour was read from Operaton 2.1.0.

| Number                                                                 | Title                                                               | Status   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0000](0000-use-markdown-architectural-decision-records.md)            | Use Markdown Architectural Decision Records                         | accepted |
| [0001](0001-use-apache-2-license.md)                                   | Use Apache 2.0 License                                              | accepted |
| [0002](0002-use-mono-repo-structure.md)                                | Use Mono-repo Structure                                             | accepted |
| [0003](0003-use-langium-as-language-workbench.md)                      | Use Langium as Language Workbench                                   | accepted |
| [0004](0004-use-vscode-as-primary-ide-target.md)                       | Use VS Code as Primary IDE Target                                   | accepted |
| [0005](0005-in-editor-conversion-webview-sidebar.md)                   | In-Editor Conversion: Webview Sidebar and Two Layers                | accepted |
| [0006](0006-target-users-without-bpmn-knowledge.md)                    | Target users without BPMN knowledge, and minimize boilerplate       | accepted |
| [0007](0007-intermediate-representation-ast-bpmn.md)                   | An intermediate representation between the AST and BPMN XML         | accepted |
| [0008](0008-fork-camunda-moddle-extension.md)                          | Fork the Camunda moddle extension as a local Operaton one           | accepted |
| [0009](0009-auto-layout-and-expansion-hint.md)                         | Diagram interchange: auto-layout and the sub-process expansion hint | accepted |
| [0010](0010-deterministic-synthesized-ids.md)                          | Deterministic ids for synthesized elements, reserved and respelled  | accepted |
| [0011](0011-structured-grammar-one-bracket-shape.md)                   | A structured, code-like grammar with one bracket shape              | accepted |
| [0012](0012-honest-bpmn-import.md)                                     | Honest BPMN import: refusals, warnings, and the parse tiers         | accepted |
| [0013](0013-validator-mirrors-parse-time-rules.md)                     | The validator mirrors the engine's parse-time rules                 | accepted |
| [0014](0014-restructure-the-ir-into-a-dsl-with-dominator-analysis.md)  | Restructure the IR into a DSL with dominator analysis               | accepted |
| [0015](0015-the-print-declares-every-variable-it-reads.md)             | The print declares every variable it reads                          | accepted |
| [0016](0016-task-kinds-on-the-authoring-surface.md)                    | Task kinds on the authoring surface                                 | accepted |
| [0017](0017-service-task-bindings.md)                                  | Service task bindings, including external, mail and shell           | accepted |
| [0018](0018-forms-and-field-injection.md)                              | Forms and field injection                                           | accepted |
| [0019](0019-a-call-activitys-variable-mapping.md)                      | A call activity's variable mapping                                  | accepted |
| [0020](0020-listeners-reuse-on-inside-the-attribute-block.md)          | Listeners reuse `on` inside the attribute block                     | accepted |
| [0021](0021-operaton-engine-attributes-as-named-ir-fields.md)          | Operaton engine attributes as named IR fields                       | accepted |
| [0022](0022-repetition-the-for-clause-and-its-per-run-job-settings.md) | Repetition: the `for` clause and its per-run job settings           | accepted |
| [0023](0023-event-roots-from-usage-and-declared-codes.md)              | Event root elements derived from usage, and declared codes          | accepted |
| [0024](0024-event-trigger-payloads-paren-slot.md)                      | Event trigger payloads in one paren slot                            | accepted |
| [0025](0025-events-at-the-process-boundary.md)                         | Events at the process boundary: starts, ends and throws             | accepted |
| [0026](0026-intermediate-catch-events.md)                              | Intermediate catch events                                           | accepted |
| [0027](0027-boundary-events-attached-to-an-activity.md)                | Boundary events attached to an activity                             | accepted |
| [0028](0028-compensation-as-subprocess-undo-block.md)                  | Compensation as a subprocess undo block                             | accepted |
| [0029](0029-work-that-can-be-given-up.md)                              | Work that can be given up: `attempt` and `cancel`                   | accepted |
| [0030](0030-link-events-for-import-round-trip-symmetry.md)             | Link events for import round-trip symmetry                          | accepted |
| [0031](0031-inclusive-and-event-based-gateways.md)                     | Inclusive and event-based gateways                                  | accepted |
| [0032](0032-expressions-raw-templates-and-escapes.md)                  | Expressions: raw templates, escapes, and what is lowered as EL      | accepted |
