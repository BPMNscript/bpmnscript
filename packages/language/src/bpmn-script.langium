// The BPMNscript grammar: code-like structured statements.
//
// A process body is a sequence of statements that execute top-to-bottom
// (implicit sequence flow); control flow is expressed with `if`/`else if`/
// `else`, `while`, `do while`, `parallel { { } { } }`, and `goto <id>`.
// `start`/`end` are explicit-allowed but implicit by default (the desugarer
// synthesizes them). There is no flat node/edge surface and no `gateway`
// keyword: gateways are derived from the structured control-flow constructs.
//
// Design:
//   - Keyword + braces statements with implicit flow.
//   - Typed-per-element attribute blocks, modeled as a *list* of attribute
//     nodes so a validator can detect duplicate keys from the AST.
//   - A JUEL-subset expression sub-language parsed to a real AST (parser
//     rules, never a terminal), with a quoted "${...}" raw-string fallback.
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
// quoted "${...}" raw-string fallback if a variable must be named like one):
//   process, var, start, end, user, service, script, subprocess,
//   step, send, receive, decide,
//   if, else, while, do, parallel, goto, label, form,
//   call, in, out, local,
//   on, throw, emit, alongside, await,
//   for, each, sequentially, until,
//   string, number, boolean, date, json, any,
//   true, false, null.
// JUEL identifiers that do NOT collide with this set lex as plain `ID` in
// expression position and parse to `VarRef` as expected (e.g. `status`,
// `order.type`, `items[0]`).
//
// The trigger kinds (`error`, `escalation`, `message`, `signal`, `timer`,
// `condition`, `compensation`, `terminate`), the catch-binding field names, the timer
// particles `after`/`at`/`every`, the attribute keys, the parameter direction
// words, and the listener event words are deliberately NOT on this list: they
// lex as plain `ID` and are validated in position instead, so `var message:
// string`, `if (after > 2)`, and `if (priority > 5)` stay legal, and a step may
// be named after any business concept.
//
// `step`/`send`/`receive`/`decide` are hard for a different reason than the
// trigger words above: a soft statement keyword would let `step` after
// `start S` be swallowed as `start`'s trigger instead of opening its own
// statement, so these four stay hard like every other statement-opening word.
//
// `for`/`each`/`sequentially`/`until` are hard for a related reason: the
// repeat clause opens in a position no other construct occupies, between a
// statement's optional label and its optional settings block, so only a
// keyword can announce that a clause has started.

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// A process: `process <id> "<label>"? { <header> <statements> }`. The header
// carries process-scope declarations (the optional `label` attribute and
// any `var` declarations); the remaining statements form the implicit block
// body. Declarations are gathered into `decls`, executable statements into
// `body`, so the desugarer and the validator can address them independently.
Process:
    'process' name=ID (label=STRING)? '{'
        (decls+=ProcessDecl)*
        body+=Statement*
    '}';

// Process-scope declarations: the process-level label attribute, typed
// `var` declarations, thrown-message declarations for error codes, and the
// process-level settings written as `<key> = <value>`. Kept separate from
// executable statements.
ProcessDecl:
    ProcessLabel | VarDecl | ErrorDecl | ProcessAttribute;

// Process-level label attribute, e.g. `label = "Invoice Approval"`. Stored as
// its own node so the validator can flag a duplicate `label`.
ProcessLabel:
    'label' '=' value=STRING;

// A process-level setting written like an element attribute, e.g.
// `versionTag = "1.4"`. `label` keeps its own rule above, so the validator
// restricts this key set to the settings that belong on the process element.
// `ID '='` separates it from `ErrorDecl` (`ID STRING ...`) at the second token,
// and every statement is keyword-led, so a declaration can never swallow one.
ProcessAttribute:
    key=AttrKey '=' value=Expr;

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
    | UserTask | ServiceTask | ScriptTask
    | GenericTask | SendTask | ReceiveTask | BusinessRuleTask
    | IfStatement | WhileStatement | DoWhileStatement
    | ParallelStatement | GotoStatement | SubProcess | CallActivity
    | OnHandler | ThrowStatement | EmitStatement | IntermediateCatchEvent;

// A brace-delimited list of statements (the body of if/else/while/do/parallel
// branches). The process body itself is an *implicit* block (no braces),
// handled inline by the Process rule above.
Block:
    '{' statements+=Statement* '}';

// StartEvent with an optional trigger clause and attribute block. The trigger
// clause is the one `on` and `await` already use: a soft trigger word followed
// by a message or signal name, or by a timer particle and its time. Only the
// process's own start carries one; a subprocess start and an event-handler
// start are entered by their container, and the validator rejects a trigger
// there. `name=ID` is mandatory and comes first, so the second token decides
// everything: a STRING there is the label, an ID is the trigger, and `{` opens
// the settings block. Every statement is keyword-led, so a following statement
// can never be swallowed as a trigger.
StartEvent:
    'start' name=ID (label=STRING)?
    (trigger=ID (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?)?
    AttributeBlock?;

// EndEvent with the same clause narrowed to a word and an optional code.
// `terminate` and `cancel` are the words this position takes; the code slot
// exists so a kind that belongs on `throw` still parses and earns a validator
// message instead of a parse error.
EndEvent:
    'end' name=ID (label=STRING)? (trigger=ID (code=STRING)?)? AttributeBlock?;

// UserTask with an optional typed attribute block. Attributes are modeled as a
// *list* of `Attribute` nodes (not named assignments) so duplicate keys remain
// visible in the AST. The duplicate-key validator reads `attrs` and flags
// repeated keys.
UserTask:
    'user' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// A service task binds to exactly one of four execution forms: `class`, a
// JUEL `expression`, a `delegate` expression, or a `topic`. The last delegates
// the work to an external worker that polls the engine for that topic instead
// of the engine invoking code directly. All four share this one statement and
// AttributeBlock shape; the validator requires exactly one.
ServiceTask:
    'service' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// A step the engine records and passes straight through; the work happens
// outside it.
GenericTask:
    'step' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// An activity that sends something out. It binds exactly as a service task
// does, because the engine runs it the same way.
SendTask:
    'send' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// An activity that waits for a named message, or for the engine to be told to
// continue when no name is given.
ReceiveTask:
    'receive' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// An activity answered by a decision table, or bound like a service task when
// it is not.
BusinessRuleTask:
    'decide' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// A script task with an inline body written as a markdown-style fenced block
// opened by a language tag. The whole fenced block is captured
// verbatim in `body`; the language tag and script text are extracted
// downstream. Emits a bpmn:scriptTask.
ScriptTask:
    'script' name=ID (label=STRING)? RepeatClause? AttributeBlock? body=FENCED_SCRIPT;

// fragment: a brace-delimited settings block, reused by every statement that
// takes one. It holds a mix of `<key> = <value>` attributes, `form` blocks,
// `input`/`output` parameters, and lifecycle listeners, in any order. Which
// members are legal per element kind is enforced by the validator, not the
// grammar, so the one fragment serves them all (a start event allows only a
// form and the engine settings; a service task allows no form).
//
// On a statement that also has a body, the block comes BEFORE the body. The two
// never collide: no statement starts with a plain identifier, so an identifier
// after the opening brace can only be a settings member, and the empty block
// `{ }` is told apart from an empty body by the brace that follows it.
fragment AttributeBlock:
    '{' (attrs+=Attribute | forms+=FormBlock | params+=IoParameter | listeners+=Listener)* '}';

// How many times an activity runs. `for each line in lines` runs it once per
// element, binding each element to `line`; `for 3` runs it a fixed number of
// times; writing both lets the count drive the runs while each still sees its
// element. The element name is optional, for a collection that drives the count
// and nothing else. Instances run at once unless `sequentially` says otherwise,
// and `until` stops the remaining ones early once its condition holds.
//
// `for` is hard for the same reason every statement keyword is, and `each`,
// `sequentially` and `until` with it: the clause sits between a statement's
// optional label and its optional settings block, so nothing but a keyword can
// tell the parser a clause has started. `in` is already hard.
fragment RepeatClause:
    'for' (
        cardinality=Expr ('each' (element=ID)? 'in' collection=Expr)?
      | 'each' (element=ID)? 'in' collection=Expr
    )
    (sequential?='sequentially')?
    ('until' '(' completion=Expr ')')?;

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

// A single attribute entry: `<key> = <expression>`. `value` is a full
// expression (so `assignee = "demo"` stores a RawExpr/literal and
// `class = com.example.X` stores a VarRef-shaped value). Duplicate keys are
// accepted by the parser and flagged by the validator.
Attribute:
    key=AttrKey '=' value=Expr;

// An attribute key is a soft word: it lexes as a plain `ID` and is checked in
// position by the validator, which knows the key set of each element kind. That
// keeps every attribute name available as a step name, a variable name, and a
// bare identifier in expression position, so `if (priority > 5)` and
// `user class { ... }` stay legal, and an unknown key gets a validation message
// naming the element instead of a lexer complaint.
//
// `process` is listed explicitly because the `process` block heading makes it a
// keyword token that never lexes as `ID`; without the literal, `call C { process
// = "x" }` would fail at the `=`.
AttrKey returns string:
    ID | 'process';

// One `input`/`output` parameter entry: `<direction> <name> = <value>`.
// `direction` is a soft word for the same reason an attribute key is, so a step
// may still be named `input`. Two adjacent identifiers separate a parameter from
// an attribute (`<key> =`) at the second token.
//
// The value language is wider than an attribute's: a parameter may carry a
// nested list or map structure, or an inline script, none of which an
// expression can express.
IoParameter:
    direction=ID name=ID '=' value=IoValue;

// A parameter value: an ordinary expression, a nested structure, or an inline
// script. `[` and `{` uniquely predict a list and a map, since no expression
// starts with either, so `items[0]` on the right of a parameter still parses as
// an accessor.
IoValue:
    Expr | ListLiteral | MapLiteral | ScriptLiteral;

// An ordered list of values, `[a, b]`. A trailing comma is rejected.
ListLiteral:
    '[' (items+=IoValue (',' items+=IoValue)*)? ']';

// A keyed map of values, `{ k: v, "other key": w }`. A trailing comma is
// rejected.
MapLiteral:
    '{' (entries+=MapEntry (',' entries+=MapEntry)*)? '}';

MapEntry:
    key=MapKey ':' value=IoValue;

// A map key is a bare word or a quoted string; the quoted form carries keys that
// are not identifier-shaped.
MapKey returns string:
    ID | STRING;

// An inline script as a parameter value, written with the same fenced block a
// script task uses, so the language tag travels with the code.
ScriptLiteral:
    body=FENCED_SCRIPT;

// An engine lifecycle callback registered on the enclosing element:
// `on <event> { <binding> }` or `on <event> ```<lang> ... ``` . A `timeout`
// callback additionally carries a timer clause, written with the same particle
// syntax a timer event uses.
//
// This reuses the `on` word from the statement layer: at statement position `on`
// catches a BPMN event and opens a handler body, inside a settings block it
// registers a callback. The binding block is spelled out here rather than
// reusing the `AttributeBlock` fragment, so a callback cannot nest a form, a
// parameter, or another callback.
Listener:
    'on' event=ListenerEvent
    (particle=ID time=(STRING | RAW_TEMPLATE))?
    (script=FENCED_SCRIPT | '{' attrs+=Attribute* '}');

// The event word is soft, as every position-checked word in this grammar is.
// `start` and `end` are named explicitly because the statements of the same name
// make them keyword tokens that never lex as `ID`.
ListenerEvent returns string:
    ID | 'start' | 'end';

// if / else if / else -> exclusive gateway (desugared by `astToIr`).
IfStatement:
    'if' '(' condition=Expr ')' then=Block
    (elseIfs+=ElseIf)*
    ('else' elseBlock=Block)?;

ElseIf:
    'else' 'if' '(' condition=Expr ')' body=Block;

// Pre-test loop -> XOR gateway + back-edge (never standardLoopCharacteristics).
WhileStatement:
    'while' '(' condition=Expr ')' body=Block;

// Post-test loop -> body runs first, then the conditioned back-edge.
DoWhileStatement:
    'do' body=Block 'while' '(' condition=Expr ')';

// parallel -> AND fork/join. Each branch is a brace `Block` nested directly
// inside the outer `parallel` block; at least two branches are required (the
// first `Block` then one-or-more further `Block`s). The inclusive-gateway
// variant is not yet supported.
ParallelStatement:
    'parallel' '{' branches+=Block (branches+=Block)+ '}';

// goto <id> -> explicit jump to any targetable statement, keyed on `name`.
GotoStatement:
    'goto' target=[Statement:ID];

// A nested flow container: `subprocess <id> "<label>"? { <statements> }`. The
// body reuses `Block` verbatim, so `start`/`end` parse inside it exactly like
// at process scope (the desugarer synthesizes them when absent and honors
// them when written). An optional settings block precedes the body.
//
// `attempt` is the same container marked as a block of work that may be given
// up. It serializes to `bpmn:transaction`, the only tag under which Operaton
// accepts a `cancel` end or a `cancel` handler; Operaton's `BpmnParse` gives
// that tag the same behavior class as an embedded sub-process, so nothing
// rolls back on its own and the two heads share one rule and one node type.
SubProcess:
    (transactional?='attempt' | 'subprocess') name=ID (label=STRING)? RepeatClause? AttributeBlock? body=Block;

// A call to another process by id: `call <id> "<label>"? { <body> }`. The brace
// body mixes attributes, `in`/`out` variable mappings, `input`/`output`
// parameters, and listeners in any order, so it defines its own inline body
// rather than reusing the `AttributeBlock` fragment: that fragment admits a
// `form` block, meaningless on a call, and has no place to carry mappings.
// `in`/`out` are keyword tokens while `input`/`output` lex as identifiers, so
// the two member kinds never collide. The parser accepts any combination,
// including an empty body; which keys are required is the validator's job.
CallActivity:
    'call' name=ID (label=STRING)? RepeatClause? '{' (attrs+=Attribute | mappings+=VariableMapping | params+=IoParameter | listeners+=Listener)* '}';

// One variable-mapping entry inside a `call` body, read like a function call at
// the process boundary: `in` carries a value into the called process, `out`
// carries one back to the caller. As with every `=` in this grammar, the left
// side is the receiving name in the receiving scope. Omitting `source` copies a
// variable under the same name, and `all='*'` copies every variable instead of
// naming one. A `local` mapping reads and writes variables belonging to the
// call step itself rather than the whole process, which matters chiefly so
// diagrams using step-local variables import faithfully. The `*` keyword
// reuses the multiplication token from the expression sub-language below, so no
// lexer change. Mapping well-formedness is validated downstream, not here.
VariableMapping:
    direction=('in'|'out') (local?='local')? (all?='*' | target=ID ('=' source=Expr)?);

// ── on / throw / emit: the DSL's try/catch ──────────────────────────────────
//
// `on <trigger>` is a catch block for one event kind, sitting at the end of
// the body it guards. `throw` always ends its path; `emit` fires the event and
// keeps going. An `error` declaration records, once at the process header, the
// message text a thrown error of that code carries.
//
// A handler body reuses `Block` verbatim, so `start`/`end` and every other
// statement, a nested `on` included, parse inside it for free. The grammar
// accepts any payload with any trigger; which shapes actually pair is the
// validator's job.
//
// The parenthesized slot holds either a binding list or a condition
// expression, never both, decided purely by the shape of its content: a
// binding is always two adjacent identifiers (`field variable`), while the
// expression sub-language never places two identifiers next to each other
// (every operator level needs an operator token between them, and an accessor
// starts with `.`/`[`). The parser therefore tells the two apart from the
// second token onward without an extra keyword.
//
// The optional `host` slot names the single step the handler attaches to, so
// `on Review: timer after "PT2H"` catches only while `Review` is running
// instead of guarding the whole surrounding body. The separator has to be a
// colon and cannot be omitted: `on Pack error "X"` and `on timer after "X"`
// are both `ID ID STRING` at the token level, since trigger words and timer
// particles lex as plain identifiers. Nothing in the token types separates a
// host from a trigger, so no amount of lookahead can tell the forms apart;
// the colon decides at token 2.
OnHandler:
    'on' (host=[Statement:ID] ':')? trigger=ID
    (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
    ('(' (bindings+=EventBinding (',' bindings+=EventBinding)* | condition=Expr) ')')?
    (alongside?='alongside')? AttributeBlock? body=Block;

// One catch-parameter binding inside an `on` parenthesized list. It is written
// as a declaration (`field variable`) mirroring `catch (ExceptionType name)`,
// not as an assignment.
EventBinding:
    field=ID variable=ID;

// `throw <trigger> <name>? "<code>"?`, always terminal: this path ends here.
// `name` is the optional goto-target id, synthesized when omitted. `code`
// names the error, escalation, or signal being thrown. One token of lookahead
// places each optional member: `ID` predicts `name`, `STRING` predicts `code`,
// and anything else ends the statement (every statement in this grammar is
// keyword-led, so a following statement can never be swallowed as `name`).
ThrowStatement:
    'throw' trigger=ID (name=ID)? (code=STRING)? AttributeBlock?;

// `emit <trigger> <name>? "<code>"?` fires the event and keeps going, the one
// difference from `throw` above. Which trigger kinds have a continuing form in
// BPMN is the validator's concern, not the grammar's.
EmitStatement:
    'emit' trigger=ID (name=ID)? (code=STRING)? AttributeBlock?;

// `await <trigger> <payload>` blocks the main flow: the token pauses here
// until the named trigger fires, then continues to the next statement. The
// payload shape per trigger mirrors `OnHandler`'s.
//
// There is no name slot; the goto-target id is always synthesized. A `name=ID`
// slot would collide with the timer particle at the token level, since
// `await timer after "PT1H"` and `await <name> timer` are both `ID ID
// ID/STRING`, and the parser cannot tell which `ID` after `trigger` is which
// without a keyword to separate them.
IntermediateCatchEvent:
    'await' trigger=ID
    (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
    ('(' condition=Expr ')')? AttributeBlock?;

// `<kind> "<code>" <field> "<text>"`, a process-header declaration written
// alongside `var` declarations, for the one piece of event data usage alone
// cannot express: the message text a thrown error of this code carries.
// `kind` and `field` follow the same soft-word ID convention as above.
ErrorDecl:
    kind=ID code=STRING field=ID message=STRING;

// ── Expression sub-language (JUEL native subset) ────────────────────────────
//
// These are PARSER rules (never a terminal): the whole IDE value proposition
// (validation, hovers, jump-to-def) depends on conditions being a real AST,
// not an opaque string. Binary operators use Langium's
// left-associative tree-rewriting idiom `{infer X.left=current}` so a chain
// such as `a + b + c` builds a left-leaning tree rather than overwriting
// `left`/`right`. Precedence climbs ternary -> logical-or -> logical-and ->
// equality -> relational -> additive -> multiplicative -> unary -> primary.
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
// underlying Or expression (no wrapper node): Langium emits the inner type.
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

// Quoted "${...}" raw-string fallback. Valid anywhere an Expr is, this is the
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

// FENCED_SCRIPT: a whole markdown-style fenced block opened by a language tag.
// The match spans the opening fence and tag, the verbatim body, and the closing
// fence, with the tag/body split happening downstream, so the body stays opaque
// and code-like text such as `if (a) { }` is never lexed as DSL. `[\s\S]`
// matches across newlines without relying on a dotall flag; `*?` is non-greedy
// so the match ends at the FIRST closing fence. Backtick is a fresh delimiter
// that cannot overlap the quote-delimited STRING / RAW_TEMPLATE terminals, so
// this declaration's position relative to them is immaterial.
//
// There is no delimiter between the tag and the body: a same-line fence is
// captured as one unbroken letter run with an empty body, so the downstream
// split must derive the boundary itself from the leading letter run and the
// newline that follows it.

terminal FENCED_SCRIPT: /```[a-zA-Z]+[\s\S]*?```/;

// RAW_TEMPLATE: a quoted string whose body begins with `${`, the raw-expression
// fallback. Declared BEFORE STRING so such a body is lexed as RAW_TEMPLATE
// (-> RawExpr) rather than a plain STRING (-> LiteralString). The two regexes
// overlap on that input, so declaration order is what breaks the tie.
terminal RAW_TEMPLATE: /"\$\{(\\.|[^"\\])*"|'\$\{(\\.|[^'\\])*'/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
