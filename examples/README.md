# Examples

This directory contains deployment fixtures for running a compiled `.bpmn` file (from
the `bpmns build` command) on Operaton. One mode is implemented today; the others are
roadmap.

## Deployment modes

| Directory | Mode | Status |
|-----------|------|--------|
| `spring-boot/` | Operaton embedded in a Spring Boot application | **Implemented** |

Planned (no fixture yet): an Operaton REST engine with external-task workers, and a
standalone Operaton engine without Spring Boot.

## `spring-boot/`

The `spring-boot/` fixture runs Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application
(Java 17). It is packaged as a Docker image so the integration test harness can start
and stop it programmatically. The fixture exposes the Operaton REST API on port 8080.

Two canonical DSL sources live under `spring-boot/processes/`:

- `invoice-approval.bpmnscript` — start → review user task → exclusive gateway (amount > 1000) → senior-approval or auto-approve service task → end. Exercises `if`/`else` desugaring.
- `parallel-approval.bpmnscript` — start → parallel AND-split into two concurrent user tasks → AND-join → end. Exercises `parallel { { } { } }` desugaring.

Running `bpmns build` on either file produces the deployable `.bpmn` artifact.

### Testcontainers harness

Two E2E test files in `tests/e2e/` use [testcontainers-node](https://testcontainers.com/) to start the Docker image, deploy compiled BPMN via the Operaton REST API, start process instances, and assert engine behaviour:

- `invoice-approval.test.ts` — deploys the invoice-approval process, completes the `ReviewInvoice` task, and asserts routing by amount (> 1000 → `SeniorApproval`; ≤ 1000 → `AutoApprove` delegate → process ends).
- `parallel-approval.test.ts` — deploys the parallel-approval process and asserts that both `ApproveA` and `ApproveB` tasks are active concurrently before the AND-join fires.

The harness is gated by the `SKIP_DOCKER_TESTS` environment variable: Docker tests run by default and are only skipped when `SKIP_DOCKER_TESTS=true` (set in CI).

## Adding a new deployment mode

1. Create a subdirectory with a `README.md` and whatever runtime files are needed
   (e.g. a `pom.xml`, `Dockerfile`, or `docker-compose.yml`).
2. Implement the `FixtureAdapter` interface defined in `tests/fixtures/` (see
   `tests/fixtures/types.ts`) by adding a new adapter file under
   `tests/fixtures/adapters/`.
3. Register the new mode in `tests/fixtures/index.ts` by extending the
   `startFixture` switch statement.
