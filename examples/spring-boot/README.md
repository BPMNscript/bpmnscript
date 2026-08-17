# examples/spring-boot

Operaton 2.1.0 embedded in Spring Boot 4.0.6, the deployment fixture for the BPMNscript E2E test harness.
The engine starts with nothing pre-deployed; the testcontainers harness deploys definitions at test time over REST.

It doubles as a hands-on demo.
The `demo` profile compiles and deploys the example processes and serves the Operaton web apps, Cockpit and Tasklist, so you can start instances and complete tasks by hand.
See [Running processes on Operaton](#running-processes-on-operaton-demo).

## Stack

| Component   | Version        | Notes                                                                         |
| ----------- | -------------- | ----------------------------------------------------------------------------- |
| Spring Boot | 4.0.6          |                                                                               |
| Operaton    | 2.1.0          | `operaton-bpm-spring-boot-starter` plus `-rest` and `-webapp` for the webapps |
| Java        | 17             |                                                                               |
| Database    | H2 (in-memory) |                                                                               |

## Build and run locally

```bash
# From this directory:
docker build -t bpmnscript-invoice .
docker run -d --name bpmnscript-invoice -p 8080:8080 bpmnscript-invoice
```

Wait for the container to become healthy, roughly 30 to 60 seconds on a first run and faster with cached layers, then check the engine is up:

```bash
curl http://localhost:8080/engine-rest/engine
# Expected: [{"name":"default"}]
```

When you're done:

```bash
docker stop bpmnscript-invoice && docker rm bpmnscript-invoice
```

## REST endpoints the testcontainers harness uses

| Method | Path                                              | Purpose                                                          |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/engine-rest/engine`                             | Health check; returns 200 with `[{"name":"default"}]` when ready |
| `POST` | `/engine-rest/deployment/create`                  | Deploy a BPMN XML file (multipart/form-data)                     |
| `POST` | `/engine-rest/process-definition/key/{key}/start` | Start a process instance by definition key                       |
| `GET`  | `/engine-rest/task?processInstanceId={id}`        | List active user tasks for a process instance                    |

## Admin credentials

Username `demo`, password `demo`, configured in `src/main/resources/application.yml`.

> For any non-test deployment, replace the `operaton.bpm.admin-user` block with a real credential and probably move it to an env var.

## Running processes on Operaton (demo)

Compile any BPMNscript process to BPMN, deploy it to a real Operaton engine, and drive it from Cockpit and Tasklist.
Loan approval is the worked example, and you can add your own (see [Add your own process](#add-your-own-process)).

The `.bpmnscript` sources live in [`processes/`](processes).
The compile step turns each one into a deployable `.bpmn` under `src/main/resources/processes/`, which is generated and git-ignored, and the `demo` profile auto-deploys them all on startup.

### 1. Build the toolchain

The compile step uses the project's own CLI, so build the workspace once from the repo root:

```bash
npm run build
```

### 2. Compile the processes

From `examples/spring-boot/`, compile every `processes/*.bpmnscript` into `src/main/resources/processes/`:

```bash
cd examples/spring-boot
./compile-processes.sh
```

Re-run this whenever you edit or add a `.bpmnscript`.

### 3. Start the engine (demo profile)

The `demo` profile turns on classpath auto-deployment and serves the web apps.
From `examples/spring-boot/`, either run it with Maven:

```bash
mvn clean spring-boot:run -Dspring-boot.run.profiles=demo
```

The `clean` matters.
It wipes `target/`, so a process you renamed or removed doesn't linger there as a stale compiled copy; two deployed definitions with the same key make Operaton refuse to start (`The deployment contains definitions with the same key ...`).

Or run it in Docker, noting the `SPRING_PROFILES_ACTIVE=demo` env var:

```bash
docker build -t bpmnscript-demo .
docker run -d --name bpmnscript-demo -p 8080:8080 -e SPRING_PROFILES_ACTIVE=demo bpmnscript-demo
```

### 4. Open the web apps

Go to <http://localhost:8080/operaton/app/welcome/> and log in with `demo` / `demo`.
Every compiled process is deployed, so pick one in Cockpit to watch instances and live diagrams, or in Tasklist to start one and complete its tasks.

### The loan approval walkthrough

The classic WS-BPEL loan approval.
A request arrives with an `amount` and a `creditScore`.
Loans under 10,000 are screened by an automated risk assessment, and a low-risk small loan is approved automatically.
Everything else, meaning large loans and small loans that aren't low-risk, goes to a human "Approve loan" task.
The outcome is recorded as `decision = ACCEPTED` or `REJECTED`.
Its four service tasks are `JavaDelegate`s in [`src/main/java/com/example/loan/`](src/main/java/com/example/loan).

1. Start a request.
   In Tasklist, choose Start process, then Loan Approval.
   There's no start form, so use "Add a variable" to set two variables and then Start:
   - `amount`, type `Long`, for example `5000`
   - `creditScore`, type `Long`, for example `750`

2. Watch the automatic path.
   With `amount = 5000` and `creditScore = 750` the risk assessment returns low risk, so the loan is approved with no human step and ends with `decision = ACCEPTED`.
   Open Cockpit, then Processes, then Loan Approval to see the finished instance, the path it took, and its variables.

3. Watch the human path.
   Start another request with `amount = 25000`, or a small loan that fails the risk screen (`amount = 5000`, `creditScore = 400`, since the assessment marks scores below 600 as high risk).
   The instance stops at the "Approve loan" task, which appears under the `demo` user in Tasklist.
   Open it and, on Complete, add one variable:
   - `approved`, type `Boolean`, `true` to accept and `false` to reject

   The instance then records `ACCEPTED` or `REJECTED`.
   Complete the task without setting `approved` and it defaults to rejected.

In Cockpit, open the live diagram of a running instance to watch the token sit on "Approve loan" and move once you complete it.

### Variant: Kopp 2009

`loan-approval-kopp` is the parallel-rating variant from Kopp et al. (2009), the same paper in the thesis bibliography.
The request is rated in parallel by two external bureaus and one internal service, and a low internal rating additionally routes through a human "Manual risk assessment".
It accepts when both external bureaus rate low, or when the internal rating is low and the assessor agrees (`assessorRes = low`).
Its delegates live in `src/main/java/com/example/loan/kopp/`.

Start it the same way, through Start process and Loan Approval (Kopp 2009), with `amount` and `creditScore` as `Long`.
The manual-assessment task edits the pre-seeded `assessorRes` string: set it to `low` to approve that path, leave it `high` to decline.
Some telling inputs:

- `creditScore = 750`, `amount = 5000`: all three rate low.
  Both externals rating low already grants acceptance, but the assessor task still appears because the internal rating is low, so complete it to let the instance finish.
- `creditScore = 720`, `amount = 60000`: S1 low, S2 high, internal low, so the assessor decides.
  `assessorRes = low` accepts, `high` rejects.
- `creditScore = 400`, `amount = 60000`: nothing rates low, so it goes straight to reject with no human step.

### Add your own process

1. Write a `.bpmnscript` and drop it in [`processes/`](processes).
2. For a service task that only needs to run and continue, point it at the generic delegate: `service DoThing "Do thing" { class = "com.example.demo.LogDelegate" }`.
   For real behaviour, such as setting variables or branching, add a `JavaDelegate` under `src/main/java/` and reference its class instead; the [`com.example.loan`](src/main/java/com/example/loan) delegates are the model.
3. Recompile (step 2) and restart the engine (step 3), and the new process shows up in Cockpit and Tasklist.

## Configuration notes

Classpath auto-deployment is off by default (`operaton.bpm.auto-deployment-enabled: false`).
The test harness deploys everything over REST, which keeps the fixture stateless between runs.
The `demo` profile (`application-demo.yml`) turns it on to deploy the compiled processes under `src/main/resources/processes/` at startup.
H2 runs in-memory, so process state lives only as long as the container, and the two-stage Dockerfile keeps the runtime image down to the fat jar on a plain JRE.
