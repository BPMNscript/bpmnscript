# examples/spring-boot — Operaton 2.1.0 on Spring Boot 4.0.6

This directory contains the Spring Boot deployment fixture for the BPMNscript E2E test harness.
It ships a minimal Operaton 2.1.0 process engine. By default the engine starts with no pre-deployed
processes; the testcontainers harness deploys definitions at test time via REST.

It also doubles as a hands-on demo. The `demo` profile compiles and deploys the example processes and
serves the Operaton web apps (Cockpit, Tasklist) so you can start instances and complete tasks by
hand — see [Running processes on Operaton](#running-processes-on-operaton-demo).

## Stack

| Component | Version | Notes |
|---|---|---|
| Spring Boot | **4.0.6** | Operaton 2.1.0 verified compatible with Spring Boot 4.0.6 |
| Operaton | **2.1.0** | `operaton-bpm-spring-boot-starter` + `-rest` + `-webapp` (Cockpit/Tasklist) |
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

## Running processes on Operaton (demo)

This module doubles as a hands-on harness: compile any BPMNscript process to BPMN, deploy it to a real
Operaton engine, and drive it from the Cockpit and Tasklist web apps. The **loan approval** process is
the worked example; you can add your own (see [Add your own process](#add-your-own-process)).

The `.bpmnscript` sources live in [`processes/`](processes). The compile step turns each one into a
deployable `.bpmn` under `src/main/resources/processes/` (generated, git-ignored), and the `demo`
profile auto-deploys them all on startup.

### 1. Build the toolchain

The compile step uses the project's own CLI, so build the workspace once — from the **repo root**:

```bash
npm run build
```

### 2. Compile the processes

From **`examples/spring-boot/`**, compile every `processes/*.bpmnscript` into
`src/main/resources/processes/`:

```bash
cd examples/spring-boot
./compile-processes.sh
```

Re-run this whenever you edit or add a `.bpmnscript`.

### 3. Start the engine (demo profile)

The `demo` profile turns on classpath auto-deployment and serves the web apps. From
**`examples/spring-boot/`**, either run it locally with Maven:

```bash
mvn clean spring-boot:run -Dspring-boot.run.profiles=demo
```

The `clean` matters: it wipes `target/` so a process you renamed or removed doesn't linger there as a
stale compiled copy. Two deployed definitions with the same key make Operaton refuse to start
(`The deployment contains definitions with the same key …`).

…or in Docker (note the `SPRING_PROFILES_ACTIVE=demo` env var):

```bash
docker build -t bpmnscript-demo .
docker run -d --name bpmnscript-demo -p 8080:8080 -e SPRING_PROFILES_ACTIVE=demo bpmnscript-demo
```

### 4. Open the web apps

Go to <http://localhost:8080/operaton/app/welcome/> and log in with `demo` / `demo`. Every compiled
process is deployed — pick one in **Cockpit** (watch instances and live diagrams) or **Tasklist**
(start one and complete its tasks).

### The loan approval walkthrough

The classic WS-BPEL loan approval. A request arrives with an `amount` and a `creditScore`. Loans under
10,000 are screened by an automated risk assessment, and a low-risk small loan is approved
automatically. Everything else — large loans, or small loans that aren't low-risk — goes to a human
**Approve loan** task. The outcome is recorded as `decision = ACCEPTED` or `REJECTED`. Its four service
tasks are `JavaDelegate`s in [`src/main/java/com/example/loan/`](src/main/java/com/example/loan).

1. **Start a request.** In **Tasklist**, choose **Start process → Loan Approval**. There's no start
   form, so use **Add a variable** to set two variables, then **Start**:
   - `amount` — type `Long` (e.g. `5000`)
   - `creditScore` — type `Long` (e.g. `750`)

2. **The automatic path.** With `amount = 5000` and `creditScore = 750` the risk assessment returns
   low risk, so the loan is approved with no human step and ends with `decision = ACCEPTED`. Open
   **Cockpit → Processes → Loan Approval** to see the finished instance, the path it took, and its
   variables.

3. **The human path.** Start another request with `amount = 25000` (or a small loan with
   `creditScore = 400`). The instance stops at the **Approve loan** task, which appears under the
   `demo` user in **Tasklist**. Open it and, on **Complete**, add one variable:
   - `approved` — type `Boolean` — `true` to accept, `false` to reject.

   The instance then records `ACCEPTED` or `REJECTED`. Complete the task without setting `approved`
   and it defaults to rejected.

In **Cockpit**, open the live diagram of a running instance to watch the token sit on **Approve loan**
and move once you complete it.

### Variant: Kopp 2009

`loan-approval-kopp` is the parallel-rating variant from Kopp et al. (2009) — the same paper in the
thesis bibliography. The request is rated in parallel by two external bureaus and one internal
service; a low internal rating additionally routes through a human **Manual risk assessment**. It
accepts when both external bureaus rate low, or the internal rating is low **and** the assessor agrees
(`assessorRes = low`). Its delegates live in `src/main/java/com/example/loan/kopp/`.

Start it the same way (**Start process → Loan Approval (Kopp 2009)**) with `amount` and `creditScore`
(Long). The manual-assessment task edits the pre-seeded `assessorRes` (string) — set it to `low` to
approve that path, leave it `high` to decline. Some telling inputs:

- `creditScore = 750`, `amount = 5000` → all three rate low. Both externals low already grant
  acceptance, but the assessor task still appears (internal low) — complete it to let the instance
  finish.
- `creditScore = 720`, `amount = 60000` → S1 low, S2 high, internal low → the **assessor decides**:
  `assessorRes = low` accepts, `high` rejects.
- `creditScore = 400` → nothing rates low → straight to reject, no human step.

### Add your own process

1. Write a `.bpmnscript` and drop it in [`processes/`](processes).
2. For service tasks that just need to run and continue, point them at the generic delegate:
   `service DoThing "Do thing" { class = "com.example.demo.LogDelegate" }`. For real behaviour
   (setting variables, branching), add a `JavaDelegate` under `src/main/java/` and reference its class
   instead — the [`com.example.loan`](src/main/java/com/example/loan) delegates are the model.
3. Recompile (step 2) and restart the engine (step 3). The new process shows up in Cockpit/Tasklist.

## Design decisions

- **Auto-deployment disabled by default.** `operaton.bpm.auto-deployment-enabled: false` prevents the
  engine from scanning the classpath for `.bpmn` files. All test deployments happen via REST, which
  keeps the fixture stateless and lets multiple test runs deploy different definitions without
  interference. The `demo` profile (`application-demo.yml`) flips this on so the compiled processes
  under `src/main/resources/processes/` deploy on startup for the manual demo; the harness runs
  without that profile, so its behavior is unchanged.
- **In-memory H2.** Process state survives only for the lifetime of the container, which is exactly
  what an ephemeral testcontainers instance requires.
- **Two-stage Dockerfile.** The Maven build stage is separated from the JRE runtime stage so the
  final image contains only the fat jar and a lean JRE, not the full JDK or Maven toolchain.
