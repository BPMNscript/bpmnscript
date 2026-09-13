# Examples

Deployment fixtures for running a compiled `.bpmn` file on Operaton.

One mode exists today: `spring-boot/`, with Operaton embedded in a Spring Boot application.
Two more are planned and have no fixture yet: an Operaton REST engine with external-task workers, and a standalone Operaton engine without Spring Boot.

## `spring-boot/`

The fixture runs Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application on Java 17, exposing the Operaton REST API on port 8080.
It's packaged as a Docker image so the integration test harness can start and stop it programmatically.

Twenty-eight DSL sources live under `spring-boot/processes/`, one per construct or construct combination.
Running `bpmns build` on any of them produces the deployable `.bpmn`.

| Source                  | Covers                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| `invoice-approval`      | `if`/`else` desugaring                                                     |
| `parallel-approval`     | `parallel { { } { } }` desugaring                                          |
| `service-delegate`      | The `delegate` service binding, against a Spring-managed bean              |
| `service-expression`    | The `expression` service binding, a JUEL expression Operaton evaluates     |
| `external-task`         | The `topic` binding, against a worker polling `print-label`                |
| `script-task`           | A `script` task's fenced body, in Groovy                                   |
| `purchasing`            | A `call` activity into `invoice-approval`, with in and out mappings        |
| `order-handling`        | Sub-process containment, plus interrupting and non-interrupting boundaries |
| `order-recovery`        | The error and escalation layer, both handler kinds                         |
| `order-reminder`        | The timer and message triggers                                             |
| `loan-approval`         | The `demo` walkthrough                                                     |
| `loan-approval-kopp`    | The `demo` walkthrough, parallel-rating variant                            |
| `awaiting-confirmation` | `await message`, released by an outside correlation                        |
| `charge-with-recovery`  | An error boundary on a service task host                                   |
| `compensating-saga`     | Compensation raised from a process-level error handler                     |
| `engine-extensions`     | Listeners, input and output parameters, and an async continuation          |
| `order-intake`          | A message start, a message intermediate throw, and a message end           |
| `stock-alert`           | A signal start and a terminate end                                         |
| `scheduled-audit`       | A timer start, fired by hand through the job API rather than the clock     |
| `task-kinds`            | The four task kinds: `step`, `send`, `decide`, and a named `receive`       |
| `batch-approval`        | Repetition by count and by collection, in order and in parallel            |
| `empty-batch`           | A repetition count of zero, which leaves the step without running it       |
| `booking-attempt`       | A block given up from inside, its undo block, and its cancel handler       |
| `order-dispatch`        | Conditioned `parallel` branches and an `await` race between two triggers   |
| `support-ticket`        | Two starts, one plain and one message, entering the same step              |
| `order-rework`          | A link pair: `emit link` inside an `if`, and the `await link` it jumps to  |
| `card-charge`           | A topic-bound step with a priority, properties, and an error mapping       |
| `plan-selection`        | A task form with a required enum and a length-bounded text field           |

[Running processes on Operaton](spring-boot/README.md#running-processes-on-operaton-demo) is a hands-on tour of the two loan-approval processes.

### Testcontainers harness

Fourteen E2E test files in `tests/e2e/` use [testcontainers-node](https://testcontainers.com/) to start the Docker image, deploy compiled BPMN over the Operaton REST API, start instances, and assert engine behavior: `invoice-approval`, `parallel-approval`, `loan-approval`, `loan-approval-kopp`, `boundary-events` (over `order-handling`), `awaiting-confirmation`, `engine-extensions`, `service-boundary-and-compensation` (over `charge-with-recovery` and `compensating-saga` in one container boot), `event-positions` (over `order-intake`, `stock-alert`, `scheduled-audit`, `support-ticket`, and `order-rework` in one container boot), `task-kinds`, `repetition` (over `batch-approval` and `empty-batch` in one container boot), `booking-attempt`, `branch-and-race` (over `order-dispatch`), and `forms-and-external-tasks` (over `card-charge` and `plan-selection` in one container boot).
The remaining fixtures are demo-only.

The compensation half of `service-boundary-and-compensation` asserts that the `emit compensation` its `on error` handler raises reaches the undo block of the subprocess that completed before the charge failed.
`booking-attempt` asserts the same machinery on the other route into it: when the block is given up, the engine must have run the undo block of the step that had already finished before the cancel handler opens.
`branch-and-race` asserts the two engine behaviors the compiled document cannot show on its own.
An inclusive join waits for exactly the branches the conditions opened, so completing one of two open tasks leaves the token at the join.
The first trigger of a race to fire cancels the wait the other branch was holding: the losing timer job disappears, and the instance's history holds the message catch and the `Handover` task behind it, with no row for the timer catch or `ChaseCarrier`.
`forms-and-external-tasks` asserts what the engine does with what a compiled document only declares: a worker fetching the charge sees its priority and its properties, a failure it reports ends through the declined handler when its message matches the mapping and stays on the topic for a retry when it does not, and the form service refuses a submission that leaves the required enum empty or names a value outside its list.
Its last case runs a user task assigned with `bpmn:humanPerformer` and `bpmn:potentialOwner` through the importer, deploys the re-exported document, and asserts the engine builds the assignee, candidate users, and candidate groups the source declared.

Docker tests run by default and are skipped only when `SKIP_DOCKER_TESTS=true`, which is what CI sets.

## Adding a new deployment mode

1. Create a subdirectory with a `README.md` and whatever runtime files it needs, such as a `pom.xml`, `Dockerfile`, or `docker-compose.yml`.
2. Implement the `FixtureAdapter` interface from `tests/fixtures/types.ts` in a new file under `tests/fixtures/adapters/`.
3. Register the mode in `tests/fixtures/index.ts` by extending the `startFixture` switch.
