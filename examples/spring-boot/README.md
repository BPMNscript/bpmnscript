# examples/spring-boot

Operaton 2.1.0 embedded in Spring Boot 4.0.6, the engine the end-to-end tests deploy to.
It starts with nothing deployed, and each test deploys its processes over REST.

It's also a hands-on demo: the `demo` profile deploys the compiled example processes and serves the Operaton web apps, Cockpit and Tasklist, so you can start instances and complete tasks by hand ([Running processes on Operaton](#running-processes-on-operaton-demo)).

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

Wait for the container to become healthy, which takes 30 to 60 seconds, then check the engine is up:

```bash
curl http://localhost:8080/engine-rest/engine
# Expected: [{"name":"default"}]
```

When you're done:

```bash
docker stop bpmnscript-invoice && docker rm bpmnscript-invoice
```

## REST endpoints the tests use

The deployment and lifecycle calls the fixture adapter makes:

| Method | Path                                              | Purpose                                                          |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/engine-rest/engine`                             | Health check; returns 200 with `[{"name":"default"}]` when ready |
| `POST` | `/engine-rest/deployment/create`                  | Deploy a BPMN XML file (multipart/form-data)                     |
| `POST` | `/engine-rest/process-definition/key/{key}/start` | Start a process instance by definition key                       |
| `GET`  | `/engine-rest/task?processInstanceId={id}`        | List active user tasks for a process instance                    |
| `POST` | `/engine-rest/task/{id}/complete`                 | Complete a user task, optionally setting variables               |

The assertions query more of the same API through `tests/helpers/engine-rest.ts`.

## Admin credentials

Username `demo`, password `demo`, configured in `src/main/resources/application.yml`.

> For anything beyond local testing, replace the `operaton.bpm.admin-user` block with a real credential, for example from an environment variable.

## Running processes on Operaton (demo)

Compile the BPMNscript processes, deploy them to a real Operaton engine, and drive them from Cockpit and Tasklist.
Loan approval is the worked example, and you can [add your own process](#add-your-own-process).

The sources are in [`processes/`](processes).
The compile step writes a `.bpmn` for each into `src/main/resources/processes/`, which is git-ignored, and the `demo` profile deploys them all on startup.

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
It needs a JDK 17 and Maven on `PATH`; the Docker variant below needs neither.
From `examples/spring-boot/`, either run it with Maven:

```bash
mvn clean spring-boot:run -Dspring-boot.run.profiles=demo
```

Keep the `clean`.
It empties `target/`, where a process you renamed or removed would otherwise linger as a stale copy, and two definitions with the same key make Operaton refuse to start (`The deployment contains definitions with the same key ...`).

Or run it in Docker with `SPRING_PROFILES_ACTIVE=demo`:

```bash
docker build -t bpmnscript-demo .
docker run -d --name bpmnscript-demo -p 8080:8080 -e SPRING_PROFILES_ACTIVE=demo bpmnscript-demo
```

### 4. Open the web apps

Go to <http://localhost:8080/operaton/app/welcome/> and log in with `demo` / `demo`.
Every compiled process is deployed: Cockpit shows instances and live diagrams, and Tasklist starts processes and completes their tasks.

### The loan approval walkthrough

This is the loan approval example from the [WS-BPEL 2.0 specification](https://docs.oasis-open.org/wsbpel/2.0/wsbpel-v2.0.html).
A request arrives with an `amount` and a `creditScore`.
Loans under 10,000 are screened by an automated risk assessment, and a low-risk small loan is approved automatically.
Everything else, large loans and small loans that aren't low-risk, goes to a human "Approve loan" task.
The outcome is recorded as `decision = ACCEPTED` or `REJECTED`.
Its four service tasks are `JavaDelegate`s in [`src/main/java/com/example/loan/`](src/main/java/com/example/loan).

1. Start a request.
   In Tasklist, choose Start process, then Loan Approval, and fill in the start form: Loan amount (`amount`), for example `5000`, and Credit score (`creditScore`), for example `750`.

2. Watch the automatic path.
   With `amount = 5000` and `creditScore = 750` the risk assessment returns low risk, so the loan is approved with no human step and ends with `decision = ACCEPTED`.
   Open Cockpit, then Processes, then Loan Approval to see the finished instance, the path it took, and its variables.

3. Watch the human path.
   Start another request with `amount = 25000`, or a small loan that fails the risk screen (`amount = 5000`, `creditScore = 400`, since the assessment marks scores below 600 as high risk).
   The instance stops at the "Approve loan" task, which appears under the `demo` user in Tasklist.
   Open it, tick "Approve the loan?" to accept or leave it unticked to reject, and Complete.
   The instance then records `ACCEPTED` or `REJECTED`.

In Cockpit, open the live diagram of a running instance to watch the token sit on "Approve loan" and move once you complete it.

### Variant: Kopp 2009

`loan-approval-kopp` is the parallel-rating variant of that process, following Kopp, Martin, Wutke, and Leymann's ["The Difference Between Graph-Based and Block-Structured Business Process Modelling Languages"](https://doi.org/10.18417/emisa.4.1.1) (EMISA 4(1), 2009).
The request is rated in parallel by two external bureaus and one internal service, and a low internal rating additionally routes through a human "Manual risk assessment".
It accepts when both external bureaus rate low, or when the internal rating is low and the assessor agrees (`assessorRes = low`).
Its delegates live in `src/main/java/com/example/loan/kopp/`.

Start it the same way, through Start process and Loan Approval (Kopp 2009), with `amount` and `creditScore` in the start form.
The manual-assessment task's form shows the pre-seeded `assessorRes`: set it to `low` to approve that path, leave it `high` to decline.
Inputs to try:

- `creditScore = 750`, `amount = 5000`: all three rate low.
  Both externals rating low already grants acceptance, but the assessor task still appears because the internal rating is low, so complete it to let the instance finish.
- `creditScore = 720`, `amount = 60000`: S1 low, S2 high, internal low, so the assessor decides.
  `assessorRes = low` accepts, `high` rejects.
- `creditScore = 400`, `amount = 60000`: nothing rates low, so it goes straight to reject with no human step.

### Add your own process

1. Write a `.bpmnscript` and drop it in [`processes/`](processes).
2. For a service task that only needs to run and continue, point it at the generic delegate: `service DoThing(label: "Do thing", class: "com.example.demo.LogDelegate")`.
   For real behavior, such as setting variables or branching, add a `JavaDelegate` under `src/main/java/` and reference its class instead; the [`com.example.loan`](src/main/java/com/example/loan) delegates are the model.
3. Recompile (step 2) and restart the engine (step 3), and the new process shows up in Cockpit and Tasklist.

## Configuration notes

Classpath auto-deployment is off by default (`operaton.bpm.auto-deployment-enabled: false`), so the tests deploy everything over REST and every run starts from an empty engine.
The `demo` profile (`application-demo.yml`) turns it on to deploy the compiled processes at startup.
The history level is `audit`, which records the task and variable history the end-to-end assertions read.
H2 runs in memory, so process state lives only as long as the container, and the two-stage Dockerfile ships only the fat jar on a plain JRE.
