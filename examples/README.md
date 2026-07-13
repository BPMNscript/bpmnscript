# Examples

This directory contains deployment fixtures for running a compiled `.bpmn` file (from
the `bpmns build` command) on Operaton. One mode is implemented today; the others are
roadmap.

## Deployment modes

Implemented: `spring-boot/` — Operaton embedded in a Spring Boot application. Planned
(no fixture yet): an Operaton REST engine with external-task workers, and a standalone
Operaton engine without Spring Boot.

## `spring-boot/`

The `spring-boot/` fixture runs Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application
(Java 17). It is packaged as a Docker image so the integration test harness can start
and stop it programmatically. The fixture exposes the Operaton REST API on port 8080.

Four DSL sources live under `spring-boot/processes/`:

- `invoice-approval.bpmnscript` — start → review user task → exclusive gateway (amount > 1000) → senior-approval or auto-approve service task → end. Exercises `if`/`else` desugaring.
- `parallel-approval.bpmnscript` — start → parallel AND-split into two concurrent user tasks → AND-join → end. Exercises `parallel { { } { } }` desugaring.
- `loan-approval.bpmnscript` and `loan-approval-kopp.bpmnscript` — the loan-approval walkthrough (plain and parallel-rating variants) used by the `demo` profile; see [Running processes on Operaton](spring-boot/README.md#running-processes-on-operaton-demo) for a hands-on tour of both.

`invoice-approval` and `parallel-approval` are also the two processes exercised by the automated E2E suite below; the loan-approval variants are demo-only fixtures.

Running `bpmns build` on any of the four files produces the deployable `.bpmn` artifact.

### Testcontainers harness

Two E2E test files in `tests/e2e/` use [testcontainers-node](https://testcontainers.com/) to start the Docker image, deploy compiled BPMN via the Operaton REST API, start process instances, and assert engine behaviour:

- `invoice-approval.test.ts` — deploys the invoice-approval process, completes the `ReviewInvoice` task, and asserts routing by amount (> 1000 → `SeniorApproval`; ≤ 1000 → `AutoApprove` delegate → process ends).
- `parallel-approval.test.ts` — deploys the parallel-approval process and asserts that both `ApproveA` and `ApproveB` tasks are active concurrently before the AND-join fires.

The harness is gated by the `SKIP_DOCKER_TESTS` environment variable: Docker tests run by default and are only skipped when `SKIP_DOCKER_TESTS=true` (set in CI).

## `constructs/`

One minimal `.bpmnscript` program per construct beyond the plain `class`-bound
service task: `service-expression.bpmnscript` (`expression = "${…}"` binding),
`service-delegate.bpmnscript` (`delegate = "${…}"` binding), `external-task.bpmnscript`
(the `external` statement with a `topic`), and `script-task.bpmnscript` (the `script`
statement with a fenced JavaScript body). Each demonstrates the syntax rather than
deploying anywhere — they are not wired into the `spring-boot/` Maven build — and
are exercised by the round-trip test in `tests/new-constructs.round-trip.test.ts`.

## Adding a new deployment mode

1. Create a subdirectory with a `README.md` and whatever runtime files are needed
   (e.g. a `pom.xml`, `Dockerfile`, or `docker-compose.yml`).
2. Implement the `FixtureAdapter` interface defined in `tests/fixtures/` (see
   `tests/fixtures/types.ts`) by adding a new adapter file under
   `tests/fixtures/adapters/`.
3. Register the new mode in `tests/fixtures/index.ts` by extending the
   `startFixture` switch statement.
