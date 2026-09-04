# Examples

Deployment fixtures for running a compiled `.bpmn` file on Operaton.

One mode exists today: `spring-boot/`, with Operaton embedded in a Spring Boot application.
Two more are planned and have no fixture yet: an Operaton REST engine with external-task workers, and a standalone Operaton engine without Spring Boot.

## `spring-boot/`

The fixture runs Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application on Java 17, exposing the Operaton REST API on port 8080.
It's packaged as a Docker image so the integration test harness can start and stop it programmatically.

Sixteen DSL sources live under `spring-boot/processes/`, one per construct or construct combination.
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

[Running processes on Operaton](spring-boot/README.md#running-processes-on-operaton-demo) is a hands-on tour of the two loan-approval processes.

### Testcontainers harness

Eight E2E test files in `tests/e2e/` use [testcontainers-node](https://testcontainers.com/) to start the Docker image, deploy compiled BPMN over the Operaton REST API, start instances, and assert engine behaviour: `invoice-approval`, `parallel-approval`, `loan-approval`, `loan-approval-kopp`, `boundary-events` (over `order-handling`), `awaiting-confirmation`, `engine-extensions`, and `service-boundary-and-compensation` (over `charge-with-recovery` and `compensating-saga` in one container boot).
The remaining fixtures are demo-only.

The compensation half of the last one is deliberately soft: it hard-asserts that the failure and its `on error` handler run, then observes whether `emit compensation` reaches the completed subprocess's undo block on the live engine, reporting that as a greppable log line rather than a pass or fail.

Docker tests run by default and are skipped only when `SKIP_DOCKER_TESTS=true`, which is what CI sets.

## Adding a new deployment mode

1. Create a subdirectory with a `README.md` and whatever runtime files it needs, such as a `pom.xml`, `Dockerfile`, or `docker-compose.yml`.
2. Implement the `FixtureAdapter` interface from `tests/fixtures/types.ts` in a new file under `tests/fixtures/adapters/`.
3. Register the mode in `tests/fixtures/index.ts` by extending the `startFixture` switch.
