// BPMNscript grammar.
//
// Covers the supported subset: process, start, end, user task,
// service task (Java class), exclusive gateway, and sequence flow.
//
// AST node names map 1:1 to the IR `kind` discriminant in
// packages/transform/src/ir/types.ts so the AST -> IR transform
// can switch on `$type` without an extra mapping table.
//
// Naming convention: the AST property `name` is used for the DSL identifier
// (e.g. `ReviewStart`, `AutoApprovePath`, `invoice-approval`). This matches
// Langium's default NameProvider and makes cross-references via `[X:ID]`
// resolve automatically. The human-readable BPMN label is carried in the
// separate `label` property when present (a quoted string after the id).
//
// String literal bodies (assignee, formKey, class, when, label) are passed
// through verbatim by Langium. The grammar does no entity escaping: the
// XML serializer is responsible for &amp;/&lt;/&gt; encoding when
// embedding the body into <bpmn:formalExpression>. This is why a condition
// such as `when: "${amount > 1000}"` appears with a literal `>` in source.

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// A process body is written in two sections: every node declaration first,
// then every sequence flow. Node rules begin with a keyword and flows with a
// bare id, so the parser could also accept them interleaved; the two-section
// form is a deliberate readability choice, separating "what exists" from
// "how it connects" the way graph formats such as Graphviz DOT do.
Process:
    'process' name=ID (label=STRING)? '{'
        nodes+=FlowNode*
        flows+=SequenceFlow*
    '}';

// FlowNode is the union of every node kind. Each concrete subtype carries
// a `name` (the DSL identifier) used as the cross-reference target from
// SequenceFlow.
FlowNode:
    StartEvent | EndEvent | UserTask | ServiceTask | ExclusiveGateway;

StartEvent:
    'start' name=ID (label=STRING)?;

EndEvent:
    'end' name=ID (label=STRING)?;

// UserTask: optional `assignee:` then `formKey:`, each at most once. The
// order is fixed: Langium 4.2 rejects optional members in an unordered group
// (`&`), and the repeated-alternation workaround `(A | B)*` would silently
// accept duplicate attributes (last value wins) with no way to flag them from
// the AST. Fixed order keeps authoring unambiguous.
UserTask:
    'user' name=ID (label=STRING)?
        ('assignee:' assignee=STRING)?
        ('formKey:'  formKey=STRING)?;

ServiceTask:
    'service' name=ID (label=STRING)?
        'class:' javaClass=STRING;

ExclusiveGateway:
    'gateway' name=ID (label=STRING)?
        ('default:' default=[SequenceFlow:ID])?;

// SequenceFlow connects two FlowNodes. The optional `as: <id>` gives the
// flow a name a gateway can target via `default:`. The optional `when:`
// carries the raw expression body for conditional flows. The order
// (`as:` before `when:`) is fixed for the same reason as UserTask's
// attributes: Langium has no optional-member unordered group.
SequenceFlow:
    source=[FlowNode:ID] '->' target=[FlowNode:ID]
        ('as:'   name=ID)?
        ('when:' condition=STRING)?;

hidden terminal WS: /\s+/;

// ID accepts BPMN-style identifiers with internal hyphens (e.g. `invoice-approval`).
// A hyphen is allowed only between word characters, never trailing, so `A->B`
// written without surrounding whitespace still lexes as ID `A`, keyword `->`,
// ID `B` instead of swallowing the `-` into the identifier.
terminal ID: /[_a-zA-Z]\w*(-\w+)*/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
