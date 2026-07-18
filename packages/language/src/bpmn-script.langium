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
// Naming convention: the AST property `name`
// holds the DSL identifier used as the cross-reference *target* key. Every
// targetable statement therefore exposes `name=ID`, which is what lets
// `goto target=[Statement:ID]` resolve through Langium's default NameProvider.
// The human-readable BPMN label is carried in the separate `label` property
// (a quoted string after the id).
//
// Reserved words (cannot be used as a bare expression identifier; use the
// quoted "${…}" raw-string fallback if a variable must be named like one):
//   process, var, start, end, user, service, external, script, subprocess,
//   if, else, while, do, parallel, goto, label, assignee, formKey, class,
//   expression, delegate, topic, form,
//   call, in, out, local, binding, version, businessKey,
//   on, throw, emit, alongside,
//   string, number, boolean, date, json, any,
//   true, false, null.
// JUEL identifiers that do NOT collide with this set lex as plain `ID` in
// expression position and parse to `VarRef` as expected (e.g. `status`,
// `order.type`, `items[0]`).
//
// `error`, `escalation`, `message`, `signal`, `timer`, `condition`, and
// `compensation` (the trigger kinds an `on`/`throw`/`emit` names), `code` and
// the other catch-binding field names, and the timer particles
// `after`/`at`/`every` are
// deliberately NOT on this list: they lex as plain `ID` and are validated in
// position rather than reserved as keywords — so `var message: string`,
// `if (code == "x")`, `var timer: number`, `if (after > 2)`, and a step
// named `every` all stay legal everywhere else (see
// `OnHandler`/`EventBinding`/`ThrowStatement`/`EmitStatement`/`ErrorDecl`
// below).

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

// Process-scope declarations: the process-level label attribute, typed
// `var` declarations, and thrown-message declarations for error codes. Kept
// separate from executable statements.
ProcessDecl:
    ProcessLabel | VarDecl | ErrorDecl;

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
// `name=ID`. Compound statements (if/while/do-while/parallel/subprocess) nest
// further `Statement`s through `Block`s.
Statement:
      StartEvent | EndEvent
    | UserTask | ServiceTask | ExternalTask | ScriptTask
    | IfStatement | WhileStatement | DoWhileStatement
    | ParallelStatement | GotoStatement | SubProcess | CallActivity
    | OnHandler | ThrowStatement | EmitStatement;

// A brace-delimited list of statements (the body of if/else/while/do/parallel
// branches). The process body itself is an *implicit* block (no braces),
// handled inline by the Process rule above.
Block:
    '{' statements+=Statement* '}';

// StartEvent with an optional attribute block. Only a `form { … }` block is
// meaningful here (a start event has no assignee/class); the validator rejects
// bare attributes on `start`. The block lets an author declare the process's
// start variables as Tasklist form fields.
StartEvent:
    'start' name=ID (label=STRING)? AttributeBlock?;

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

// A service task delegated to an external worker. Shares the AttributeBlock
// shape with ServiceTask (so `topic` is just an attribute here); the validator
// requires exactly a `topic`. Emits a bpmn:serviceTask carrying
// operaton:type="external" and operaton:topic.
ExternalTask:
    'external' name=ID (label=STRING)? AttributeBlock?;

// A script task with an inline body written as a markdown-style fenced block
// opened by a language tag (```js … ```). The whole fenced block is captured
// verbatim in `body`; the language tag and script text are extracted
// downstream. Emits a bpmn:scriptTask.
ScriptTask:
    'script' name=ID (label=STRING)? body=FENCED_SCRIPT;

// fragment: a brace-delimited body block. Reused verbatim by StartEvent,
// UserTask, and ServiceTask. It holds a mix of `<key> = <value>` attributes and
// `form { … }` blocks in any order. Which members are legal per element kind is
// enforced by the validator, not the grammar, so the one fragment serves all
// three (a start event allows only a form; a service task allows no form).
fragment AttributeBlock:
    '{' (attrs+=Attribute | forms+=FormBlock)* '}';

// A form declaration: `form { <field>* }`. Maps to `operaton:formData` so
// Operaton Tasklist renders a labeled input per field. Modelled as a list on the
// owning element so the validator can flag a second `form` block as a duplicate.
FormBlock:
    'form' '{' fields+=FormField* '}';

// One form field: `<id>: <type> "<label>"? (= <default>)?`. `id` is the process
// variable the field reads or writes; it is deliberately not `name=ID` so a
// field and a `var` of the same id coexist (the validator checks their types
// agree) instead of colliding in the symbol table. `type` reuses `VarType`; the
// validator restricts it to the subset Operaton form fields support.
FormField:
    id=ID ':' type=VarType (label=STRING)? ('=' defaultValue=Expr)?;

// A single attribute entry: `<key> = <expression>`. `key` is a fixed keyword,
// `value` is a full expression (so `assignee = "demo"` stores a RawExpr/literal
// and `class = com.example.X` stores a VarRef-shaped value). Duplicate keys are
// accepted by the parser and flagged by the validator.
Attribute:
    key=AttrKey '=' value=Expr;

// Attribute keys are the union across all element kinds. Keeping them in one
// datatype rule means the grammar accepts any key on any element; the validator
// restricts `assignee`/`formKey` to `user` and `class` to `service`.
// `process`/`binding`/`version`/`businessKey` are the `call` attribute keys
// (`process` reuses the existing `process`-block keyword token — no new
// reserved word for it); the validator restricts them to `call`.
AttrKey returns string:
    'assignee' | 'formKey' | 'class' | 'expression' | 'delegate' | 'topic'
    | 'process' | 'binding' | 'version' | 'businessKey';

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

// A nested flow container: `subprocess <id> "<label>"? { <statements> }`. The
// body reuses `Block` verbatim, so `start`/`end` parse inside it exactly like
// at process scope (the desugarer synthesises them when absent and honours
// them when written). `name` is the goto-target key per the file's naming
// convention above, so a sequence flow targeting the sub-process by name
// resolves through the default NameProvider with no extra grammar machinery.
SubProcess:
    'subprocess' name=ID (label=STRING)? body=Block;

// A call to another process by id: `call <id> "<label>"? { <body> }`. The
// brace body mixes `<key> = <value>` attributes (see `AttrKey` above for the
// `process`/`binding`/`version`/`businessKey` keys legal here) with `in`/`out`
// variable mappings in any order, so it deliberately defines its own inline
// body instead of reusing the `AttributeBlock` fragment: `AttributeBlock` also
// admits a `form` block, which is meaningless on a call, and has no place to
// carry mappings at all. `name` is the goto-target key per the file's naming
// convention above, so a sequence flow into the call resolves through the
// default NameProvider like every other `Statement`. Which attribute keys are
// actually required (e.g. that `process` must be present) and whether the
// mapping list is well-formed is the validator's job, not the grammar's — the
// parser accepts any combination, including an empty body.
CallActivity:
    'call' name=ID (label=STRING)? '{' (attrs+=Attribute | mappings+=VariableMapping)* '}';

// One variable-mapping entry inside a `call` body, read like a function call at
// the process boundary: `in` carries a value INTO the called process (an
// argument), `out` carries a value back OUT to the caller (a return value). As
// with every `=` in this grammar, the left side is always the receiving name in
// the receiving scope — for `in` that is a variable of the called process, for
// `out` a variable of the caller. `source` is optional: shorthand `in x` /
// `out x` copies a variable under the same name (`target` doubles as the
// implied source when `source` is absent). `all='*'` copies every variable
// instead of naming one (`in *` / `out *`). A `local` mapping reads from /
// writes to variables that belong to the call step itself rather than to the
// whole process — rarely needed when authoring, kept chiefly so diagrams that
// use step-local variables import faithfully. The `*` keyword reuses the
// existing multiplication token from the expression sub-language below — no
// lexer change. Mapping well-formedness (e.g. `*` combined with `target`, or a
// `target` unknown in either scope) is validated downstream, not here.
VariableMapping:
    direction=('in'|'out') (local?='local')? (all?='*' | target=ID ('=' source=Expr)?);

// ── on / throw / emit — the DSL's try/catch ─────────────────────────────────
//
// `on <trigger>` is a catch block for one event kind: reads exactly like
// `catch (Exception e) { … }`, sitting at the end of the body it guards (a
// convention the validator enforces, not the grammar — see the file's
// per-rule notes below). `throw` always ends its path, like `throw` in every
// programming language; `emit` fires the event and keeps going — the one
// distinction between the two verbs, uniform across every event kind this
// DSL knows about. An `error … message …` declaration exists only for a code
// whose thrown message text needs recording once, at the process header.
//
// `trigger` (`error`/`escalation`/`message`/`signal`/`timer`/`condition`),
// each binding's `field` (`code`/`message`), the timer `particle`
// (`after`/`at`/`every`), and the declaration's `kind`/`field` all lex as
// plain `ID` rather than reserved keywords: they are among the most common
// variable names a Java-background author reaches for, so reserving them
// would make `var message: string` a parse error. Word legality at each of
// these positions — is `trigger` one of the known kinds? is `field` one of
// the known bindings? is `particle` one of the known timer forms? — is
// validated in position, exactly like every other semantic rule in this
// grammar that the parser itself stays silent about.

// A handler body reuses `Block` verbatim, so `start`/`end` and every other
// statement — including a nested `on` — parse inside it for free. The
// payload after `trigger` and the content of the parenthesized slot are
// shaped per trigger kind; the grammar accepts any combination (the parser
// stays silent about which shape actually belongs to which trigger — the
// validator polices that pairing), but the payload matrix each trigger is
// meant to carry is:
//   - `error` / `escalation` — an optional code and optional parenthesized
//     bindings, e.g. `on error "PAYMENT_FAILED" (code c, message m) { … }`.
//     Each binding pairs a field with the process variable it fills,
//     written as a declaration (`field variable`) mirroring
//     `catch (ExceptionType name)` rather than an assignment. An omitted
//     code means "catch any" of that trigger kind.
//   - `message` / `signal` — a required name and no parenthesized slot,
//     e.g. `on message "Invoice Received" { … }`. `message` reads like the
//     process's inbox: it runs when something outside the model delivers a
//     message carrying that name. `signal` is a broadcast channel: every
//     listener anywhere that names the same signal wakes up — unlike an
//     escalation, whose reach stops at the boundary of its own scope.
//   - `timer` — a particle (`after`/`at`/`every`) followed by a time
//     string in the same slot the code otherwise occupies, e.g.
//     `on timer after "PT1H" { … }`. `after` reads as "if this scope is
//     still running after this much time", `at` as "at this point in
//     time", and `every` as "on this repeating schedule" — the clock
//     starts when the surrounding scope starts.
//   - `condition` — no code or particle; instead the parenthesized slot
//     holds an expression that reads exactly like an `if` condition, e.g.
//     `on condition (amount > 100) { … }`. It is checked once when the
//     scope starts and again whenever a variable changes.
// The parenthesized slot therefore holds EITHER a binding list OR a
// condition expression, never both, decided purely by the shape of its
// content: a binding is always `field variable` — two adjacent
// identifiers — while the expression sub-language never places two
// identifiers next to each other (every operator level needs an operator
// token in between, and an accessor starts with `.`/`[`), so the parser
// tells the two apart from the second token onward without any extra
// keyword. `alongside` marks a non-interrupting handler: the guarded
// scope's main flow keeps running alongside this catch block instead of
// being interrupted by it.
OnHandler:
    'on' trigger=ID
    (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
    ('(' (bindings+=EventBinding (',' bindings+=EventBinding)* | condition=Expr) ')')?
    (alongside?='alongside')? body=Block;

// One catch-parameter binding inside an `on (…)` list — see `OnHandler`.
EventBinding:
    field=ID variable=ID;

// `throw <trigger> <name>? "<code>"?` — always terminal: this path ends here,
// exactly like `throw` in every programming language. `name` is the optional
// goto-target id (synthesized when omitted, like every other targetable
// statement). `code` names the error/escalation/signal being thrown; every
// trigger but `compensation` needs one to say which error/escalation/signal it
// is. `compensation` — the undo block for a subprocess's already-completed
// work — names nothing, so it carries no code at all. One token of lookahead
// is all a parser needs to place each optional member: `ID` predicts `name`,
// `STRING` predicts `code`, and anything else ends the statement (every
// statement in this grammar is keyword-led, so a following statement can
// never be swallowed as `name`).
ThrowStatement:
    'throw' trigger=ID (name=ID)? (code=STRING)?;

// `emit <trigger> <name>? "<code>"?` — fires the event and keeps going; the
// one difference from `throw` above. `code` names the escalation/signal being
// emitted; `compensation` — the undo block — names nothing, so it carries
// none, same as `throw compensation` above. Which trigger kinds actually have
// a continuing (non-terminal) form in BPMN is the validator's concern, not
// the grammar's.
EmitStatement:
    'emit' trigger=ID (name=ID)? (code=STRING)?;

// `<kind> "<code>" <field> "<text>"` — a process-header declaration, written
// alongside `var` declarations, for the one piece of event data usage alone
// cannot express: the message text a thrown error of this code carries.
// Only ever needed for a code whose `throw`/`on` sites should carry that
// text; `kind` and `field` are the same soft-word ID convention as above
// (written as `error … message …` for the one declaration this grammar
// currently has).
ErrorDecl:
    kind=ID code=STRING field=ID message=STRING;

// ── Expression sub-language (JUEL native subset) ────────────────────────────
//
// These are PARSER rules (never a terminal): the whole IDE value proposition
// (validation, hovers, jump-to-def) depends on conditions being a real AST,
// not an opaque string. Binary operators use Langium's
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

// FENCED_SCRIPT: a whole markdown-style fenced block opened by a language tag,
// e.g. ```js\n…\n```. The match spans the opening fence and tag, the verbatim
// body, and the closing fence — the tag/body split happens downstream, so the
// body stays opaque and code-like text such as `if (a) { }` is never lexed as
// DSL. `[\s\S]` matches across newlines without relying on a dotall flag; `*?`
// is non-greedy so the match ends at the FIRST closing ``` fence. Backtick is a
// fresh delimiter that cannot overlap the quote-delimited STRING / RAW_TEMPLATE
// terminals, so this declaration's position relative to them is immaterial; it
// sits here with the other content terminals for readability.
// This terminal has no delimiter between the tag and the body — a same-line
// fence such as ```jsfoo``` is captured as one unbroken letter run with an
// empty body, so the downstream split (`splitFencedScript`) must derive the
// boundary itself from the leading letter run and the newline that follows it.

terminal FENCED_SCRIPT: /```[a-zA-Z]+[\s\S]*?```/;

// RAW_TEMPLATE: a quoted string whose body begins with `${` — the raw-expression
// fallback. Declared BEFORE STRING so a `"${…}"` body is lexed as RAW_TEMPLATE
// (→ RawExpr) rather than a plain STRING (→ LiteralString). The two regexes
// overlap on `"${…}"` input, so declaration order is what breaks the tie.
terminal RAW_TEMPLATE: /"\$\{(\\.|[^"\\])*"|'\$\{(\\.|[^'\\])*'/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
