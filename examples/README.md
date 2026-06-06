# Examples

This directory contains deployment fixtures for the three planned Operaton deployment
modes. Each subdirectory is a self-contained runtime environment that can receive a
compiled `.bpmn` file from the `bpmns build` command and execute it.

## Deployment modes

| Directory | Mode | Status |
|-----------|------|--------|
| `spring-boot/` | Operaton embedded in a Spring Boot application | **Implemented** |
| `external-tasks/` | Operaton REST engine with external-task workers | Not implemented |
| `standalone/` | Standalone Operaton engine (no Spring Boot) | Not implemented |

## `spring-boot/`

The `spring-boot/` fixture runs Operaton 2.1.0 embedded in a Spring Boot 4.0.6 application
(Java 17). It is packaged as a Docker image so the integration test harness can start
and stop it programmatically. The fixture exposes the Operaton REST API on port 8080.

The canonical DSL source for the sample process lives at
`spring-boot/processes/invoice-approval.bpmnscript`. Running `bpmns build` on
that file produces the deployable `invoice-approval.bpmn` artifact.

### Testcontainers harness

The E2E test suite in `tests/e2e/invoice-approval.test.ts` uses
[testcontainers-node](https://testcontainers.com/) to start the Docker image, deploy
the compiled BPMN via the Operaton REST API, start a process instance, and assert that
the expected user task is active. The harness is gated by the `SKIP_DOCKER_TESTS`
environment variable: Docker tests run by default and are only skipped
when `SKIP_DOCKER_TESTS=true` (set in CI).

## Adding a new deployment mode

1. Create a subdirectory with a `README.md` and whatever runtime files are needed
   (e.g. a `pom.xml`, `Dockerfile`, or `docker-compose.yml`).
2. Implement the `FixtureAdapter` interface defined in `tests/fixtures/` (see
   `tests/fixtures/types.ts`) by adding a new adapter file under
   `tests/fixtures/adapters/`.
3. Register the new mode in `tests/fixtures/index.ts` by extending the
   `startFixture` switch statement.
