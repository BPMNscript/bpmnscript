# Examples

Deployment fixtures for running a compiled `.bpmn` file on Operaton.
There is one so far, `spring-boot/`.

## `spring-boot/`

Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application on Java 17, serving the Operaton REST API on port 8080.
It's packaged as a Docker image so the end-to-end tests can start and stop it, and its [README](spring-boot/README.md#running-processes-on-operaton-demo) is a hands-on tour of running the processes in Cockpit and Tasklist.

Each source under `spring-boot/processes/` covers one construct or combination, and `bpmns build` on any of them produces a deployable `.bpmn`.

| Source                  | Covers                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| `invoice-approval`      | `if`/`else`                                                                |
| `parallel-approval`     | `parallel { { } { } }`                                                     |
| `service-delegate`      | The `delegate` service binding, against a Spring-managed bean              |
| `service-expression`    | The `expression` service binding, a JUEL expression Operaton evaluates     |
| `external-task`         | The `topic` binding, against a worker polling `print-label`                |
| `script-task`           | A `script` task's fenced body, in Groovy                                   |
| `purchasing`            | A `call` activity into `invoice-approval`, with in and out mappings        |
| `order-handling`        | Sub-process containment, plus interrupting and non-interrupting boundaries |
| `order-recovery`        | The error and escalation layer, both handler kinds                         |
| `order-reminder`        | The timer and message triggers                                             |
| `loan-approval`         | The demo walkthrough                                                       |
| `loan-approval-kopp`    | The demo walkthrough, parallel-rating variant                              |
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
| `nightly-report`        | An async join, per-run jobs on a repetition, and a shell task              |
| `outage-notice`         | A mail task, deployed and never started                                    |
| `expense-claim`         | A `while` loop, an `if`/`else`, and a `parallel` block in one process      |
| `claim-routing`         | `else fail` closing an `if` chain and a conditioned `parallel` block       |

### End-to-end tests

The tests in `tests/e2e/` use [testcontainers](https://testcontainers.com/) to start the Docker image, deploy compiled BPMN over the Operaton REST API, start instances, and check what the engine does.
The suite builds the image and starts one engine, and every test file runs against it.
`deploy-sweep` deploys every golden under `tests/golden/`, every fixture under `tests/fixtures/`, and every example here, once as written and once rebuilt from the tool's own print of it.
The engine is expected to refuse the `bad-service-task-no-binding` golden, and that golden and `tests/fixtures/error-start.bpmn`, which the importer refuses, deploy only as written.

The Docker tests run by default, in CI too, and are skipped only when `SKIP_DOCKER_TESTS=true`.

## Adding a deployment

1. Create a subdirectory with a `README.md` and the runtime files it needs, such as a `pom.xml`, `Dockerfile`, or `docker-compose.yml`.
2. Implement the `FixtureAdapter` interface from `tests/fixtures/types.ts` in a new file under `tests/fixtures/adapters/`.
3. Make `startFixture` in `tests/fixtures/index.ts` choose between adapters, for example by a mode argument; it starts the Spring Boot one unconditionally today.
