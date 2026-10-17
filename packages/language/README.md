# @bpmn-script/language

The language reference for BPMNscript, and the Langium package that implements it: grammar, parser, AST, validator, and language server.

The grammar in [`src/bpmn-script.langium`](src/bpmn-script.langium) decides what parses.
[Langium](https://langium.org/) generates the parser, the AST types, and a language server (highlighting, completion, hover, navigation, rename, inline diagnostics) from it; `npm run build` regenerates that code, and none of it is checked in.
The validator, [`src/bpmn-script-validator.ts`](src/bpmn-script-validator.ts), adds the rules a grammar can't express, such as "a service task needs exactly one binding" or "a variable must be used as its declared type".

The rest of this page teaches the language from the first process to the event layer, then lists the diagnostics and the package's own API and layout.

## A first process

```bpmnscript
process invoice-approval {
  var amount: number

  start ReviewStart
  user ReviewInvoice(assignee: "demo")
  if (amount > 1000) {
    user SeniorApproval(assignee: "manager")
  } else {
    service AutoApprove(class: "com.example.AutoApproveDelegate")
  }
  end Done
}
```

A file holds one process, which compiles to one `bpmn:process`.
A second `process` in the same file is an error.
Steps run top to bottom, so sequence flow is never written: control flow comes from structured statements such as `if`, `while` and `parallel`.
Declarations (`var` and the event codes) go at the top of the body, before the first statement.
`//` starts a line comment and `/* ... */` a block comment.

Every element has the same shape ([ADR-0011](../../docs/decisions/0011-structured-grammar-one-bracket-shape.md)): a keyword, a name, then optional parens holding its settings, then optional braces holding what it is built from.
`user ReviewInvoice(assignee: "demo")` has settings and no braces; a form, parameters and listeners go in the braces.

## Names and labels

A name is ASCII: a letter or `_`, then letters, digits and `_`, with single hyphens allowed between such runs (`invoice-approval`, never `Review-`).
A name that form cannot spell, such as a keyword or `Task.1`, is written in backticks: `` user `Task.1` ``, `` goto `end` ``.
The backticks are not part of the name, so `` `Review` `` and `Review` are one name, and a backslash takes the next character literally, so `` `a\`b` `` names ``a`b``.
A step's name becomes its BPMN id, so even in backticks it holds only letters, digits, `_`, `-` and `.`, starting with a letter or `_`.
An event code's name is no id and takes any text on one line: ``error `Payment failed`(code: "PF")``, thrown as ``throw error(`Payment failed`)``.
A `field` or `property` key takes any text in backticks as well: ``property `true` = "yes"``.
A variable has no backtick form; see [Variables](#variables).
A step name is unique within the process, a step can't share the process's id, and a name can't match a pattern the compiler synthesizes ids from, its own or the diagram's `_di`, `BPMNDiagram_`, and `BPMNPlane_` ids ([ADR-0010](../../docs/decisions/0010-deterministic-synthesized-ids.md)).

A step, a call and a sub-process take their diagram name from their id, so `ReviewInvoice` shows as "Review Invoice".
A `label` setting replaces it: `user ReviewInvoice(label: "Review invoice")`.
A `start` and an `end` show a name only when they carry a `label`, and `on`, `throw`, `emit` and `await` take no `label` and show none, except a link event, which shows its link name.

`documentation` attaches free-form text to the element, spelled like `label`: `user ReviewInvoice(documentation: "Escalate above 1000.")`.
A value inside an element is documented by a key named for the word that introduces it:

- `conditionDocumentation` on any condition: `if (amount > 1000, conditionDocumentation: "Large amounts need a second look.")`, and the same after `else if`, `while`, `do ... while`, a `parallel` branch's `if`, an `until (...)`, and `start S condition(...)`.
- `timerDocumentation` on a timer: `await timer("PT1H", timerDocumentation: "...")`, `on timeout after "PT8H"(class: "a.B", timerDocumentation: "...")`.
- `countDocumentation` and `eachDocumentation` on a repetition: `user R for 3 each line in lines(countDocumentation: "...", eachDocumentation: "...")`.

## Variables

`var <name>: <type>` declares a process variable so its uses get type-checked.
The types are `string`, `number`, `boolean`, `date`, `json`, and `any`.
Reading a variable nothing declares draws a warning, and declaring one twice is an error.
Using a declared variable where its type cannot fit, as a condition or an operand of `<`, `<=`, `>`, `>=`, arithmetic, `&&` or `||`, is an error; `==` and `!=` are not checked.
A form field, a catch binding, a parameter and a repetition's element declare a variable as well, and the repetition variables listed under [Repetition](#repetition) need no declaration.
The importer declares `var x: any` for every variable a printed script reads and nothing else declares ([ADR-0015](../../docs/decisions/0015-the-print-declares-every-variable-it-reads.md)).

A variable named like a reserved word, such as `process`, is written as the raw expression `"${process}"`.
A name that ends up in an engine expression can't be a JUEL reserved word or contain a hyphen; the reserved words are `empty`, `div`, `mod`, `not`, `and`, `or`, `le`, `lt`, `eq`, `ne`, `ge`, `gt`, and `instanceof`, plus the literals `true`, `false`, and `null`.
The same words are refused as a property read inside a `"${...}"` template, such as `"${order.and}"`.

## Expressions

Conditions are parsed into a real expression tree over a subset of JUEL, the engine's expression language:

- integer, decimal, string, boolean, and `null` literals,
- variable references with `.property` and `[index]` accessors,
- unary `!` and `-`, arithmetic, comparison, `&&` and `||`, the ternary `? :`, and parentheses.

Anything outside that subset is written as a quoted raw template, `"${...}"` or `"#{...}"`, passed to the engine as written.
A raw template uses the escapes of a string literal, so `"${fn(\"a\")}"` is the expression `${fn("a")}` ([ADR-0032](../../docs/decisions/0032-expressions-raw-templates-and-escapes.md)).
A condition whose static type is not boolean is an error, and so is a template with two `${...}` parts, such as `"${a} ${b}"`, used as an operand.
`on condition(...)` and `await condition(...)` use the same grammar and the same checks as `if`.

## Statements

| Statement                                                                                 | What it does                                                       | BPMN element                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| [`process X(...) { }`](#the-process-header)                                               | the process                                                        | `bpmn:process`                                               |
| [`var x: number`](#variables)                                                             | declares a variable for type checking                              | none                                                         |
| `start X` / `end X`                                                                       | where the flow begins and ends                                     | start event / end event                                      |
| [`start X <trigger>(...)`](#starting-on-an-event)                                         | starts the process when an event arrives                           | start event with a trigger                                   |
| [`end X terminate`](#ending-every-path)                                                   | stops every running path                                           | terminate end event                                          |
| [`end X cancel`](#giving-a-block-of-work-up)                                              | gives up the `attempt` block around it                             | cancel end event                                             |
| [`user X(...)`](#user-tasks)                                                              | a step a person performs                                           | user task                                                    |
| [`service X(...)`](#service-tasks)                                                        | a step the system performs                                         | service task                                                 |
| [`script X` + a fenced body](#script-tasks)                                               | an inline script                                                   | script task                                                  |
| `step X(...)`                                                                             | a step nothing in the engine automates                             | task                                                         |
| [`send X(...)`](#send-receive-and-decision-tasks)                                         | a step that sends something out                                    | send task                                                    |
| [`receive X(...)`](#send-receive-and-decision-tasks)                                      | waits for a message                                                | receive task                                                 |
| [`decide X(...)`](#send-receive-and-decision-tasks)                                       | a step a decision table answers                                    | business rule task                                           |
| [`if (c) { } else if (c) { } else { }`](#decisions-and-loops)                             | runs one branch                                                    | exclusive gateway                                            |
| [`else fail`](#stopping-when-no-condition-holds)                                          | stops the run with an error when no condition holds                | no default flow                                              |
| [`while (c) { }`](#decisions-and-loops)                                                   | checks before each pass                                            | exclusive gateway loop                                       |
| [`do { } while (c)`](#decisions-and-loops)                                                | runs the body once before the first check                          | exclusive gateway loop                                       |
| [`parallel { { } { } }`](#conditioning-a-parallel-branch)                                 | runs branches at the same time, optionally conditioned             | parallel gateways, or inclusive when a branch is conditioned |
| [`goto X`](#what-goto-can-reach)                                                          | jumps to a named step in the same container                        | sequence flow                                                |
| [`subprocess X(...) { }`](#sub-processes)                                                 | groups steps into one unit                                         | embedded sub-process                                         |
| [`attempt X(...) { }`](#giving-a-block-of-work-up)                                        | a group of steps that can be given up as one                       | transaction sub-process                                      |
| [`call X(...) { }`](#call-activities)                                                     | starts another process and waits for it                            | call activity                                                |
| [`on <trigger> { }`](#the-event-layer)                                                    | catches an event anywhere in the surrounding body                  | event sub-process                                            |
| [`on Host: <trigger> { }`](#attaching-a-handler-to-one-step)                              | catches an event while `Host` runs                                 | boundary event                                               |
| [`await <trigger>(...)`](#awaiting-an-event-inline)                                       | waits here until the event arrives                                 | intermediate catch event                                     |
| [`await { <trigger>(...) { } <trigger>(...) { } }`](#waiting-on-several-triggers-at-once) | waits on several triggers and continues down whichever fires first | event-based gateway                                          |
| [`throw <trigger>(...)` / `emit <trigger>(...)`](#the-event-layer)                        | raises an event and ends the path, or raises it and continues      | throw event                                                  |
| [`emit link(...)` / `await link(...)`](#link-events)                                      | jumps to the catch of the same name                                | link throw and catch events                                  |

An element also carries members, which are not statements:

| Member                                                            | What it does                                         | BPMN                       |
| ----------------------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| [`for each x in c`](#repetition)                                  | runs a step once per item, or a set number of times  | multi-instance marker      |
| [`asyncBefore: true`](#engine-settings)                           | an engine setting, in the parens                     | `operaton:` attribute      |
| [`form { ... }`](#forms)                                          | a form on a `start` or a `user` step                 | `operaton:formData`        |
| [`input x = ...`, `output x = ...`](#input-and-output-parameters) | data into and out of a step                          | `operaton:inputOutput`     |
| [`field x = ...`](#field-injection)                               | a value injected into the step's Java implementation | `operaton:field`           |
| [`property x = ...`](#external-task-extras)                       | a key and text on a form field or an external task   | `operaton:property`        |
| [`on create(class: "...")`](#listeners)                           | code run on a step's lifecycle                       | execution or task listener |

Every step, event, and handler takes the [engine settings](#engine-settings) and an execution listener, except an `emit link`, and most take input and output parameters.
The gateway statements take the engine settings alone, and the process header takes neither.
The ten activities (`user`, `service`, `script`, `step`, `send`, `receive`, `decide`, `subprocess`, `attempt`, and `call`) also take a repetition clause between the name and the parens.
Inside an element's braces, `on` declares a listener; at statement position it declares an event handler, which always carries a body of statements ([ADR-0020](../../docs/decisions/0020-listeners-reuse-on-inside-the-attribute-block.md)).

A few rules hold for every body:

- A process, subprocess, attempt block, or loop body can't be empty, and an empty handler body or an empty `if`, `parallel`, or `await { }` branch draws a warning.
- A step after an `end`, a `throw`, a `goto`, an `emit link`, or a block whose every branch ends that way can never run, which is an error, unless a `goto` targets it.
  A `start`, an `await link`, or a handler can follow such a statement.
- A `do` body that always ends or redirects the flow is an error, since nothing would reach the loop's check.
- A parameter or listener written in a body rather than in an element's braces is an error.

## The process header

The parens after `process X` hold settings the engine stores as written and never evaluates, so none of them takes a `"${...}"` template:

```bpmnscript
process invoice-approval(label: "Invoice approval", versionTag: "1.2", historyTimeToLive: "P90D", candidateStarterGroups: "accounting, management", isStartableInTasklist: false) {
  start Received
  end Done
}
```

| Setting                                           | Value                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `label`, `documentation`                          | a quoted string                                                                     |
| `versionTag`                                      | a quoted string of at most 64 characters, labeling the deployed process definition  |
| `historyTimeToLive`                               | days the engine keeps a finished instance's history, quoted as `"P<n>D"` or `"<n>"` |
| `candidateStarterUsers`, `candidateStarterGroups` | quoted, comma-separated ids allowed to start the process from Tasklist              |
| `isStartableInTasklist`                           | an unquoted boolean; `false` hides the process from Tasklist's start list           |

An absent `historyTimeToLive` compiles to `"P30D"`, because the engine's default configuration refuses to deploy a process without one.
History cleanup itself runs only once its batch window is configured in the engine.
The header takes no engine settings.

## Tasks

### User tasks

A `user` task is a step a person performs in Tasklist.

- `assignee`, `candidateUsers` and `candidateGroups` take user or group ids: a bare word or a quoted string is passed as written, and `"${who}"` reads a variable.
- `dueDate` and `followUpDate` take a period starting with `P`, an ISO date-time such as `"2026-01-01T09:00:00"`, or a `"${...}"` expression.
- `priority` is an integer or an expression yielding one; `"high"` would deploy and then fail every instance.
- `formKey` or `formRef` names a form deployed elsewhere, never both.
  `formRef` also needs `binding: latest`, `binding: deployment`, or `version: <n>` beside it, since the engine refuses a form reference it cannot resolve a version for, and `binding` or `version` without a `formRef` is an error.

`version` is a positive whole number, quoted or not, or an expression yielding one, here and on a `call` or a `decide` step; `1.5` would deploy and fail when the step runs.
`binding` and `version` are mutually exclusive in all three places.

### Forms

A process's own `start` and a `user` task each take one `form` block, which Tasklist renders as one input per field.
Each field fills the process variable of its name when the form is submitted, so a `var` of the same name has to declare the same type.

```bpmnscript
process gym-membership {
  start Applied {
    form {
      fullName: string "Full name" (required: true, minlength: 2, maxlength: 80)
      birthDate: date "Date of birth" (pattern: "dd/MM/yyyy", required: true)
      plan: enum "Plan" = "basic" (required: true) {
        basic "Basic"
        plus "Plus"
        family
        property description = "The plan sets the monthly fee"
      }
      newsletter: boolean "Send the newsletter?" = false
    }
  }
  user ConfirmPayment(assignee: "demo") {
    form {
      amount: number "Amount in euros" = 0 (min: 0, max: 5000)
      iban: string "IBAN" (validator: "com.example.gym.IbanValidator")
      reference: string "Payment reference" (readonly: true) {
        property placeholder = "Filled in by accounting"
      }
    }
  }
  end Done
}
```

A field is `id: type "label" = default (settings) { members }`, with the label, default, settings and members optional.
The type is `string`, `number`, `boolean`, `date`, or `enum`.
`number` is the engine's `long`, and an `enum` field stores the id of the chosen value, so its variable is a string.
Field ids are unique within a form.

The parens take the engine's form constraints, checked in the order written, plus `pattern`, and nothing else:

| Setting                            | What the engine checks                                                        | Fits     | Value                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `required: true`                   | a value was submitted, or the variable or default holds one; empty text fails | any type | the literal `true`                                                       |
| `readonly: true`                   | no value was submitted for the field                                          | any type | the literal `true`                                                       |
| `min: <n>`, `max: <n>`             | the number is at least `n`, or below `n` (`max` is exclusive)                 | `number` | an integer, or a quoted integer such as `"-5"`                           |
| `minlength: <n>`, `maxlength: <n>` | the text has at least, or at most, `n` characters                             | `string` | an integer, or a quoted integer                                          |
| `validator: "..."`                 | whatever the named class or expression decides                                | any type | a non-empty class name or a `"${...}"` expression                        |
| `pattern: "..."`                   | nothing; it is the format a submitted date is parsed with                     | `date`   | `SimpleDateFormat` letters, quoted runs, and non-letters: `"dd/MM/yyyy"` |

A flag is on when written and off otherwise, so `required: false` is an error telling you to leave it out.
A bound on the wrong type would deploy and then fail every submission, so it's an error.

A literal default is converted through the field's type every time the form renders.
A `number` default has to be an integer and a `boolean` default `true` or `false` (the engine reads anything else as `false`).
A `date` default is read against the field's `pattern`, or against the engine's default `dd/MM/yyyy` when there is none, so `"2026-01-01"` needs a matching `pattern`.
A bare name or a `"${...}"` default is evaluated by the engine at each render and not checked.

An `enum` field lists its values in the braces, one `id "Label"` line each in the order the form offers them, the label optional.
Value ids are unique, a literal default has to name one of them, and a value line on a field that is not an `enum` is an error.
An `enum` with no values draws a warning, since the engine deploys it and then rejects every submission.

A `property <key> = "<value>"` line in a field's braces attaches a key and text that a custom form can read; the engine itself never acts on it.
It fits any field type, its value is a quoted string or a `"${...}"` expression, and it is the only other member a field's braces take.

A `form` block on any element other than a process's own `start` or a `user` task is an error.

### Service tasks

A `service` task takes exactly one of five bindings, which say what runs it ([ADR-0017](../../docs/decisions/0017-service-task-bindings.md)):

| Binding      | Value                                | What runs                                                                                 |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `class`      | a Java class name, loaded as written | that `JavaDelegate`                                                                       |
| `expression` | a `"${...}"` template or a bare name | the expression itself                                                                     |
| `delegate`   | a `"${...}"` template or a bare name | the delegate object the expression resolves to                                            |
| `topic`      | a topic name                         | an external worker fetching that topic, see [External task extras](#external-task-extras) |
| `type`       | `"mail"` or `"shell"`                | a behaviour built into the engine, see [Mail and shell tasks](#mail-and-shell-tasks)      |

Quoted text under `delegate` is an error, since it resolves to no delegate, quoted text under `expression` draws a warning, since it evaluates to itself and runs nothing, and a template under `class` is an error, since a class name is never evaluated.
An empty binding value is an error.

`resultVariable` names the variable the return value is stored in, and only an `expression` binding writes it.
Beside `class` or `delegate` it is an error, since the engine refuses to deploy the combination; beside `topic` or `type` it deploys and is never written, so it draws a warning.

### Send, receive, and decision tasks

A `send` task binds exactly like a `service` task, with the same five bindings and the same `resultVariable` rules.
The engine runs both the same way, so the keyword changes how the diagram draws the step, not what it does.
It carries no message name of its own, unlike `receive` or `await message`.

A `receive` task with `message: "Name"` waits for a message of that name, correlated the same way as an `await message`.
Without `message` it still waits, but only the engine's signal API can move it on.

A `decide` task with `decision: "<key>"` evaluates that decision table.
`binding: latest`, `binding: deployment`, or `version: <n>` pins the deployed table version, as on a `call`.
`mapDecisionResult` picks what lands in `resultVariable`: `singleEntry`, `singleResult`, `collectEntries`, or `resultList`; without a `resultVariable` it is never applied and draws a warning.
Without `decision`, a `decide` task binds like a `service` task, and `binding`, `version` and `mapDecisionResult` are errors there.

### Mail and shell tasks

`type: "mail"` and `type: "shell"` select a behaviour the engine builds itself, on a `service`, `send`, or `decide` task.
Each input is a `field <name> = <value>` line in the braces, like [field injection](#field-injection) into a class.

```bpmnscript
process notify-ops {
  service SendAlert(type: "mail") {
    field to = "ops@example.com"
    field subject = "Disk usage high"
    field text = "Disk usage crossed the threshold on host-1."
  }
  send RunCheck(type: "shell") {
    field command = "df"
    field arg1 = "-h"
    field wait = "true"
    field outputVariable = "diskReport"
  }
}
```

A mail task needs `to` and one of `text` or `html`; `cc` and `bcc` satisfy neither.
`from` sets the sender, falling back to the engine's configured default, `subject` the subject line, and `charset` the encoding.

A shell task needs `command`.
`arg1` to `arg5` are positional arguments appended after it in order, unset ones skipped, and `directory` sets the working directory, which defaults to the engine process's own.
`outputVariable` names the variable that receives the command's stdout and `errorCodeVariable` the one that receives its exit code.
Every shell field is a quoted literal, never an expression, and the flags `wait`, `redirectError`, and `cleanEnv` are `"true"` or `"false"`.

A missing required field is an error, and so is a field name the behaviour does not know.
`resultVariable` beside `type` draws the same warning as beside `topic`.

### Script tasks

A `script` task's body is a fenced block after the settings, whose opening tag names the language:

````bpmnscript
process tally {
  script Count(resultVariable: "total") ```groovy
  return 40 + 2
  ```
}
````

The tags are `juel`, `javascript`, `js` or `ecmascript`, `groovy`, `python` or `py`, `ruby` or `rb`, and `feel`, in any case.
The tag runs to the first whitespace, so on a one-line fence a space separates it from the code.
Only `juel` runs on every Operaton installation; the others need a JSR-223 script engine on the engine's classpath, which is looked up the first time the script runs, not at deployment.
An unknown tag and an unterminated fence are errors, and an empty body draws a warning, here and on every other fenced script (a listener, a parameter value).

## What an element carries

### Engine settings

Five engine settings are legal on every element that takes settings:

- `asyncBefore` and `asyncAfter` put a transaction boundary before or after the step, so the engine continues it in a job.
- `exclusive` says whether that job may run beside other jobs of the same instance.
- `jobPriority` orders the job in the queue.
- `retryCycle` is the ISO cycle a failed job is retried on, such as `"R3/PT10M"`.

`asyncBefore`, `asyncAfter` and `exclusive` are unquoted booleans, and `retryCycle` is quoted.
A `retryCycle` the engine cannot read is dropped at deployment rather than refused, so it draws a warning.
`jobPriority` is an integer, a quoted integer, a bare variable name, or a `"${...}"` expression.

The job exists only when `asyncBefore` or `asyncAfter` is set, so `exclusive`, `jobPriority`, or `retryCycle` without one of them configures nothing and draws a warning.
Two cases are exempt.
A timer catch creates its own job, so the three settings apply to it directly.
A process's signal start, an `await signal`, and a signal branch of an `await { }` take `jobPriority` alone without an async flag, since the engine prices their subscription job with it; a signal handler or boundary keeps the warning.

Each element owns further keys on top, and any other key is an error naming the element:

| Element                                | Keys it owns                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                                | `label`, `documentation`, `initiator` (process start only)                                                                                                            |
| `end`, `step`, `subprocess`, `attempt` | `label`, `documentation`                                                                                                                                              |
| `user`                                 | `label`, `documentation`, `assignee`, `formKey`, `formRef`, `binding`, `version`, `candidateGroups`, `candidateUsers`, `dueDate`, `followUpDate`, `priority`          |
| `service`, `send`                      | `label`, `documentation`, `class`, `expression`, `delegate`, `topic`, `type`, `resultVariable`, `taskPriority`                                                        |
| `script`                               | `label`, `documentation`, `resultVariable`                                                                                                                            |
| `receive`                              | `label`, `documentation`, `message`                                                                                                                                   |
| `decide`                               | `label`, `documentation`, `class`, `expression`, `delegate`, `topic`, `type`, `decision`, `binding`, `version`, `mapDecisionResult`, `resultVariable`, `taskPriority` |
| `call`                                 | `label`, `documentation`, `process`, `binding`, `version`, `businessKey`, `mapper`, `mapperDelegate`                                                                  |
| `throw`, `emit`                        | `class`, `expression`, `delegate`, `topic`, on a `message` trigger only                                                                                               |
| `on`                                   | the flag `alongside`                                                                                                                                                  |
| `await`, a branch of `await { }`       | none                                                                                                                                                                  |

A repeated step also takes the `run*` settings described under [Repetition](#repetition), and the gateway statements take settings on their head, see [Job settings on a gateway](#job-settings-on-a-gateway).
The same key twice in one element is an error, and so is a value in a shape the element cannot read, such as a quoted `asyncBefore` or an unquoted `retryCycle`.

The parens hold at most one unkeyed value, the payload of a trigger such as `message("Name")`.
An unkeyed value where nothing reads one is an error (on a task, a call, a subprocess, a listener, the process header, or a `start` or `end` without a trigger, where `start S("PT30M")` is a timer missing its `timer` word), and so is a second unkeyed value.

### Input and output parameters

`input <name> = <value>` and `output <name> = <value>` in an element's braces map data into and out of the step.
They are legal on every activity: a `user`, `service`, `script`, `step`, `send`, `receive`, or `decide` task, a `subprocess`, an `attempt` block, and a `call`.
An `on` handler takes none, since the engine refuses to deploy a boundary event or an event sub-process with one.

```bpmnscript
process order-shipping {
  service Ship(topic: "shipping") {
    input address = { street: "${street}", city: "${city}" }
    input labels = ["express", "fragile"]
    output tracking = "${trackingId}"
  }
}
```

A value is an expression, a `[ ... ]` list, a `{ key: value }` map, or a fenced script that computes it, and lists and maps nest.
A map key is a name or a quoted string.
Entries keep their written order, and a name may repeat across the two directions but not within one.
An empty or blank string as a value, a list item, or a map value draws a warning, because the engine trims it and reads it as absent.
A repeated step can't map an `output`, since the engine refuses that combination; an `input` is fine.

### Field injection

`field <name> = <value>` sets a property on the Java object a step's binding names: the `class`, the object a `delegate` resolves to, or the mail or shell behaviour of a `type` ([ADR-0018](../../docs/decisions/0018-forms-and-field-injection.md)).
The value is a quoted string, injected as is, or a `"${...}"` expression, evaluated on each invocation.
A list, a map, a script, an empty value, and a string opening with an escaped `\${` or `#{` are errors.

A field is legal on a `service`, `send`, or `decide` task bound with `class`, `delegate`, or `type`, and in a listener bound with `class` or `delegate`.
On any other binding, `expression`, `topic`, or `decision`, the engine would never inject it, so it is an error.

```bpmnscript
process claim-intake {
  service NotifyAdjuster(class: "com.example.claims.NotifyAdjusterDelegate") {
    field team = "east-coast"
    field escalationThreshold = "${priorityScore}"

    on start(delegate: "${auditListener}") {
      field auditTag = "claim-intake"
    }
  }
}
```

### External task extras

A `service`, `send`, or `decide` task bound with `topic` hands its work to an external worker, and three members exist for that binding alone:

- `taskPriority: <n>` in the parens is the priority a worker's fetch can order by: an integer, a quoted integer such as `"-5"`, a bare variable name, or a `"${...}"` expression.
- `property <key> = "<value>"` in the braces is a key and text the worker receives when it fetches with `includeExtensionProperties`, the same line a form field takes.
- `error <Code> when <condition>` in the braces raises a declared [error code](#the-event-layer) when the condition holds, checked when the worker reports a failure and again on completion.
  Mappings run in the written order and the first true one wins.
  Beside the process variables, the condition can read `externalTask.errorMessage`, `externalTask.errorDetails`, and `externalTask.retries`.

```bpmnscript
process card-payment {
  error PAYMENT_DECLINED(message: "The card issuer declined the charge")
  error GATEWAY_DOWN

  service ChargeCard(label: "Charge the card", topic: "charge-card", taskPriority: 42) {
    property gateway = "stripe"
    property attempts = "3"
    error PAYMENT_DECLINED when externalTask.errorMessage == "declined"
    error GATEWAY_DOWN when externalTask.retries == 0
  }
}
```

Each of the three is an error on any other binding, and on a `throw message` or `emit message` bound with `topic`.
A mapping headed by a word other than `error`, missing its `when`, or naming an undeclared code is an error.

### Listeners

A listener runs code on a step's lifecycle and goes in the element's braces as `on <event>` plus what to run.

| Listener  | Legal on                                          | Events                                                            |
| --------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| execution | every step, event, and handler except `emit link` | `start`, `end`                                                    |
| task      | a `user` task                                     | `create`, `assignment`, `complete`, `update`, `delete`, `timeout` |

A listener runs exactly one thing: a `class`, `expression`, or `delegate` in its parens, valued as on a service task, or a fenced script.
A listener with both a fenced script and a `class`, `expression`, or `delegate` is an error.
A `class` or `delegate` listener may open braces holding [fields](#field-injection).
`on timeout` carries the timer saying when it fires, an `after`, `at`, or `every` particle and a time, and no other event takes one.
The same event may carry several listeners on one element, and each compiles to its own listener in the order written.

````bpmnscript
process claim-review {
  user Review(assignee: "demo") {
    on start(class: "com.example.AuditListener")
    on complete ```groovy
    log.info(task.id)
    ```
    on timeout after "PT8H"(delegate: "${escalationHandler}")
  }
}
````

## Control flow

### Decisions and loops

`if (condition) { } else if (condition) { } else { }` runs the first branch whose condition holds.
Without an `else`, the flow carries on after the chain when no condition holds.
`while (condition) { }` checks before each pass, and `do { } while (condition)` runs the body once before the first check.
Each compiles to exclusive gateways, a loop with a back edge.

### Stopping when no condition holds

Ending an `if` chain with `else fail` stops the run with an error when no condition holds, instead of carrying on.

```bpmnscript
process claim-routing {
  var amount: number

  start ClaimReceived
  if (amount <= 1000) {
    user QuickReview
  } else if (amount <= 50000) {
    user FullReview
  } else fail
  end ClaimRouted
}
```

The gateway gets no default flow, so the engine fails with `ENGINE-02004 No outgoing sequence flow ... could be selected` when nothing matches.
That is an engine exception, not a BPMN error, so no `on error` handler catches it.
The transaction that reached the gateway rolls back: a start request fails and leaves no instance, a task completion fails and leaves the task open, and behind an `asyncBefore` the job fails and raises an incident once its retries run out.
An empty branch beside `else fail` is how a case carries on rather than failing, so it draws no warning.

A `parallel` block whose every branch is conditioned takes the same closing `else fail`, see the next section.
A loop takes none, and a word other than `fail` after `else` is an error.
`fail` is special only in this position, so `var fail: boolean` is legal.

### Conditioning a parallel branch

`parallel { { } { } }` runs two or more branches at the same time and continues when all have finished.
A branch may open with `if (condition)`, which runs it only when the condition holds, or with `else`, which runs it only when no sibling's condition held; a branch with neither always runs.

```bpmnscript
process expense-approval {
  var amount: number

  start ExpenseSubmitted

  parallel {
    if (amount > 10000) {
      user AuditReview(assignee: "auditor")
    }
    else {
      user SkipAudit(assignee: "clerk")
    }
  }

  end ExpenseProcessed
}
```

With no condition anywhere, the statement compiles to a parallel gateway pair.
A condition on any branch turns both the fork and the join into inclusive gateways, and every unconditioned branch still runs beside whichever conditioned ones matched ([ADR-0031](../../docs/decisions/0031-inclusive-and-event-based-gateways.md)).
When every branch is conditioned and none matches, the run continues past the join, through the `else` branch if there is one; a closing `else fail` stops the run instead.

These combinations are errors:

- an `else` branch beside a branch with no condition, since that branch always runs and the `else` never would,
- a second `else` branch, or an `else` on a statement with no conditioned branch,
- `else fail` on a statement with no conditioned branch, beside an unconditioned branch, or beside an `else` branch.

### What `goto` can reach

`goto X` jumps to the step named `X` in the same container: the process, a `subprocess` or `attempt` body, or a host-less handler's body, at any nesting depth of `if`, loop and `parallel` blocks within it.
It never reaches into another process, into or out of a sub-process, or into or out of a host-less handler, which mirrors BPMN's rule that a sequence flow cannot cross a sub-process boundary.
A `subprocess` is a target from its own container, and so is an `await` that carries a name, unless its trigger is `link`.
An `on` handler has no name and is never a target.

A hosted handler (`on Host: ...`) is the exception: its body shares the host's container, so a `goto` crosses freely between it and the main flow in both directions.
A host-less handler written inside a hosted handler's body therefore guards the whole surrounding container, not just that body.

A `goto` into a `parallel` or `await { }` branch from outside it is an error, since the token would leave the join waiting for branches the run never entered.
A `goto` target or a hosted handler's host across a boundary fails to resolve, and the message explains the boundary when the name exists elsewhere in the process:

```text
'X' is inside subprocess 'Y'
  note: a goto cannot cross a subprocess boundary
'X' is inside the 'on error(PAYMENT_FAILED)' handler
  note: a goto cannot cross an event handler boundary
  note: an event handler's steps run only when its event fires
'X' is outside subprocess 'Y'
  note: a boundary event attaches to an activity in its own scope
```

### Job settings on a gateway

`if`, `while`, `do ... while`, `parallel`, and `await { }` each create a gateway that has no name of its own.
Its [engine settings](#engine-settings) go in parens on the statement head, after the condition for `if` and the loops.
`if`, `parallel`, and `await { }` also create a join, whose settings share the same parens with a `join` prefix: `joinAsyncBefore`, `joinAsyncAfter`, `joinExclusive`, `joinJobPriority`, `joinRetryCycle`.
An `if` chain is one gateway however many `else if` branches it has, so an `else if` takes no parens of its own.
A `join` job key without `joinAsyncBefore` or `joinAsyncAfter` beside it configures nothing and draws a warning, as on any element.

```bpmnscript
process order-fulfillment {
  var amount: number

  start OrderPlaced

  if (amount > 10000) (asyncBefore: true, joinAsyncBefore: true, joinJobPriority: 5) {
    user AuditReview(assignee: "auditor")
  } else {
    user SkipAudit(assignee: "clerk")
  }

  parallel (asyncBefore: true, exclusive: true, joinAsyncAfter: true) {
    {
      user PackItems
    }
    {
      user PrintLabel
    }
  }

  end OrderShipped
}
```

A bare value in these parens is an error, and so is a `join` key on a loop, which has one gateway; the message names the plain spelling.
`await { }` refuses `asyncAfter`, which the engine refuses on that gateway, so it goes on a branch's trigger instead.
A `join` key on a statement whose branches all end their own path draws a warning, since the join is never reached.

## Sub-processes, calls, and repetition

### Sub-processes

`subprocess X { }` groups steps into an embedded sub-process.
Its body uses the same statements as a process body, including another `subprocess`, and a diagram shows it expanded with its steps inside.
`attempt X { }` is the same container for work that can be given up, see [Giving a block of work up](#giving-a-block-of-work-up).

### Call activities

`call X(process: "<id>") { }` starts another process and waits for it to finish ([ADR-0019](../../docs/decisions/0019-a-call-activitys-variable-mapping.md)).
In the braces, `in target = source` passes a value into it and `out target = source` reads one back, the left side naming the variable in the receiving process; `in x` and `out x` copy a variable under its own name, and `in *` and `out *` copy every variable.
`in local x = y` reads from or writes to variables of the call step itself rather than the whole process, which is mostly useful for imported diagrams.
A mapping repeated within one direction is an error.

`version: <n>`, `binding: latest`, or `binding: deployment` picks the deployed version of the called process, never more than one.
`businessKey: "<value>"` sets the started instance's business key.

`mapper: "<class>"` or `mapperDelegate: "${bean}"` names an implementation of Operaton's `DelegateVariableMapping`, valued like `class` and `delegate` on a service task.
It runs after the declared `in` and `out` mappings and adds to them.
Writing both is an error, and a `call` carries no `field`, since the engine injects none into a mapper.

```bpmnscript
process order-handling {
  var orderTotal: number
  var approved: boolean

  call ApproveInvoice(process: "invoice-approval", mapper: "com.example.invoice.ApprovalMapper") {
    in amount = orderTotal
    out approved
  }
}
```

A missing `process` and an unknown `binding` value are errors.

### Repetition

A `for` clause between an activity's name and its parens runs it several times, as a multi-instance activity ([ADR-0022](../../docs/decisions/0022-repetition-the-for-clause-and-its-per-run-job-settings.md)).

| Clause                     | Runs                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `for each line in lines`   | once per element of `lines`, each run seeing its element as `line` |
| `for each in lines`        | once per element of `lines`, binding no element                    |
| `for 3`                    | three times                                                        |
| `for 3 each line in lines` | three times, run `n` seeing element `n` of `lines`                 |

A literal count is a non-negative whole number, quoted or not, and a bare name or a `"${...}"` expression is left to the engine.
A collection written as a plain name is the process variable of that name; anything else is a quoted expression, so `for each line in "${order.lines}"` reads a property.

The runs happen at once unless `sequentially` orders them one after another.
`until (condition)` cancels the runs still outstanding once the condition holds.
The condition can read `nrOfInstances`, `nrOfActiveInstances`, and `nrOfCompletedInstances`, kept for the repetition as a whole, and `loopCounter`, the index of the current run, which the run's body and its `input` parameters can read too.
A sequential repetition checks the condition after each run; a parallel one checks it whenever any run ends, with `loopCounter` naming that run.
These four and the element name need no `var`.

```bpmnscript
process invoice-batch {
  var invoices: any

  start BatchOpened
  user ApproveInvoice for each invoice in invoices sequentially until (nrOfCompletedInstances >= 3)(label: "Approve the invoice", assignee: "demo") {
    input reference = "${loopCounter}"
  }
  service ArchiveBatch for 3(label: "Archive the batch", class: "com.example.invoices.ArchiveDelegate")
  end BatchClosed
}
```

On a repeated step, `asyncBefore`, `asyncAfter`, `exclusive`, and `retryCycle` configure one job around the whole repetition.
`runAsyncBefore`, `runAsyncAfter`, `runExclusive`, and `runRetryCycle`, in the same parens, configure a job for each run instead.
There is no `runJobPriority`: `jobPriority` already prices each run's job, and the whole-repetition job takes the process's priority.
`runExclusive` and `runRetryCycle` need `runAsyncBefore` or `runAsyncAfter` beside them, and so does `jobPriority` on a repeated step, or they configure nothing and draw a warning.
A `run*` key on a step without a `for` clause is an error.

```bpmnscript
process order-notifications {
  var orders: any

  service NotifyCustomer for each order in orders(class: "com.example.orders.NotifyCustomer", runAsyncBefore: true, runRetryCycle: "R3/PT10M")
}
```

## Events

### The event layer

The event layer catches and raises BPMN events.
An `on <trigger> { }` handler is a catch block: it sits at the end of the body it guards, after the last statement, the way `catch` follows `try`, and it guards the process, a `subprocess` or `attempt` body, or another handler's body.
A handler anywhere else, or before a statement of its body, is an error.

```bpmnscript
process payment {
  error PAYMENT_FAILED(message: "The payment failed")
  var reason: string

  start Ordered
  service Pay(class: "com.example.Pay")
  end Paid

  on error(PAYMENT_FAILED, message: reason) {
    user HandleFailure(assignee: "demo")
    end Failed
  }
}
```

A catch binding pairs a field of the event (`code`, and for `error` also `message`) with the variable that receives it, like the `e` in `catch (Exception e)`.
Leaving the code out, as in `on error { }`, catches any event of that kind.
`alongside`, written as a bare word in the trigger's parens as in `on Review: timer("PT1H", alongside) { ... }`, makes a handler non-interrupting, so the guarded body keeps running beside it.

`throw <trigger>` raises an event and ends the current path, and `emit <trigger>` raises it and continues.
`emit link` is the one emit that ends its path, see [Link events](#link-events).

An error or escalation code is declared at the top of the process body, beside the `var` declarations, as `error CODE(message: "text")` or `escalation CODE`, and every throw, catch, and [error mapping](#external-task-extras) names it ([ADR-0023](../../docs/decisions/0023-event-roots-from-usage-and-declared-codes.md)).
`message` is the text a thrown error carries; an escalation has none.
A code that isn't name-shaped goes on the declaration as `code: "..."`, so every use site is a plain name.

| Trigger        | Payload                                                       | `alongside`?                   | `throw` (ends the path)  | `emit` (continues)                   |
| -------------- | ------------------------------------------------------------- | ------------------------------ | ------------------------ | ------------------------------------ |
| `error`        | a declared code, optional `code: c` and `message: m` bindings | no, an error always interrupts | `throw error(CODE)`      | none                                 |
| `escalation`   | a declared code, optional `code: c` binding                   | yes                            | `throw escalation(CODE)` | `emit escalation(CODE)`              |
| `message`      | a name                                                        | yes                            | `throw message("Name")`  | `emit message("Name")`               |
| `signal`       | a name                                                        | yes                            | `throw signal("Name")`   | `emit signal("Name")`                |
| `timer`        | a duration, or an `at` or `every` key and a time              | yes                            | none                     | none                                 |
| `condition`    | a condition                                                   | yes                            | none                     | none                                 |
| `compensation` | none                                                          | no, its scope already finished | `throw compensation`     | `emit compensation`                  |
| `cancel`       | none                                                          | no, the block stops either way | none, `end X cancel`     | none                                 |
| `link`         | a name                                                        | no handler, only `await link`  | none                     | `emit link("Name")`, ending the path |

What each trigger means:

- `error` and `escalation` are plain catch blocks.
  An escalation only travels up within its own guarded scope.
- `message` is received by correlation on its name, by a handler, a message start, an `await`, or a `receive` task.
  `throw message` and `emit message` send one only when they carry a `class`, `expression`, `delegate`, or `topic` binding; without one the event only shows in the diagram, which draws a warning.
  More than one binding is an error, and so is a binding on any other trigger.
- `signal` is a broadcast: `emit signal("Name")` notifies every catch anywhere waiting on that name.
- `timer` reads its form from the parens: `"PT1H"` is a duration, `at: "2026-08-01T09:00:00"` a fixed moment, `every: "R/PT10M"` a cycle, see [Timers](#timers).
  The clock starts when the guarded scope starts, and an interrupting `every` fires once, since firing ends the scope, so it draws a warning; `alongside` keeps it firing.
- `condition` is checked when the guarded scope starts, and again whenever a variable it reads changes.
- `compensation` is a subprocess's undo block, see [Undoing finished work](#undoing-finished-work).
- `cancel` gives up an `attempt` block, see [Giving a block of work up](#giving-a-block-of-work-up).
- `link` is a jump drawn as two events, see [Link events](#link-events).

Two handlers that register the same catch on one scope are an error; for a message or a signal, a handler inside a block and one attached to that block share the scope.
So is an escalation catch-all beside a coded escalation catch on the same scope.

### Timers

A timer value has to fit its particle:

- a duration (a bare value, or `after` on an `on timeout` listener) is an ISO 8601 duration such as `"PT8H"`, alone or beside a start or end date-time,
- `at` is an ISO date-time or a period,
- `every` is a repeat such as `"R3/PT10M"`, a six-field cron expression, or a nickname such as `"@daily"`.

A value that doesn't fit is an error on a timer start, which the engine parses at deployment, and a warning everywhere else, since the engine reads it only once the scope is entered.
An unknown particle is an error.
A timer job setting written both on an `on timer` head and on its body's `start` is an error.

### Attaching a handler to one step

`on <Host>: <trigger>(...) { }` attaches a handler to one step as a boundary event, catching only while that step runs ([ADR-0027](../../docs/decisions/0027-boundary-events-attached-to-an-activity.md)).
`on ReviewInvoice: timer("PT2H") { ... }` reads "if reviewing the invoice takes longer than two hours, do this instead".
The colon tells a host from a trigger.

```bpmnscript
process invoice-review {
  start Received
  user ReviewInvoice(assignee: "demo")
  end Done

  on ReviewInvoice: timer("PT2H") {
    user Escalate(assignee: "manager")
    goto Done
  }
}
```

The host is an activity: a `user`, `service`, `script`, `step`, `send`, `receive`, or `decide` task, a `subprocess`, an `attempt` block, or a `call`.
Anything else, an `await` included, is an error.
An escalation attaches only to a `subprocess`, an `attempt`, a `call`, or a `user` task, and a cancel only to an `attempt`.
Every trigger but `compensation` and `link` can attach, and `cancel` has to.
`alongside` lets the host run on beside the handler; without it the host is cancelled when the trigger fires.

A hosted body ends where its last statement ends and never falls through to what follows the host, since a non-interrupting boundary would otherwise run the rest of the process twice.
Rejoin the main flow with a `goto`, as above.
A hosted body can't open with a `start`.

### Undoing finished work

`on compensation { }` inside a `subprocess` or `attempt` body is that sub-process's undo block, the steps that reverse what it finished ([ADR-0028](../../docs/decisions/0028-compensation-as-subprocess-undo-block.md)).
It runs only for an instance that completed, in two cases: a `throw compensation` or `emit compensation` in an enclosing scope, or a cancel end giving up an `attempt` block the subprocess sits in.
`throw compensation` undoes the enclosing scope's completed work newest first and ends the path; `emit compensation` waits for the undo and continues.

A sub-process has at most one undo block, it carries no payload, and `on compensation` at process level is an error, since a process has no completed scope to reverse.
To make one step undoable, wrap it in its own `subprocess` with an undo block; compensation has no hosted form.
An undo block sees the subprocess's variables as they were when it completed.
Operaton doesn't carry compensation into the process a `call` starts, so a called process compensates its own work.

### Awaiting an event inline

`await <trigger>(<payload>)` is a step on the main flow: the path stops until the event arrives, then continues with the next statement.

```bpmnscript
process invoice-intake {
  var amount: number

  await message("Invoice Received")
  await timer("PT1H")
  await signal("Ready")
  await condition(amount > 100)
}
```

The awaitable triggers are `message`, `timer`, `signal`, `condition`, and [`link`](#link-events), with the same payloads as on `on`.
`await error`, `await escalation`, and `await compensation` are errors naming the legal words, and `await cancel` points at `end X cancel` and `on X: cancel` instead.
An `await` takes no host, binding, `alongside`, or body.
An optional name between the trigger and the payload, `await message Paid("Paid")`, makes it a `goto` target ([ADR-0026](../../docs/decisions/0026-intermediate-catch-events.md)).

### Link events

A link is a jump drawn as two events with no flow between them, a diagram's off-page connector.
`emit link` throws, `await link` catches, and the quoted link name, also their diagram label, pairs them.

```bpmnscript
process invoice-rework {
  var approved: boolean

  start InvoiceReceived
  user ReviewInvoice(assignee: "demo")
  if (!approved) {
    emit link ToRework("Rework")
  }
  end Approved

  await link AtRework("Rework")
  user ReworkInvoice(assignee: "demo")
  goto ReviewInvoice
}
```

`emit link` ends its path like a `goto`, so nothing written after it runs.
Nothing flows into a link catch, so the statement before an `await link` has to end the path: an `end`, a `throw`, a `goto`, an `emit link`, or a block whose every branch does.
A name has one `await link` in the whole file and any number of `emit link`.
Both ends sit in one container, as with `goto`, and an `emit link` can't reach into a `parallel` or `await { }` branch from outside it.

These are errors: an `emit link` with no catch, a `throw link`, a `goto` onto a link catch, `link` heading a branch of `await { }`, and an engine setting or listener on `emit link`, where the engine creates nothing to run it.
An `await link` that nothing emits is a warning, since an imported diagram may carry one.
Write `goto` to jump in your own source; `link` exists so that a diagram carrying one imports and compiles back to the same two events ([ADR-0030](../../docs/decisions/0030-link-events-for-import-round-trip-symmetry.md)).

### Waiting on several triggers at once

`await { }` with two or more branches waits on every trigger at once and continues down whichever fires first, as an event-based gateway.
Each branch is a trigger, its payload and settings, and a body; it carries no name, and `link` can't head one.
For a single trigger, write a plain `await`.

```bpmnscript
process order-fulfillment {
  await {
    message("PaymentReceived") {
      service ShipOrder(class: "com.example.orders.ShipOrder")
    }
    timer("P3D") {
      user ChaseCustomer(assignee: "collections")
    }
  }
}
```

Exactly one branch runs: when one trigger fires, the engine cancels the others.
A `condition` branch is checked as soon as the statement is reached, so a condition that already holds wins at once.
Two branches waiting on the same message or signal name are an error.

### Starting on an event

A process's own `start` can carry a trigger: `message`, `signal`, `timer`, or `condition`, with the payload it takes elsewhere.

```bpmnscript
process order-intake {
  start OrderReceived message("OrderReceived", label: "An order arrives")

  user ConfirmOrder(label: "Confirm the order", assignee: "demo")

  emit message NotifyWarehouse("WarehouseNotified", class: "com.example.demo.LogDelegate")

  throw message OrderAcknowledged("OrderAcknowledged", class: "com.example.demo.LogDelegate")
}
```

A message start's name has to be fixed text, since a process that hasn't started has no variables to evaluate an expression against.
`error`, `escalation`, and `compensation` on a process start are errors, because the engine would ignore them and start the process as if no trigger were written.
A start inside a subprocess, an attempt block, or a handler body takes no trigger, `initiator`, or `form`, since its container enters it.

A process can have several starts, so one process is started by hand and by a message alike:

```bpmnscript
process support-ticket {
  start ByAgent(label: "An agent opens a ticket")
  start ByEmail message("TicketEmailed", label: "A ticket arrives by email")

  user Triage(label: "Triage the ticket", assignee: "demo")

  end Resolved(label: "Ticket resolved")
}
```

A `start` takes no incoming flow, so it sits first, after another `start`, or after a statement that ends or redirects the flow, such as an `end`, a `throw`, or a `goto`.
Starts written back to back share the chain that follows, and a start after an `end` opens its own chain, which reaches shared steps by `goto`.
A start after a step whose flow still runs on is an error.

The engine limits how many starts a scope has, and each limit is an error:

- A subprocess, attempt block, or handler body has exactly one start, written first.
- A process has one plain or timer start, one message or signal start per name, and one condition start per condition.
- A body that doesn't open with a `start` gets a plain one from the compiler, which counts, so a plain or timer start further down is a second one.

A process with two or more starts that all carry a message, signal, or condition trigger can't be started by key, so it draws a warning.
The engine shows a start form only on the plain or timer start, so a `form` on any other start draws a warning too.

### Ending every path

`end X terminate` stops every running path in its scope at once ([ADR-0025](../../docs/decisions/0025-events-at-the-process-boundary.md)).

```bpmnscript
process stock-alert {
  start StockRunningLow signal("StockRunningLow", label: "Stock is running low")

  parallel {
    {
      user ReorderStock(label: "Reorder the stock", assignee: "demo")
    }
    {
      user EscalateToBuyer(label: "Escalate to the buyer", assignee: "demo")
      end OrderAbandoned terminate(label: "Abandon every path")
    }
  }

  end Restocked(label: "Stock restored")
}
```

A branch ending in `terminate` never reaches the join, so the join waits only for the branches that do.
`terminate` and `cancel` are the two triggers an `end` carries; any other is an error, since every other kind is raised with `throw`.

### Giving a block of work up

`attempt X { }` is a block of work that can be given up as a unit ([ADR-0029](../../docs/decisions/0029-work-that-can-be-given-up.md)).
It is a `subprocess` under another keyword, so it nests and takes a label, a repetition, settings, and handlers.
Inside it, `end X cancel` gives the block up, and beside it, `on X: cancel { }` says what happens next.

```bpmnscript
process seat-booking {
  var chargeDeclined: boolean

  start BookingRequested

  attempt BookAndPay(label: "Try to book and pay for the seat") {
    subprocess HoldSeat(label: "Hold the seat") {
      service HoldSeatTask(class: "com.example.booking.HoldSeat")

      on compensation {
        service ReleaseSeat(class: "com.example.booking.ReleaseSeat")
      }
    }

    service ChargeCard(class: "com.example.booking.ChargeCard")

    if (chargeDeclined) {
      end BookingAbandoned cancel(label: "Give up the booking")
    }

    service IssueTicket(class: "com.example.booking.IssueTicket")
  }

  user ConfirmBooking(label: "Confirm the booking", assignee: "demo")
  end BookingComplete

  on BookAndPay: cancel {
    user ApologizeToCustomer(label: "Apologize to the customer", assignee: "demo")
    end BookingCancelled
  }
}
```

Giving the block up runs the undo blocks of the steps inside it that had finished, newest first, then the handler.
Here `HoldSeat` has an undo block, so the seat is released before the apology; `ChargeCard` has none, so nothing reverses it.
An enclosing scope keeps whatever it finished before the block started.
An `attempt` is not a database transaction: a charge taken or a message sent is reversed only by the undo blocks you write.

A cancel end gives up the block whose container it is in.
An `if`, a loop, a `parallel` or `await` branch inside the block, and a handler attached to one of its steps are still the block; a nested `subprocess`, a host-less handler, and the process are not, so a cancel end there is an error.
A host-less `on cancel` is an error, and so is a cancel handler on anything but an `attempt`.

A cancel end in a block with no cancel handler deploys and then fails when a run reaches it, and a cancel handler on a block nothing gives up can never run, so either half without the other draws a warning.
An `attempt` with neither is an ordinary block of work.

## Reserved words

These words are keywords and can't be used as a plain name; write a step's name in backticks and a variable as `"${...}"`:

`alongside` `any` `attempt` `await` `boolean` `call` `date` `decide` `do` `each` `else` `emit` `end` `false` `for` `form` `goto` `if` `in` `json` `local` `null` `number` `on` `out` `parallel` `process` `receive` `script` `send` `sequentially` `service` `start` `step` `string` `subprocess` `throw` `true` `until` `user` `var` `while`

Everything else is an ordinary name that has a special meaning only in position: the trigger words, `terminate`, `fail`, the timer particles `after`, `at`, and `every`, the binding fields `code` and `message`, the form type `enum`, the member words `input`, `output`, `field`, and `property`, `when`, every setting key, and every listener event but `start` and `end`.
So `var message: string`, `var timer: number`, and a step named `every` are all legal, and the editor highlights and completes these words only where they carry meaning.
Using a reserved word as a name, as in `if (date > deadline)`, is an error that names the word and suggests the `"${...}"` form.

## Diagnostics

The validator reports errors, which stop `build`, and warnings, which don't.
A message names the problem and, where it can, the fix: `emit error` points at `throw error`, and an unknown key names the element it is not valid on.
Most rules mirror a check Operaton makes when it deploys or runs a process, so the mistake shows in the editor instead of in the engine ([ADR-0013](../../docs/decisions/0013-validator-mirrors-parse-time-rules.md)); [`src/bpmn-script-validator.ts`](src/bpmn-script-validator.ts) holds the exact rules and wording.

Each rule is described with the construct it governs:

| Area                                       | Where                                                          |
| ------------------------------------------ | -------------------------------------------------------------- |
| names and labels                           | [Names and labels](#names-and-labels)                          |
| variables, JUEL words, and condition types | [Variables](#variables), [Expressions](#expressions)           |
| empty bodies, unreachable steps            | [Statements](#statements)                                      |
| header values                              | [The process header](#the-process-header)                      |
| tasks, bindings, and forms                 | [Tasks](#tasks)                                                |
| keys, engine settings, and unkeyed values  | [Engine settings](#engine-settings)                            |
| parameters, fields, properties, listeners  | [What an element carries](#what-an-element-carries)            |
| `else fail`, parallel branches, `goto`     | [Control flow](#control-flow)                                  |
| gateway settings                           | [Job settings on a gateway](#job-settings-on-a-gateway)        |
| calls and repetition                       | [Call activities](#call-activities), [Repetition](#repetition) |
| triggers, handlers, timers, starts, links  | [Events](#events)                                              |
| reserved words                             | [Reserved words](#reserved-words)                              |

A trigger word outside the set its verb accepts, or a payload that doesn't fit its trigger, is an error naming the legal choices.

## Public API

```ts
import {
  createBpmnScriptServices, // factory: returns a fully wired Langium service container
  BpmnScriptLanguageMetaData, // file-extension constants (e.g. fileExtensions: ['.bpmnscript'])
  renderExpression, // serialize a parsed expression AST node to a "${...}" string
} from '@bpmn-script/language';
```

The AST types Langium generates from the grammar are re-exported from the package root, and `@bpmn-script/transform`'s `astToIr` consumes them.
They track the grammar, so `src/generated/ast.ts` after a build is the current list.

## Build and test

```bash
# From repo root
npm run build --workspace packages/language
npm test --workspace packages/language

# From this directory
npm run build    # runs langium generate + tsc
npm test
```

`langium:generate` and `langium:watch` are also available for IDE use.

## Source layout

| Path                                               | Purpose                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/bpmn-script.langium`                          | Grammar definition                                                                                                                                                                                     |
| `src/vocabulary.ts`                                | The trigger words, listener events, and attribute keys each element owns                                                                                                                               |
| `src/bpmn-script-validator.ts`                     | AST-level validator; source of truth for the diagnostics                                                                                                                                               |
| `src/bpmn-script-document-validator.ts`            | Drops the link failure of a variable reference, since only a code position has a scope to resolve in                                                                                                   |
| `src/paren-items.ts`                               | Readers over an element's parens: the payload, the keyed settings, and the flags                                                                                                                       |
| `src/bpmn-script-scope-provider.ts`                | Resolves `goto` targets and a hosted handler's `host` within the enclosing container only                                                                                                              |
| `src/bpmn-script-linker.ts`                        | Replaces an unresolved `goto` or `host` message with a boundary explanation                                                                                                                            |
| `src/bpmn-script-parser-error-message-provider.ts` | Guidance for a reserved word used as an identifier                                                                                                                                                     |
| `src/bpmn-script-completion.ts`                    | Snippet completions for the structural keywords and for the settings an element holds                                                                                                                  |
| `src/bpmn-script-semantic-tokens.ts`               | Highlights the soft words (trigger, attribute key, parameter direction, listener event)                                                                                                                |
| `src/bpmn-script-hover.ts`                         | Hover content for a named statement, a code declaration and a variable, merged with Langium's own doc-comment hover                                                                                    |
| `src/bpmn-script-symbols.ts`                       | Outline symbol kinds per AST type, and the header text an `on` handler shows since it carries no `name`                                                                                                |
| `src/bpmn-script-value-converter.ts`               | Reads a raw template, `"${...}"` or `"#{...}"`, with the string escapes a literal gets                                                                                                                 |
| `src/bpmn-script-module.ts`                        | Langium dependency injection wiring                                                                                                                                                                    |
| `src/expression-render.ts`                         | `renderExpression(astNode): string`, serializing a parsed expression AST to `${...}` text                                                                                                              |
| `src/variable-symbol-provider.ts`                  | `VariableSymbolProvider`, collecting the declaring sites (a header `var`, a form field, a catch binding, an `input`/`output` parameter, a repetition's element) that `bpmn-script-references.ts` reads |
| `src/bpmn-script-references.ts`                    | Definition, references, rename and highlight for a variable, resolved through those declaring sites since no single AST node stands for one                                                            |
| `src/index.ts`                                     | Package re-exports                                                                                                                                                                                     |
| `src/generated/`                                   | Langium-generated files (git-ignored, rebuilt by `npm run build`)                                                                                                                                      |
| `textmate-postprocess.mjs`                         | Runs after `langium generate`: gives a hyphenated name its color back and adds a scope for numbers and operators                                                                                       |
| `syntaxes/`                                        | TextMate grammar (git-ignored, generated by `langium generate` and adjusted by `textmate-postprocess.mjs`); `packages/extension` layers an injection grammar over it for code inside a fenced script   |
