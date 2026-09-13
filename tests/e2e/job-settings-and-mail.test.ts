// A job setting on a gateway or on a loop element, and a shell task the engine
// runs itself, compile to well-formed XML that shows nothing of what the
// engine does with them. This suite boots a real Operaton and reads back what
// it did: the jobs an async join parks, one per arriving branch; the three
// jobs a repetition of three parks with `runAsyncBefore`, one per run and none
// around the repetition; the output and exit code a shell `echo` wrote into
// the variables its fields name; and a mail task the engine builds at
// deployment, beside one it refuses for want of a body.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  irOfExample,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  engineGet,
  historicActivities,
  historicVariables,
  isRunning,
  jobDefinitionsFor,
  jobsOfInstance,
  setJobDefinitionSuspended,
  waitFor,
  waitUntilFinished,
} from '../helpers/engine-rest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPORT_KEY = 'nightly-report';
const NOTICE_KEY = 'outage-notice';

const REPEATED_STEP = 'CountEntries';

// After sitting idle the job executor backs its acquisition off to as much as
// a minute (BackoffJobAcquisitionStrategy.reconfigureIdleLevel), and
// unsuspending a definition does not wake it the way a new job does.
const EXECUTOR_TIMEOUT_MS = 60_000;

// A mail task with a recipient and no body. The validator refuses the script
// that would say this, so the document reaches the engine from the IR.
const BODYLESS_MAIL_KEY = 'bodyless-mail';
const BODYLESS_MAIL: BpmnProcess = {
  id: BODYLESS_MAIL_KEY,
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    {
      kind: 'serviceTask',
      id: 'Notify',
      binding: {
        kind: 'builtin',
        type: 'mail',
        fields: [{ name: 'to', value: 'ops@example.com' }],
      },
    },
    { kind: 'endEvent', id: 'End_1' },
  ],
  sequenceFlows: [
    { id: 'f1', sourceRef: 'Start_1', targetRef: 'Notify' },
    { id: 'f2', sourceRef: 'Notify', targetRef: 'End_1' },
  ],
};

describe.skipIf(SKIP)('E2E: job settings, shell and mail tasks', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(REPORT_KEY, NOTICE_KEY);
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  }, ENGINE_STOP_TIMEOUT_MS);

  // The definition and suspension state of each job once the instance holds
  // the expected number of them.
  async function parkedJobs(
    processInstanceId: string,
    count: number,
  ): Promise<Array<[string, boolean]>> {
    const jobs = await waitFor(
      () => jobsOfInstance(fixture, processInstanceId),
      (found) => found.length === count,
      30_000,
    );
    return jobs.map((job) => [job.jobDefinitionId, job.suspended]);
  }

  async function visitedActivityIds(
    processInstanceId: string,
  ): Promise<string[]> {
    return (await historicActivities(fixture, processInstanceId))
      .map((activity) => activity.activityId)
      .sort();
  }

  it('an async join parks one job per arriving branch until the executor runs it, and the report completes', async () => {
    const ir = await irOfExample(REPORT_KEY);
    const gatewayIds = ir.flowElements
      .filter((el) => el.kind === 'parallelGateway')
      .map((el) => el.id);
    const asyncGateways = ir.flowElements.filter(
      (el) => el.kind === 'parallelGateway' && el.asyncBefore === true,
    );
    expect(asyncGateways).toHaveLength(1);
    const joinId = asyncGateways[0]!.id;

    // The engine's own reading of `joinAsyncBefore`: this job definition
    // exists only because the deployment declared a transaction boundary
    // on the join.
    const definitions = await jobDefinitionsFor(fixture, REPORT_KEY, joinId);
    expect(definitions.map((d) => [d.jobType, d.jobConfiguration])).toEqual([
      ['async-continuation', 'async-before'],
    ]);
    const definition = definitions[0]!;

    // Suspend first: otherwise the job executor runs the jobs within
    // milliseconds of the transaction committing and the parked state is gone.
    await setJobDefinitionSuspended(fixture, definition.id, true);
    const { processInstanceId } = await fixture.startProcess(REPORT_KEY);

    // Both gather steps ran in the starting transaction; each token then
    // stopped on the transition into the join, one job apiece.
    expect(await parkedJobs(processInstanceId, 2)).toEqual([
      [definition.id, true],
      [definition.id, true],
    ]);
    expect(await isRunning(fixture, processInstanceId)).toBe(true);
    expect(
      (await visitedActivityIds(processInstanceId)).filter(
        (id) => !gatewayIds.includes(id),
      ),
    ).toEqual(['GatherSales', 'GatherStock', 'NightlyRun']);

    await setJobDefinitionSuspended(fixture, definition.id, false);
    expect(
      await waitUntilFinished(fixture, processInstanceId, EXECUTOR_TIMEOUT_MS),
    ).toBe(true);

    // History holds the join once per token that entered it, and the
    // repetition's body as an activity of its own beside its three runs.
    expect(await visitedActivityIds(processInstanceId)).toEqual(
      [
        ...gatewayIds,
        joinId,
        'NightlyRun',
        'GatherSales',
        'GatherStock',
        REPEATED_STEP,
        REPEATED_STEP,
        REPEATED_STEP,
        `${REPEATED_STEP}#multiInstanceBody`,
        'RecordHost',
        'ReportBuilt',
      ].sort(),
    );
  }, 90_000);

  it('a repetition with runAsyncBefore makes one job per run, not one around the repetition', async () => {
    const perRun = await jobDefinitionsFor(fixture, REPORT_KEY, REPEATED_STEP);
    expect(perRun.map((d) => [d.jobType, d.jobConfiguration])).toEqual([
      ['async-continuation', 'async-before'],
    ]);
    expect(
      await jobDefinitionsFor(
        fixture,
        REPORT_KEY,
        `${REPEATED_STEP}#multiInstanceBody`,
      ),
    ).toEqual([]);
    const definition = perRun[0]!;

    await setJobDefinitionSuspended(fixture, definition.id, true);
    const { processInstanceId } = await fixture.startProcess(REPORT_KEY);

    // The join's own jobs run first, so what is parked is the three runs.
    expect(await parkedJobs(processInstanceId, 3)).toEqual([
      [definition.id, true],
      [definition.id, true],
      [definition.id, true],
    ]);

    await setJobDefinitionSuspended(fixture, definition.id, false);
    expect(
      await waitUntilFinished(fixture, processInstanceId, EXECUTOR_TIMEOUT_MS),
    ).toBe(true);
    expect(
      (await visitedActivityIds(processInstanceId)).filter(
        (id) => id === REPEATED_STEP,
      ),
    ).toHaveLength(3);
  }, 90_000);

  it('a shell task runs the command and writes its output and exit code to the named variables', async () => {
    const { processInstanceId } = await fixture.startProcess(REPORT_KEY);
    expect(
      await waitUntilFinished(fixture, processInstanceId, EXECUTOR_TIMEOUT_MS),
    ).toBe(true);

    // ShellActivityBehavior.convertStreamToStr keeps stdout verbatim, newline
    // included, and the exit code is written as a string.
    const written = Object.fromEntries(
      (await historicVariables(fixture, processInstanceId))
        .filter(({ name }) => ['reportHost', 'reportHostExit'].includes(name))
        .map(({ name, value }) => [name, value]),
    );
    expect(written).toEqual({
      reportHost: 'report-host\n',
      reportHostExit: '0',
    });
  }, 90_000);

  it("a mail task deploys, and one the engine's parse refuses is refused with its message", async () => {
    const deployed = await engineGet<Array<{ key: string }>>(
      fixture,
      `/engine-rest/process-definition?key=${NOTICE_KEY}`,
      `definitionsOf(${NOTICE_KEY})`,
    );
    expect(deployed.map((d) => d.key)).toEqual([NOTICE_KEY]);

    const xmlPath = resolve(__dirname, `../../out/${BODYLESS_MAIL_KEY}.bpmn`);
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, await irToXml(BODYLESS_MAIL));

    // BpmnParse.validateFieldDeclarationsForEmail, the check the validator
    // mirrors for a script.
    await expect(
      fixture.deploy(xmlPath, `${BODYLESS_MAIL_KEY}-test`),
    ).rejects.toThrow('Text or html field should be provided');
  }, 60_000);
});
