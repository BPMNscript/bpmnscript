# examples/spring-boot — Operaton 2.1.0 on Spring Boot 4.0.6

This directory contains the Spring Boot deployment fixture for the BPMNscript E2E test harness.
It ships a minimal Operaton 2.1.0 process engine exposed entirely through the Operaton REST API.
The engine starts with no pre-deployed processes; the testcontainers harness deploys definitions
at test time via REST.

## Stack

| Component | Version | Notes |
|---|---|---|
| Spring Boot | **4.0.6** | Operaton 2.1.0 verified compatible with Spring Boot 4.0.6 |
| Operaton | **2.1.0** | `operaton-bpm-spring-boot-starter` + `operaton-bpm-spring-boot-starter-rest` |
| Java | **17** | Hard-pinned |
| Database | H2 (in-memory) | Sufficient for CI/testing |

## Build and run locally

```bash
# From this directory:
docker build -t bpmnscript-invoice .
docker run -d --name bpmnscript-invoice -p 8080:8080 bpmnscript-invoice
```

When you are done, stop and remove the container:

```bash
docker stop bpmnscript-invoice && docker rm bpmnscript-invoice
```

Wait for the container to become healthy (roughly 30–60 s on first run, faster with cached layers),
then verify the engine is up:

```bash
curl http://localhost:8080/engine-rest/engine
# Expected: [{"name":"default"}]
```

## REST endpoints used by the testcontainers harness

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/engine-rest/engine` | Health check — returns 200 with `[{"name":"default"}]` when ready |
| `POST` | `/engine-rest/deployment/create` | Deploy a BPMN XML file (multipart/form-data) |
| `POST` | `/engine-rest/process-definition/key/{key}/start` | Start a process instance by definition key |
| `GET` | `/engine-rest/task?processInstanceId={id}` | List active user tasks for a process instance |

## Admin credentials

Username: `demo` / Password: `demo` (configured in `src/main/resources/application.yml`).

> For any non-test deployment the `operaton.bpm.admin-user` block should be replaced with a real credential and probably moved to an env var.

## Design decisions

- **Auto-deployment disabled.** `operaton.bpm.auto-deployment-enabled: false` prevents the engine
  from scanning the classpath for `.bpmn` files. All deployments happen via REST, which keeps the
  fixture stateless and lets multiple test runs deploy different definitions without interference.
- **In-memory H2.** Process state survives only for the lifetime of the container, which is exactly
  what an ephemeral testcontainers instance requires.
- **Two-stage Dockerfile.** The Maven build stage is separated from the JRE runtime stage so the
  final image contains only the fat jar and a lean JRE, not the full JDK or Maven toolchain.
