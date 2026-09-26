// The BPMNscript grammar. A process body is a sequence of statements running
// top to bottom, so sequence flow is never written; gateways come from the
// structured statements and there is no `gateway` keyword.
//
// The AST property `name` is the cross-reference key, which is what lets
// `goto target=[Statement:ID]` resolve through Langium's default NameProvider;
// the BPMN label is the separate `label` setting.
//
// Reserved words are exactly this file's keywords (`reservedWordsOf` in
// `vocabulary.ts` reads them back out); a variable named like one is written
// with the quoted "${...}" raw-string fallback. The trigger kinds, catch-binding
// fields, timer particles, setting keys, parameter directions, the `enum` form
// type and listener events are soft: they lex as plain `ID` and are checked in
// position, so `var message: string` and `if (priority > 5)` stay legal. A
// statement-opening word cannot be soft, because after `start S` it would be
// swallowed as `start`'s trigger rather than opening its own statement.

grammar BpmnScript

entry Model:
    (processes+=Process)*;

// Declarations go into `decls` and statements into `body`, so the desugarer
// and the validator address them apart.
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

// The trigger clause is the one `on` and `await` use; only the process's own
// start carries one, and the validator rejects it elsewhere. `name=ID` is
// mandatory and first, so the second token decides: ID is the trigger, `(` the
// settings, `{` the member block. Every statement is keyword-led, so one can
// never be swallowed here.
StartEvent:
    'start' name=ID (trigger=ID)? SettingsParens? AttributeBlock?;

// Any trigger word parses here, so a kind belonging on `throw` earns a
// validator message rather than a parse error.
EndEvent:
    'end' name=ID (trigger=ID)? SettingsParens? AttributeBlock?;

UserTask:
    'user' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// One shape for every execution form; the validator requires exactly one
// binding attribute.
ServiceTask:
    'service' name=ID RepeatClause? SettingsParens? AttributeBlock?;

GenericTask:
    'step' name=ID RepeatClause? SettingsParens? AttributeBlock?;

SendTask:
    'send' name=ID RepeatClause? SettingsParens? AttributeBlock?;

ReceiveTask:
    'receive' name=ID RepeatClause? SettingsParens? AttributeBlock?;

BusinessRuleTask:
    'decide' name=ID RepeatClause? SettingsParens? AttributeBlock?;

// The fence is one token; the language tag and the script text are split
// downstream.
ScriptTask:
    'script' name=ID RepeatClause? SettingsParens? AttributeBlock? body=FENCED_SCRIPT;

// The member block holds what an element is built from; the settings it runs
// under go in the parens. Which members each kind takes is the validator's
// business, so one fragment serves them all. On a statement that also has a
// body the block comes first, and the two never collide: no statement starts
// with a plain identifier, so an identifier after the brace can only be a
// member, and an empty block is told from an empty body by the brace that
// follows it. A parameter and a mapping, the two members opening with an
// identifier, are told apart at the third token.
fragment AttributeBlock:
    '{' (forms+=FormBlock | params+=IoParameter | listeners+=Listener | errorMappings+=ErrorMapping)* '}';

// `error PaymentDeclined when <condition>`. Both words are soft: `when` is
// told from a parameter's `=` at the third token, so the line costs no
// reserved word.
ErrorMapping:
    trigger=ID code=[CodeDecl:ID] when=ID condition=Expr;

// `for each line in lines`, `for 3`, or both together with the count driving
// the runs. The four words are hard: the clause sits between a statement's
// name and its optional settings, a position nothing else occupies, so only a
// keyword can tell the parser a clause has started. `in` is already hard.
fragment RepeatClause:
    'for' (
        cardinality=Expr ('each' (element=ID)? 'in' collection=Expr)?
      | 'each' (element=ID)? 'in' collection=Expr
    )
    (sequential?='sequentially')?
    ('until' '(' completion=Expr ')')?;

// A list on the owning element, so a second block is flaggable.
FormBlock:
    'form' '{' fields+=FormField* '}';

// `id`, not `name=ID`, so a field and a `var` of the same id coexist instead
// of colliding in the symbol table. The block cannot be read as the next
// field, which opens with `ID ':'`; its two member shapes are told apart at
// the third token (`=`).
FormField:
    id=ID ':' type=FormFieldType (label=STRING)? ('=' defaultValue=Expr)?
    SettingsParens?
    ('{' (values+=EnumValue | params+=IoParameter)* '}')?;

// Open beyond `VarType` because `enum` is not a `var` type and a soft word
// keeps `var enum: string` legal; the validator holds the word to
// `FORM_FIELD_TYPES`.
FormFieldType returns string:
    VarType | ID;

// One line per value an `enum` offers, in the order the engine keeps them
// (`FormTypes.parseFormPropertyType` fills a LinkedHashMap).
EnumValue:
    id=ID (label=STRING)?;

// A payload sits first and unkeyed, a setting carries `key: value`, and a flag
// is a bare word; `:` makes a setting, a flag word is a keyword no expression
// can start with, and anything else is a plain value. At least one item: an
// element with no settings carries no parens, and requiring one keeps a stray
// word inside them a no-viable-alternative error, which reads as the
// reserved-word explanation rather than a missing `)`.
fragment SettingsParens:
    '(' items+=ParenItem (',' items+=ParenItem)* ')';

ParenItem:
      {infer Setting} key=ParenKey ':' value=Expr
    | {infer Flag} flag=FlagWord
    | {infer ParenValue} value=Expr;

// `process` is listed because the `process` heading makes it a keyword token
// that never lexes as `ID`; without it, `call C(process: "x")` would fail at
// the `:`.
ParenKey returns string:
    ID | 'process';

// Each flag word is a keyword that never lexes as `ID`, so the words writable
// here are named rather than accepted by shape. Naming `alongside` alone would
// make the other two a parse error instead of a diagnostic saying which
// element they are not valid on.
FlagWord returns string:
    'alongside' | 'sequentially' | 'local';

IoParameter:
    direction=ID name=ID '=' value=IoValue;

// `[` and `{` predict a list and a map, since no expression starts with
// either, so `items[0]` on the right of a parameter is still an accessor.
IoValue:
    Expr | ListLiteral | MapLiteral | ScriptLiteral;

// A trailing comma is rejected.
ListLiteral:
    '[' (items+=IoValue (',' items+=IoValue)*)? ']';

MapLiteral:
    '{' (entries+=MapEntry (',' entries+=MapEntry)*)? '}';

MapEntry:
    key=MapKey ':' value=IoValue;

// The quoted form carries keys that are not identifier-shaped.
MapKey returns string:
    ID | STRING;

ScriptLiteral:
    body=FENCED_SCRIPT;

// `on` at statement position catches a BPMN event; inside a member block it
// registers a lifecycle callback, `on <event>(class: "...")`, a `timeout` one
// also carrying a timer clause. Its block holds parameters alone, so a
// callback nests neither a form nor another callback, and cannot be read as
// the next member: nothing else a member block holds starts with `{`.
Listener:
    'on' event=ListenerEvent
    (particle=ID time=(STRING | RAW_TEMPLATE))?
    SettingsParens?
    script=FENCED_SCRIPT?
    ('{' params+=IoParameter* '}')?;

// `start` and `end` are keyword tokens that never lex as `ID`, so they are
// named here.
ListenerEvent returns string:
    ID | 'start' | 'end';

// One exclusive gateway per chain, so the parens after the condition hold the
// split's settings and, `join`-prefixed, the join's, and an `else if` head
// takes none.
IfStatement:
    'if' '(' condition=Expr ')' SettingsParens? then=Block
    (elseIfs+=ElseIf)*
    ('else' elseBlock=Block)?;

ElseIf:
    'else' 'if' '(' condition=Expr ')' body=Block;

// An XOR gateway and a back-edge, never standardLoopCharacteristics. One
// gateway, so the parens take no `join` spelling; the validator says so.
WhileStatement:
    'while' '(' condition=Expr ')' SettingsParens? body=Block;

DoWhileStatement:
    'do' body=Block 'while' '(' condition=Expr ')' SettingsParens?;

// An AND fork and join, or an OR pair when any branch carries a condition.
// The parens after the keyword hold the fork's settings and, `join`-prefixed,
// the join's; a branch head takes none.
ParallelStatement:
    'parallel' SettingsParens? '{' branches+=ParallelBranch (branches+=ParallelBranch)+ '}';

ParallelBranch:
    ('if' '(' condition=Expr ')' | otherwise?='else')? body=Block;

GotoStatement:
    'goto' target=[Statement:ID];

// `attempt` is the same container marked as work that may be given up. It
// serializes to `bpmn:transaction`, the only tag under which Operaton accepts a
// `cancel` end or handler; `BpmnParse` gives that tag the same behavior class
// as an embedded sub-process, so the two heads share one rule and one node
// type.
SubProcess:
    (transactional?='attempt' | 'subprocess') name=ID RepeatClause? SettingsParens? AttributeBlock? body=Block;

// The member block is inline rather than `AttributeBlock`, which admits a
// `form` block and has no place for mappings. `in`/`out` are keyword tokens
// while `input`/`output` lex as identifiers, so the two member kinds never
// collide.
CallActivity:
    'call' name=ID RepeatClause? SettingsParens? ('{' (mappings+=VariableMapping | params+=IoParameter | listeners+=Listener)* '}')?;

// The left side is the receiving name in the receiving scope; omitting
// `source` copies a variable under the same name and `all='*'` copies every
// variable. The `*` keyword reuses the multiplication token below.
VariableMapping:
    direction=('in'|'out') (local?='local')? (all?='*' | target=ID ('=' source=Expr)?);

// A catch block for one event kind. Any payload parses with any trigger, and a
// catch binding, `error(X, code: c)`, is a setting carrying a bare name that
// nothing in the shape marks as a declaration; which shapes pair and which
// settings bind are the validator's job. The colon after an optional `host`
// decides at token 2 that the first word is a host rather than the trigger,
// before either reading of `on Pack error` has to be committed to.
OnHandler:
    'on' (host=[Statement:ID] ':')? trigger=ID
    SettingsParens? AttributeBlock? body=Block;

// `name` is the optional goto-target id, synthesized when omitted. `ID`
// predicts it and anything else ends the statement, since every statement is
// keyword-led and can never be swallowed as `name`.
ThrowStatement:
    'throw' trigger=ID (name=ID)? SettingsParens? AttributeBlock?;

EmitStatement:
    'emit' trigger=ID (name=ID)? SettingsParens? AttributeBlock?;

// Two shapes told apart by the token after the keyword: an `ID` is the trigger
// of the single catch, `(` or `{` opens the race. One rule for both, so the
// keyword commits the parser before the payload is read: with a rule apiece a
// mistyped payload leaves no viable alternative and the parser blames `await`,
// the token the author got right. The inferred node types stay separate, so
// each keeps its own validator entry and lowering. A `RaceBranch` is not a
// statement and carries no name, so nothing can `goto` one branch of a race;
// the parens before the block hold the gateway's settings and, `join`-prefixed,
// the join's.
AwaitStatement:
    'await' (
        {infer IntermediateCatchEvent}
        trigger=ID (name=ID)? SettingsParens? AttributeBlock?
      | {infer RaceStatement}
        SettingsParens? '{' branches+=RaceBranch (branches+=RaceBranch)+ '}'
    );

// A catch header plus a body, told apart as a subprocess tells them apart: no
// statement starts with a plain identifier.
RaceBranch:
    trigger=ID SettingsParens? AttributeBlock? body=Block;

// `error OUT_OF_STOCK(message: "Out of stock")` declares the name every code
// site refers to; the message is the one piece of event data usage cannot
// express, since two throws of a code share one root element. `kind` is soft,
// so `var error: string` and `on error` keep working; no statement can be
// swallowed here, since every statement opens with a hard keyword.
CodeDecl:
    kind=ID name=ID SettingsParens?;

// The expression sub-language, a JUEL native subset, as parser rules rather
// than a terminal: validation, hover and jump-to-definition all need a real
// AST. Binary operators use Langium's left-associative idiom
// `{infer X.left=current}`, so `a + b + c` builds a left-leaning tree. Each
// precedence level infers its own node type, so a consumer tells a comparison
// from an arithmetic expression by `$type`; all five share the
// `left`/`op`/`right` shape.

Expr:
    Ternary;

// With no `?` the node collapses to the inner expression rather than a wrapper.
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

// A variable, `order.total`, and the bare word a code-carrying event names,
// `throw error(OUT_OF_STOCK)`, in one rule: `error(OUT_OF_STOCK)` and
// `condition(ready)` are the same tokens inside the same `SettingsParens`, and
// a cross-reference alternative in `ParenItem` makes Chevrotain report
// ambiguous alternatives and parse the condition as a reference. So every
// identifier in every expression is a reference, `BpmnScriptScopeProvider`
// resolves it only in a code position, and `BpmnScriptDocumentValidator` drops
// the link failure everywhere else.
VarRef:
    ref=[CodeDecl:ID] (accessors+=Accessor)*;

Accessor:
    '.' prop=ID | '[' index=Expr ']';

Paren:
    '(' inner=Expr ')';

// The escape hatch for expressions outside the JUEL subset and for variables
// colliding with a keyword, told from a LiteralString by content alone: a
// quoted string opening with `${` or `#{`, the two openers the engine
// evaluates.
RawExpr:
    raw=RAW_TEMPLATE;

hidden terminal WS: /\s+/;

// A hyphen is allowed only between word characters (`invoice-approval`), never
// trailing.
terminal ID: /[_a-zA-Z]\w*(-\w+)*/;

// DECIMAL must be declared before INT so the lexer prefers the longer match for
// `1.5`; INT then handles whole numbers.
terminal DECIMAL returns number: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;

// One token, so code-like text such as `if (a) { }` inside the fence is never
// lexed as DSL; `[\s\S]*?` matches across newlines up to the first closing
// fence. Nothing delimits the tag from the body, so the downstream split takes
// the leading letter run as the tag.
terminal FENCED_SCRIPT: /```[a-zA-Z]+[\s\S]*?```/;

// Before STRING: the two regexes overlap on a body opening with `${` or `#{`,
// and declaration order is what makes that input a RawExpr.
terminal RAW_TEMPLATE: /"[$#]\{(\\.|[^"\\])*"|'[$#]\{(\\.|[^'\\])*'/;

terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
