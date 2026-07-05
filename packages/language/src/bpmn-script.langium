// The BPMNscript grammar — code-like structured statements.
//
// A process body is a sequence of statements that execute top-to-bottom
// (implicit sequence flow); control flow is expressed with `if`/`else if`/
// `else`, `while`, `do … while`, `parallel { { } { } }`, and `goto <id>`.
// `start`/`end` are explicit-allowed but implicit by default (the desugarer
// synthesises them). There is no flat node/edge surface and no `gateway`
// keyword: gateways are derived from the structured control-flow constructs.
//
// Design:
//   - Keyword + braces statements with implicit flow.
//   - Typed-per-element attribute blocks, modelled as a *list* of attribute
//     nodes so a validator can detect duplicate keys from the AST.
//   - A JUEL-subset expression sub-language parsed to a real AST (parser
//     rules, never a terminal), with a quoted "${…}" raw-string fallback.
//   - Optional typed `var name: type` declarations at process scope.
//
// Naming convention (CLAUDE.md NameProvider lesson): the AST property `name`
// holds the DSL identifier used as the cross-reference *target* key. Every
// targetable statement therefore exposes `name=ID`, which is what lets
// `goto target=[Statement:ID]` resolve through Langium's default NameProvider.
// The human-readable BPMN label is carried in the separate `label` property
// (a quoted string after the id).
//
// Reserved words (cannot be used as a bare expression identifier; use the
// quoted "${…}" raw-string fallback if a variable must be named like one):
//   process, var, start, end, user, service, if, else, while, do, parallel,
//   goto, label, assignee, formKey, class,
//   string, number, boolean, date, json, any,
//   true, false, null.
// JUEL identifiers that do NOT collide with this set lex as plain `ID` in
// expression position and parse to `VarRef` as expected (e.g. `status`,
// `order.type`, `items[0]`).

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// A process: `process <id> "<label>"? { <header> <statements> }`. The header
// carries process-scope declarations (the optional `label = "…"` attribute and
// any `var` declarations); the remaining statements form the implicit block
// body. Declarations are gathered into `decls`, executable statements into
// `body`, so the desugarer and the validator can address them independently.
Process:
    'process' name=ID (label=STRING)? '{'
        (decls+=ProcessDecl)*
        body+=Statement*
    '}';

// Process-scope declarations: the process-level label attribute and typed
// `var` declarations. Kept separate from executable statements.
ProcessDecl:
    ProcessLabel | VarDecl;

// Process-level label attribute, e.g. `label = "Invoice Approval"`. Stored as
// its own node so the validator can flag a duplicate `label`.
ProcessLabel:
    'label' '=' value=STRING;

// Typed variable declaration. Parsed here; validated by the validator.
// `VarType` is aligned with Operaton variable types.
VarDecl:
    'var' name=ID ':' type=VarType;

VarType returns string:
    'string' | 'number' | 'boolean' | 'date' | 'json' | 'any';

// Executable statements. Every concrete subtype that is a jump target exposes
// `name=ID`. Compound statements (if/while/do-while/parallel) nest further
// `Statement`s through `Block`s.
Statement:
      StartEvent | EndEvent
    | UserTask | ServiceTask
    | IfStatement | WhileStatement | DoWhileStatement
    | ParallelStatement | GotoStatement;

// A brace-delimited list of statements (the body of if/else/while/do/parallel
// branches). The process body itself is an *implicit* block (no braces),
// handled inline by the Process rule above.
Block:
    '{' statements+=Statement* '}';

StartEvent:
    'start' name=ID (label=STRING)?;

EndEvent:
    'end' name=ID (label=STRING)?;

// UserTask with an optional typed attribute block. Attributes are modelled as a
// *list* of `Attribute` nodes (not named assignments) so duplicate keys remain
// visible in the AST. The duplicate-key validator reads `attrs` and flags
// repeated keys.
UserTask:
    'user' name=ID (label=STRING)? AttributeBlock?;

ServiceTask:
    'service' name=ID (label=STRING)? AttributeBlock?;

// fragment: a brace-delimited attribute block. Reused verbatim by UserTask and
// ServiceTask. The set of legal keys per element kind is enforced by the
// validator, not the grammar, so the same fragment serves both.
fragment AttributeBlock:
    '{' attrs+=Attribute* '}';

// A single attribute entry: `<key> = <expression>`. `key` is a fixed keyword,
// `value` is a full expression (so `assignee = "demo"` stores a RawExpr/literal
// and `class = com.example.X` stores a VarRef-shaped value). Duplicate keys are
// accepted by the parser and flagged by the validator.
Attribute:
    key=AttrKey '=' value=Expr;

// Attribute keys are the union across all element kinds. Keeping them in one
// datatype rule means the grammar accepts any key on any element; the validator
// restricts `assignee`/`formKey` to `user` and `class` to `service`.
AttrKey returns string:
    'assignee' | 'formKey' | 'class';

// if / else if / else → exclusive gateway (desugared by `astToIr`).
IfStatement:
    'if' '(' condition=Expr ')' then=Block
    (elseIfs+=ElseIf)*
    ('else' elseBlock=Block)?;

ElseIf:
    'else' 'if' '(' condition=Expr ')' body=Block;

// Pre-test loop → XOR gateway + back-edge (never standardLoopCharacteristics).
WhileStatement:
    'while' '(' condition=Expr ')' body=Block;

// Post-test loop → body runs first, then the conditioned back-edge.
DoWhileStatement:
    'do' body=Block 'while' '(' condition=Expr ')';

// parallel { { … } { … } } → AND fork/join. Each branch is a brace `Block`
// nested directly inside the outer `parallel { … }`; at least two branches are
// required (the first `Block` then one-or-more further `Block`s). The
// inclusive-gateway variant is not yet supported.
ParallelStatement:
    'parallel' '{' branches+=Block (branches+=Block)+ '}';

// goto <id> → explicit jump to any targetable statement, keyed on `name`.
GotoStatement:
    'goto' target=[Statement:ID];

// ── Expression sub-language (JUEL native subset) ────────────────────────────
//
// These are PARSER rules (never a terminal): the whole IDE value proposition
// (validation, hovers, jump-to-def) depends on conditions being a real AST,
// not an opaque string (thesis rule 15). Binary operators use Langium's
// left-associative tree-rewriting idiom `{infer X.left=current}` so a chain
// such as `a + b + c` builds a left-leaning tree rather than overwriting
// `left`/`right`. Precedence climbs ternary → logical-or → logical-and →
// equality → relational → additive → multiplicative → unary → primary.
//
// Each precedence level infers its OWN node type (`Logical`, `Equality`,
// `Relational`, `Additive`, `Multiplicative`) rather than a single shared
// `Binary`, so a consumer can distinguish a comparison from an arithmetic
// expression by `$type` (e.g. `amount > 1000` yields a `Relational` node). All
// five share the same `left`/`op`/`right` shape and the same `renderExpression`
// arm.

Expr:
    Ternary;

// Ternary `c ? t : f`. When no `?` follows, the node collapses to the
// underlying Or expression (no wrapper node) — Langium emits the inner type.
Ternary infers Expr:
    LogicalOr ({infer Ternary.condition=current} '?' whenTrue=LogicalOr ':' whenFalse=LogicalOr)?;

LogicalOr infers Expr:
    LogicalAnd ({infer Logical.left=current} op='||' right=LogicalAnd)*;

LogicalAnd infers Expr:
    Equality ({infer Logical.left=current} op='&&' right=Equality)*;

Equality infers Expr:
    Relational ({infer Equality.left=current} op=('=='|'!=') right=Relational)*;

Relational infers Expr:
    Additive ({infer Relational.left=current} op=('<='|'>='|'<'|'>') right=Additive)*;

Additive infers Expr:
    Multiplicative ({infer Additive.left=current} op=('+'|'-') right=Multiplicative)*;

Multiplicative infers Expr:
    Unary ({infer Multiplicative.left=current} op=('*'|'/'|'%') right=Unary)*;

// Unary `!x` / `-x`. With no operator the node collapses to the Primary.
Unary infers Expr:
    {infer Unary} op=('!'|'-') operand=Unary | Primary;

Primary infers Expr:
      LiteralInt
    | LiteralDecimal
    | LiteralString
    | LiteralBool
    | LiteralNull
    | VarRef
    | Paren
    | RawExpr;

// Integer literal. INT is a dedicated terminal so `1000` is a LiteralInt, not a
// VarRef. Decimal is matched first in Primary by ordering DECIMAL before INT in
// the lexer (DECIMAL is longer-match for `1.5`).
LiteralInt:
    value=INT;

LiteralDecimal:
    value=DECIMAL;

LiteralString:
    value=STRING;

LiteralBool:
    value=('true'|'false');

LiteralNull:
    value='null';

// A variable reference with zero or more dot-property / index accessors, e.g.
// `order`, `order.total`, `items[0]`, `map['k']`.
VarRef:
    name=ID (accessors+=Accessor)*;

Accessor:
    '.' prop=ID | '[' index=Expr ']';

Paren:
    '(' inner=Expr ')';

// Quoted "${…}" raw-string fallback. Valid anywhere an Expr is, this is the
// escape hatch for expressions outside the JUEL subset (method/bean calls,
// JUEL functions) and for variables that collide with reserved keywords. The
// renderer emits `raw` verbatim.
//
// A RawExpr is distinguished from a plain LiteralString purely by content: it
// is a quoted string whose body begins with `${`. The dedicated RAW_TEMPLATE
// terminal (declared before STRING) captures exactly that shape, so
// `assignee = "demo"` parses as a LiteralString while `if ("${bean.x()}")`
// parses as a RawExpr.
RawExpr:
    raw=RAW_TEMPLATE;

hidden terminal WS: /\s+/;

// ID accepts BPMN-style identifiers with internal hyphens (e.g.
// `invoice-approval`). A hyphen is allowed only between word characters, never
// trailing.
terminal ID: /[_a-zA-Z]\w*(-\w+)*/;

// DECIMAL must be declared before INT so the lexer prefers the longer match for
// `1.5`; INT then handles whole numbers.
terminal DECIMAL returns number: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;

// RAW_TEMPLATE: a quoted string whose body begins with `${` — the raw-expression
// fallback. Declared BEFORE STRING so a `"${…}"` body is lexed as RAW_TEMPLATE
// (→ RawExpr) rather than a plain STRING (→ LiteralString). The two regexes
// overlap on `"${…}"` input, so declaration order is what breaks the tie.
terminal RAW_TEMPLATE: /"\$\{(\\.|[^"\\])*"|'\$\{(\\.|[^'\\])*'/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
