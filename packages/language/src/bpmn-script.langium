// The BPMNscript grammar: code-like structured statements.
//
// A process body is a sequence of statements executing top-to-bottom (implicit
// sequence flow); control flow is `if`/`else if`/`else`, `while`, `do while`,
// `parallel`, `await { ... }`, and `goto <id>`. `start`/`end` may be written but
// are synthesized by the desugarer when absent. There is no flat node/edge
// surface and no `gateway` keyword: gateways are derived from the structured
// constructs.
//
// The AST property `name` holds the DSL identifier used as the cross-reference
// target key, which is what lets `goto target=[Statement:ID]` resolve through
// Langium's default NameProvider. The human-readable BPMN label is the separate
// `label` property.
//
// Reserved words are exactly this file's keywords, read back out of the grammar
// by `reservedWordsOf` in `vocabulary.ts`; a variable named like one is written
// with the quoted "${...}" raw-string fallback. The trigger kinds, catch-binding
// fields, timer particles, attribute keys, parameter directions, and listener
// events are deliberately soft: they lex as plain `ID` and are checked in
// position, so `var message: string` and `if (priority > 5)` stay legal and a
// step may be named after any business concept. A statement-opening word cannot
// be soft, because after `start S` it would be swallowed as `start`'s trigger
// rather than opening its own statement.

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// `process <id> "<label>"? { <header> <statements> }`. Declarations are gathered
// into `decls` and executable statements into `body`, so the desugarer and the
// validator can address them independently.
Process:
    'process' name=ID (label=STRING)? '{'
        (decls+=ProcessDecl)*
        body+=Statement*
    '}';

ProcessDecl:
    ProcessLabel | VarDecl | ErrorDecl | ProcessAttribute;

// Its own node, so the validator can flag a duplicate `label`.
ProcessLabel:
    'label' '=' value=STRING;

// A process-level setting written like an element attribute, `versionTag =
// "1.4"`. `ID '='` separates it from `ErrorDecl` (`ID STRING ...`) at the second
// token, and every statement is keyword-led, so it can never swallow one.
ProcessAttribute:
    key=AttrKey '=' value=Expr;

// `VarType` is aligned with Operaton's variable types.
VarDecl:
    'var' name=ID ':' type=VarType;

VarType returns string:
    'string' | 'number' | 'boolean' | 'date' | 'json' | 'any';

// Every concrete subtype that is a jump target exposes `name=ID`.
Statement:
      StartEvent | EndEvent
    | UserTask | ServiceTask | ScriptTask
    | GenericTask | SendTask | ReceiveTask | BusinessRuleTask
    | IfStatement | WhileStatement | DoWhileStatement
    | ParallelStatement | GotoStatement | SubProcess | CallActivity
    | OnHandler | ThrowStatement | EmitStatement | AwaitStatement;

// The process body is an implicit block with no braces, handled by `Process`.
Block:
    '{' statements+=Statement* '}';

// The trigger clause is the one `on` and `await` use. Only the process's own
// start carries one; every other start is entered by its container and the
// validator rejects a trigger there. `name=ID` is mandatory and first, so the
// second token decides: STRING is the label, ID the trigger, `{` the settings
// block. Every statement is keyword-led, so one can never be swallowed here.
StartEvent:
    'start' name=ID (label=STRING)?
    (trigger=ID (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?)?
    AttributeBlock?;

// The same clause narrowed to a word and an optional code. The code slot exists
// so a kind belonging on `throw` still parses and earns a validator message
// rather than a parse error.
EndEvent:
    'end' name=ID (label=STRING)? (trigger=ID (code=STRING)?)? AttributeBlock?;

UserTask:
    'user' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// Every execution form shares this one statement shape; the validator requires
// exactly one binding attribute.
ServiceTask:
    'service' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// A step the engine records and passes straight through; the work happens
// outside it.
GenericTask:
    'step' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// Binds as a service task does: the engine runs it the same way.
SendTask:
    'send' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// Waits for a named message, or to be told to continue when no name is given.
ReceiveTask:
    'receive' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// Answered by a decision table, or bound like a service task when it is not.
BusinessRuleTask:
    'decide' name=ID (label=STRING)? RepeatClause? AttributeBlock?;

// The whole fenced block is captured verbatim in `body`; the language tag and
// the script text are split downstream.
ScriptTask:
    'script' name=ID (label=STRING)? RepeatClause? AttributeBlock? body=FENCED_SCRIPT;

// The settings block every statement that takes one reuses. Which members are
// legal per element kind is the validator's business, not the grammar's, so one
// fragment serves them all.
//
// On a statement that also has a body the block comes first, and the two never
// collide: no statement starts with a plain identifier, so an identifier after
// the opening brace can only be a settings member, and an empty block is told
// apart from an empty body by the brace that follows it.
//
// Attributes are a *list* of `Attribute` nodes rather than named assignments,
// so a duplicate key stays visible in the AST for the validator to flag.
fragment AttributeBlock:
    '{' (attrs+=Attribute | forms+=FormBlock | params+=IoParameter | listeners+=Listener)* '}';

// How many times an activity runs. `for each line in lines` runs it once per
// element bound to `line`, `for 3` a fixed number of times, and both together
// lets the count drive the runs while each still sees its element. Instances run
// at once unless `sequentially` says otherwise, and `until` stops the remaining
// ones early once its condition holds.
//
// These four words are hard: the clause sits between a statement's optional
// label and its optional settings block, a position nothing else occupies, so
// only a keyword can tell the parser a clause has started. `in` is already hard.
fragment RepeatClause:
    'for' (
        cardinality=Expr ('each' (element=ID)? 'in' collection=Expr)?
      | 'each' (element=ID)? 'in' collection=Expr
    )
    (sequential?='sequentially')?
    ('until' '(' completion=Expr ')')?;

// Maps to `operaton:formData`, which Operaton Tasklist renders as a labeled
// input per field. A list on the owning element, so a second block is flaggable.
FormBlock:
    'form' '{' fields+=FormField* '}';

// `id` is the process variable the field reads or writes, deliberately not
// `name=ID` so a field and a `var` of the same id coexist instead of colliding
// in the symbol table. `type` reuses `VarType`; the validator restricts it to
// the subset Operaton form fields support.
FormField:
    id=ID ':' type=VarType (label=STRING)? ('=' defaultValue=Expr)?;

// `value` is a full expression, so `assignee = "demo"` stores a literal and
// `class = com.example.X` a VarRef-shaped value.
Attribute:
    key=AttrKey '=' value=Expr;

// A soft word, so every attribute name stays available as a step name, a
// variable name, and a bare identifier in expression position.
//
// `process` is listed explicitly because the `process` block heading makes it a
// keyword token that never lexes as `ID`; without the literal, `call C { process
// = "x" }` would fail at the `=`.
AttrKey returns string:
    ID | 'process';

// `<direction> <name> = <value>`, where `direction` is soft as an attribute key
// is. Two adjacent identifiers separate a parameter from an attribute
// (`<key> =`) at the second token. The value language is wider than an
// attribute's: a nested list or map, or an inline script.
IoParameter:
    direction=ID name=ID '=' value=IoValue;

// `[` and `{` uniquely predict a list and a map, since no expression starts with
// either, so `items[0]` on the right of a parameter is still an accessor.
IoValue:
    Expr | ListLiteral | MapLiteral | ScriptLiteral;

// An ordered list of values, `[a, b]`. A trailing comma is rejected.
ListLiteral:
    '[' (items+=IoValue (',' items+=IoValue)*)? ']';

// `{ k: v, "other key": w }`. A trailing comma is rejected.
MapLiteral:
    '{' (entries+=MapEntry (',' entries+=MapEntry)*)? '}';

MapEntry:
    key=MapKey ':' value=IoValue;

// The quoted form carries keys that are not identifier-shaped.
MapKey returns string:
    ID | STRING;

// The same fenced block a script task uses, so the tag travels with the code.
ScriptLiteral:
    body=FENCED_SCRIPT;

// An engine lifecycle callback on the enclosing element, `on <event> { ... }`;
// a `timeout` one also carries a timer clause. The `on` word is the statement
// layer's: at statement position it catches a BPMN event, inside a settings
// block it registers a callback. The binding block is spelled out rather than
// reusing `AttributeBlock`, so a callback cannot nest a form, a parameter, or
// another callback.
Listener:
    'on' event=ListenerEvent
    (particle=ID time=(STRING | RAW_TEMPLATE))?
    (script=FENCED_SCRIPT | '{' attrs+=Attribute* '}');

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

// parallel -> AND fork/join, or an OR fork/join when any branch carries a
// condition. An unheaded branch always runs, a conditioned one when its
// condition holds, and the `else` branch only when none held; left out, that
// fallback goes straight to the join.
ParallelStatement:
    'parallel' '{' branches+=ParallelBranch (branches+=ParallelBranch)+ '}';

// `if` and `else` are already keywords, so the head costs no reserved word.
ParallelBranch:
    ('if' '(' condition=Expr ')' | otherwise?='else')? body=Block;

// goto <id> -> explicit jump to any targetable statement, keyed on `name`.
GotoStatement:
    'goto' target=[Statement:ID];

// A nested flow container whose body reuses `Block`, so `start`/`end` parse
// inside it exactly as at process scope.
//
// `attempt` is the same container marked as work that may be given up. It
// serializes to `bpmn:transaction`, the only tag under which Operaton accepts a
// `cancel` end or handler; `BpmnParse` gives that tag the same behavior class as
// an embedded sub-process, so nothing rolls back on its own and the two heads
// share one rule and one node type.
SubProcess:
    (transactional?='attempt' | 'subprocess') name=ID (label=STRING)? RepeatClause? AttributeBlock? body=Block;

// A call to another process by id. The body is inline rather than the
// `AttributeBlock` fragment, which admits a `form` block, meaningless on a call,
// and has no place to carry mappings. `in`/`out` are keyword tokens while
// `input`/`output` lex as identifiers, so the two member kinds never collide.
CallActivity:
    'call' name=ID (label=STRING)? RepeatClause? '{' (attrs+=Attribute | mappings+=VariableMapping | params+=IoParameter | listeners+=Listener)* '}';

// Read like a function call at the process boundary: `in` carries a value into
// the called process, `out` carries one back. As with every `=` here, the left
// side is the receiving name in the receiving scope; omitting `source` copies a
// variable under the same name and `all='*'` copies every variable. A `local`
// mapping reads and writes variables belonging to the call step rather than the
// whole process. The `*` keyword reuses the multiplication token below, so the
// lexer is unchanged.
VariableMapping:
    direction=('in'|'out') (local?='local')? (all?='*' | target=ID ('=' source=Expr)?);

// `on <trigger>` is a catch block for one event kind, sitting at the end of the
// body it guards; `throw` ends its path and `emit` keeps going. The grammar
// accepts any payload with any trigger; which shapes pair is the validator's job.
//
// The parenthesized slot holds a binding list or a condition expression, never
// both, decided by the shape of its content: a binding is two adjacent
// identifiers (`field variable`), and the expression sub-language never places
// two identifiers next to each other, since every operator level needs an
// operator token between them and an accessor starts with `.`/`[`.
//
// The optional `host` names the single step the handler attaches to, so
// `on Review: timer after "PT2H"` catches only while `Review` runs. The colon
// cannot be omitted: `on Pack error "X"` and `on timer after "X"` are both
// `ID ID STRING` at the token level, so no amount of lookahead tells the forms
// apart and the colon has to decide at token 2.
OnHandler:
    'on' (host=[Statement:ID] ':')? trigger=ID
    (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
    ('(' (bindings+=EventBinding (',' bindings+=EventBinding)* | condition=Expr) ')')?
    (alongside?='alongside')? AttributeBlock? body=Block;

// Written as a declaration mirroring `catch (ExceptionType name)`, not as an
// assignment.
EventBinding:
    field=ID variable=ID;

// `name` is the optional goto-target id, synthesized when omitted. One token of
// lookahead places each optional member: `ID` predicts `name`, `STRING` predicts
// `code`, and anything else ends the statement, since every statement is
// keyword-led and can never be swallowed as `name`.
ThrowStatement:
    'throw' trigger=ID (name=ID)? (code=STRING)? AttributeBlock?;

// Fires the event and keeps going, the one difference from `throw` above.
EmitStatement:
    'emit' trigger=ID (name=ID)? (code=STRING)? AttributeBlock?;

// `await` blocks the main flow in one of two shapes, told apart by the token
// after the keyword.
//
// `await <trigger> <payload>` pauses until the trigger fires, then continues.
// There is no name slot: it would collide with the timer particle, since
// `await timer after "PT1H"` and `await <name> timer` are both `ID ID ID/STRING`
// and nothing separates the two `ID`s after `trigger`.
//
// `await { ... }` waits on several triggers at once and continues down the one
// that fires first; the others are cancelled.
//
// One rule for both shapes, so the keyword commits the parser before the payload
// is read: with a rule apiece a mistyped payload leaves no viable alternative
// and the parser blames `await`, the token the author got right. The inferred
// node types stay separate, so each keeps its own validator entry and lowering.
AwaitStatement:
    'await' (
        {infer IntermediateCatchEvent}
        trigger=ID
        (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
        ('(' condition=Expr ')')? AttributeBlock?
      | {infer RaceStatement}
        '{' branches+=RaceBranch (branches+=RaceBranch)+ '}'
    );

// `IntermediateCatchEvent`'s header plus a body, the two told apart as a
// subprocess tells them apart: no statement starts with a plain identifier.
RaceBranch:
    trigger=ID
    (code=STRING | particle=ID time=(STRING | RAW_TEMPLATE))?
    ('(' condition=Expr ')')?
    AttributeBlock? body=Block;

// `<kind> "<code>" <field> "<text>"`, for the one piece of event data usage
// alone cannot express: the message text a thrown error of this code carries.
ErrorDecl:
    kind=ID code=STRING field=ID message=STRING;

// The expression sub-language, a JUEL native subset.
//
// These are parser rules and never a terminal: validation, hovers, and
// jump-to-def all depend on a condition being a real AST rather than an opaque
// string. Binary operators use Langium's left-associative tree-rewriting idiom
// `{infer X.left=current}`, so `a + b + c` builds a left-leaning tree rather
// than overwriting `left`/`right`.
//
// Each precedence level infers its own node type rather than one shared
// `Binary`, so a consumer can tell a comparison from an arithmetic expression by
// `$type`. All five share the `left`/`op`/`right` shape and one render arm.

Expr:
    Ternary;

// With no `?` the node collapses to the underlying Or expression: Langium emits
// the inner type rather than a wrapper.
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

// A dedicated terminal, so `1000` is a LiteralInt rather than a VarRef.
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

// `order`, `order.total`, `items[0]`, `map['k']`.
VarRef:
    name=ID (accessors+=Accessor)*;

Accessor:
    '.' prop=ID | '[' index=Expr ']';

Paren:
    '(' inner=Expr ')';

// The escape hatch for expressions outside the JUEL subset and for variables
// colliding with a keyword, valid anywhere an Expr is; the renderer emits `raw`
// verbatim. It is told apart from a plain LiteralString purely by content, a
// quoted string whose body begins with `${`, which the RAW_TEMPLATE terminal
// captures.
RawExpr:
    raw=RAW_TEMPLATE;

hidden terminal WS: /\s+/;

// BPMN-style identifiers with internal hyphens (`invoice-approval`); a hyphen is
// allowed only between word characters, never trailing.
terminal ID: /[_a-zA-Z]\w*(-\w+)*/;

// DECIMAL must be declared before INT so the lexer prefers the longer match for
// `1.5`; INT then handles whole numbers.
terminal DECIMAL returns number: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;

// A whole markdown-style fenced block opened by a language tag, matched as one
// token so the body stays opaque and code-like text such as `if (a) { }` is
// never lexed as DSL. `[\s\S]` matches across newlines without a dotall flag
// and `*?` ends the match at the first closing fence. Nothing delimits the tag
// from the body, so the downstream split derives that boundary from the leading
// letter run and the newline after it.

terminal FENCED_SCRIPT: /```[a-zA-Z]+[\s\S]*?```/;

// Declared before STRING: the two regexes overlap on a body beginning with
// `${`, so declaration order is what makes that input a RawExpr.
terminal RAW_TEMPLATE: /"\$\{(\\.|[^"\\])*"|'\$\{(\\.|[^'\\])*'/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
