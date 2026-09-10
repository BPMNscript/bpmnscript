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
// fields, timer particles, setting keys, parameter directions, and listener
// events are deliberately soft: they lex as plain `ID` and are checked in
// position, so `var message: string` and `if (priority > 5)` stay legal and a
// step may be named after any business concept. A statement-opening word cannot
// be soft, because after `start S` it would be swallowed as `start`'s trigger
// rather than opening its own statement.

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// `process <id>(<settings>)? { <header> <statements> }`. Declarations are
// gathered into `decls` and executable statements into `body`, so the desugarer
// and the validator can address them independently.
Process:
    'process' name=ID SettingsParens? '{'
        (decls+=ProcessDecl)*
        body+=Statement*
    '}';

ProcessDecl:
    VarDecl | CodeDecl;

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
    '{' (statements+=Statement | listeners+=Listener | params+=IoParameter)* '}';

// The trigger clause is the one `on` and `await` use. Only the process's own
// start carries one; every other start is entered by its container and the
// validator rejects a trigger there. `name=ID` is mandatory and first, so the
// second token decides: ID is the trigger, `(` the settings, `{` the member
// block. Every statement is keyword-led, so one can never be swallowed here.
StartEvent:
    'start' name=ID (trigger=ID)? SettingsParens? AttributeBlock?;

// The same clause. The grammar admits any trigger word here, so a kind
// belonging on `throw` earns a validator message rather than a parse error.
EndEvent:
    'end' name=ID (trigger=ID)? SettingsParens? AttributeBlock?;

UserTask:
    'user' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// Every execution form shares this one statement shape; the validator requires
// exactly one binding attribute.
ServiceTask:
    'service' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// A step the engine records and passes straight through; the work happens
// outside it.
GenericTask:
    'step' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// Binds as a service task does: the engine runs it the same way.
SendTask:
    'send' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// Waits for a named message, or to be told to continue when no name is given.
ReceiveTask:
    'receive' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// Answered by a decision table, or bound like a service task when it is not.
BusinessRuleTask:
    'decide' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// The whole fenced block is captured verbatim in `body`; the language tag and
// the script text are split downstream.
ScriptTask:
    'script' name=ID RepeatClause? SettingsParens? AttributeBlock? body=FENCED_SCRIPT;

// The member block every statement that takes one reuses. Its members are the
// parts an element is built from rather than the settings it runs under: those
// go in the parens. Which members are legal per element kind is the validator's
// business, not the grammar's, so one fragment serves them all.
//
// On a statement that also has a body the block comes first, and the two never
// collide: no statement starts with a plain identifier, so an identifier after
// the opening brace can only be a member, and an empty block is told apart from
// an empty body by the brace that follows it.
fragment AttributeBlock:
    '{' (forms+=FormBlock | params+=IoParameter | listeners+=Listener)* '}';

// How many times an activity runs. `for each line in lines` runs it once per
// element bound to `line`, `for 3` a fixed number of times, and both together
// lets the count drive the runs while each still sees its element. Instances run
// at once unless `sequentially` says otherwise, and `until` stops the remaining
// ones early once its condition holds.
//
// These four words are hard: the clause sits between a statement's name and its
// optional settings, a position nothing else occupies, so only a keyword can
// tell the parser a clause has started. `in` is already hard.
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

// The settings list every element shares. A payload sits first and unkeyed, a
// setting carries `key: value`, and a flag is a bare word. The three are told
// apart by the token after the first: `:` makes a setting, a flag word is a
// keyword no expression can start with, and anything else is a plain value.
// At least one item: an element with no settings carries no parens at all, and
// requiring one keeps a stray word inside them a no-viable-alternative error,
// which reads as the reserved-word explanation rather than a missing `)`.
fragment SettingsParens:
    '(' items+=ParenItem (',' items+=ParenItem)* ')';

ParenItem:
      {infer Setting} key=ParenKey ':' value=Expr
    | {infer Flag} flag=FlagWord
    | {infer ParenValue} value=Expr;

// A soft word, so every setting name stays available as a step name, a variable
// name, and a bare identifier in expression position.
//
// `process` is listed explicitly because the `process` block heading makes it a
// keyword token that never lexes as `ID`; without the literal, `call C(process:
// "x")` would fail at the `:`.
ParenKey returns string:
    ID | 'process';

// A flag is bare to a reader but not to the lexer: each of these is a keyword
// and never lexes as `ID`, so the words writable here are named rather than
// accepted by shape. Which of them an element actually takes is the validator's
// business; naming `alongside` alone would make the other two a parse error
// instead of a diagnostic saying which element they are not valid on.
FlagWord returns string:
    'alongside' | 'sequentially' | 'local';

// `<direction> <name> = <value>`, where `direction` is soft as a setting key
// is. The value language is wider than a setting's: a nested list or map, or an
// inline script.
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

// An engine lifecycle callback on the enclosing element, `on <event>(class:
// "...")`; a `timeout` one also carries a timer clause. The `on` word is the
// statement layer's: at statement position it catches a BPMN event, inside a
// member block it registers a callback. A callback carries settings and an
// optional inline script and nothing else, so it can nest neither a form, nor a
// parameter, nor another callback.
Listener:
    'on' event=ListenerEvent
    (particle=ID time=(STRING | RAW_TEMPLATE))?
    SettingsParens?
    script=FENCED_SCRIPT?;

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
    (transactional?='attempt' | 'subprocess') name=ID RepeatClause? SettingsParens? AttributeBlock? body=Block;

// A call to another process by id. The member block is inline rather than the
// `AttributeBlock` fragment, which admits a `form` block, meaningless on a call,
// and has no place to carry mappings. `in`/`out` are keyword tokens while
// `input`/`output` lex as identifiers, so the two member kinds never collide.
CallActivity:
    'call' name=ID RepeatClause? SettingsParens? ('{' (mappings+=VariableMapping | params+=IoParameter | listeners+=Listener)* '}')?;

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
// The parenthesized items hold the payload, the catch bindings and the flags at
// once. A catch binding is a `code:`/`message:` setting carrying a bare name,
// `error(X, code: c)`, which declares that name instead of reading it; nothing
// in the shape says so, and the validator is what tells the two apart.
//
// The optional `host` names the single step the handler attaches to, so
// `on Review: timer("PT2H")` catches only while `Review` runs. The colon is
// what says the first word is a host rather than the trigger, and it decides at
// token 2, before either reading of `on Pack error` has to be committed to.
OnHandler:
    'on' (host=[Statement:ID] ':')? trigger=ID
    SettingsParens? AttributeBlock? body=Block;

// `name` is the optional goto-target id, synthesized when omitted. One token of
// lookahead places it: `ID` predicts `name`, and anything else ends the
// statement, since every statement is keyword-led and can never be swallowed
// as `name`.
ThrowStatement:
    'throw' trigger=ID (name=ID)? SettingsParens? AttributeBlock?;

// Fires the event and keeps going, the one difference from `throw` above.
EmitStatement:
    'emit' trigger=ID (name=ID)? SettingsParens? AttributeBlock?;

// `await` blocks the main flow in one of two shapes, told apart by the token
// after the keyword.
//
// `await <trigger>` pauses until the trigger fires, then continues. There is no
// name slot: `await <name> <trigger>` and `await <trigger>` both open with an
// identifier and nothing marks which reading is meant, so the id is synthesized.
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
        trigger=ID SettingsParens? AttributeBlock?
      | {infer RaceStatement}
        '{' branches+=RaceBranch (branches+=RaceBranch)+ '}'
    );

// `IntermediateCatchEvent`'s header plus a body, the two told apart as a
// subprocess tells them apart: no statement starts with a plain identifier.
RaceBranch:
    trigger=ID SettingsParens? AttributeBlock? body=Block;

// `error OUT_OF_STOCK(message: "Out of stock")`: an element like any other,
// declaring the name a `throw error(...)` or an `on error(...)` refers to. The
// message it carries is the one piece of event data usage alone cannot express,
// since two throws of a code share one root element.
//
// `kind` is soft, so `var error: string` and `on error` keep working, and which
// words it accepts is the validator's business. The other header declaration
// opens with `var`, and no statement can be swallowed here, since every
// statement opens with a hard keyword.
CodeDecl:
    kind=ID name=ID SettingsParens?;

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

// `order`, `order.total`, `items[0]`, `map['k']`, and the bare word a
// code-carrying event names, `throw error(OUT_OF_STOCK)`.
//
// One rule for both, because nothing tells them apart at this level:
// `error(OUT_OF_STOCK)` and `condition(ready)` are the same tokens inside the
// same `SettingsParens`, and a cross-reference alternative in `ParenItem` makes
// Chevrotain report ambiguous alternatives and parse the condition as a
// reference. So every identifier in every expression is a reference, and what
// separates a code from a variable is the scope `BpmnScriptScopeProvider`
// resolves it in: the enclosing process's declarations in a code position, and
// nothing anywhere else. A reference that was never meant to resolve is dropped
// by `BpmnScriptDocumentValidator` before it becomes a diagnostic.
VarRef:
    ref=[CodeDecl:ID] (accessors+=Accessor)*;

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
