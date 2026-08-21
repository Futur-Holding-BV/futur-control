import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./github.js", () => ({
  latestRuns: vi.fn(),
  loadWorkflowRunDefinition: vi.fn(),
  failedRunErrorLines: vi.fn(),
  failedJobNames: vi.fn(),
  rerunFailedJobs: vi.fn(),
  findRestartWorkflow: vi.fn(),
  dispatchRestartWorkflow: vi.fn(),
}));

vi.mock("./actionlog.js", () => ({
  claimSelfHealAttempt: vi.fn(),
  findAutoRetry: vi.fn(),
  getActiveSelfHealIncident: vi.fn(),
  getSelfHealIncident: vi.fn(),
  logAction: vi.fn(),
  markSelfHealActionLogged: vi.fn(),
  markSelfHealFailure: vi.fn(),
  markSelfHealRecovered: vi.fn(),
  markSelfHealRunning: vi.fn(),
  markSelfHealUnavailable: vi.fn(),
  updateOutcome: vi.fn(),
}));

import {
  dispatchRestartWorkflow,
  failedJobNames,
  failedRunErrorLines,
  findRestartWorkflow,
  latestRuns,
  loadWorkflowRunDefinition,
  rerunFailedJobs,
} from "./github.js";
import {
  claimSelfHealAttempt,
  findAutoRetry,
  getActiveSelfHealIncident,
  getSelfHealIncident,
  logAction,
  markSelfHealActionLogged,
  markSelfHealFailure,
  markSelfHealRecovered,
  markSelfHealRunning,
  markSelfHealUnavailable,
  updateOutcome,
  type SelfHealIncident,
} from "./actionlog.js";
import {
  maybeAutoRestartService,
  maybeAutoRetry,
  rerunForbidden,
  restartRepoForHost,
  settleRecovery,
  workflowDefinitionForbidden,
} from "./selfheal.js";

const now = new Date("2026-08-20T10:00:00.000Z");

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    name: "CI",
    display_title: "CI",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.test/run/200",
    updated_at: now.toISOString(),
    run_attempt: 1,
    ...overrides,
  } as any;
}

function incident(overrides: Partial<SelfHealIncident> = {}): SelfHealIncident {
  return {
    incidentKey: "build:fps-api:200",
    kind: "build_retry",
    repo: "fps-api",
    targetId: "200",
    attempts: 1,
    status: "running",
    nextAttemptAt: null,
    observedRunAttempt: 1,
    lastActionLogId: 41,
    history: [],
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSelfHealIncident).mockResolvedValue(null);
  vi.mocked(failedRunErrorLines).mockResolvedValue(["ECONNRESET"]);
  vi.mocked(failedJobNames).mockResolvedValue(["build"]);
  vi.mocked(loadWorkflowRunDefinition).mockResolvedValue({
    name: "CI",
    jobs: { build: { steps: [{ run: "pnpm test" }] } },
  });
  vi.mocked(logAction).mockResolvedValue(41);
  vi.mocked(rerunFailedJobs).mockResolvedValue({ ok: true, message: "gestart" });
  vi.mocked(markSelfHealRunning).mockResolvedValue(true);
  vi.mocked(markSelfHealActionLogged).mockResolvedValue(true);
  vi.mocked(updateOutcome).mockResolvedValue();
});

describe("safety boundary", () => {
  it("allows a same-version deploy, release and publish rerun", () => {
    expect(rerunForbidden(["deploy-production", "release", "publish-package"])).toBe(false);
  });

  it.each([
    "rollback production",
    "database migration",
    "restore backup",
    "change secrets",
    "update permissions",
    "firewall configuration",
  ])("blocks %s", (name) => {
    expect(rerunForbidden([name])).toBe(true);
  });

  it("escalates a forbidden workflow without claiming or executing it", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run({ name: "rollback production" })]);
    vi.mocked(failedJobNames).mockResolvedValue(["rollback"]);

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("Geen automatisch herstel");
    expect(claimSelfHealAttempt).not.toHaveBeenCalled();
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("blocks a forbidden dependent job even when the failed job is safe", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run()]);
    vi.mocked(loadWorkflowRunDefinition).mockResolvedValue({
      jobs: {
        build: { steps: [{ run: "pnpm build" }] },
        afterBuild: {
          needs: "build",
          steps: [{ name: "rollback production", run: "./rollback.sh" }],
        },
      },
    });

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.escalationDetail).toContain("verboden");
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("treats an unreadable workflow definition as unsafe", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run()]);
    vi.mocked(loadWorkflowRunDefinition).mockResolvedValue(null);

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("niet veilig");
    expect(claimSelfHealAttempt).not.toHaveBeenCalled();
  });

  it("does not reject a deploy merely because it reads an existing secret", () => {
    expect(
      workflowDefinitionForbidden({
        jobs: {
          deploy: {
            steps: [
              {
                name: "deploy same version",
                run: "deploy --token ${{ secrets.DEPLOY_TOKEN }}",
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("blocks workflow-level write-all permissions", () => {
    expect(
      workflowDefinitionForbidden({
        permissions: "write-all",
        jobs: { build: { steps: [{ run: "pnpm build" }] } },
      }),
    ).toBe(true);
  });

  it("blocks job-level administrative write permissions", () => {
    expect(
      workflowDefinitionForbidden({
        jobs: {
          build: {
            permissions: { administration: "write" },
            steps: [{ run: "pnpm build" }],
          },
        },
      }),
    ).toBe(true);
  });

  it("allows deployment-related write scopes needed for a same-version release", () => {
    expect(
      workflowDefinitionForbidden({
        permissions: {
          contents: "write",
          deployments: "write",
          packages: "write",
        },
        jobs: { deploy: { steps: [{ run: "deploy --same-version" }] } },
      }),
    ).toBe(false);
  });
});

describe("three-attempt build recovery", () => {
  it("claims and starts the first transient retry", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run()]);
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(incident({ status: "starting" }));

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision).toEqual({ holdNotification: true, escalationDetail: null });
    expect(claimSelfHealAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ incidentKey: "build:fps-api:200", kind: "build_retry" }),
    );
    expect(rerunFailedJobs).toHaveBeenCalledWith("fps-api", 200);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining("poging 1/3"),
        runId: "200:attempt:1",
      }),
    );
    expect(markSelfHealRunning).toHaveBeenCalledWith(
      expect.objectContaining({ observedRunAttempt: 1, actionLogId: 41 }),
    );
    expect(markSelfHealActionLogged).toHaveBeenCalledWith(
      "build:fps-api:200",
      41,
      1,
    );
  });

  it("waits five minutes after the first failed retry", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run({ run_attempt: 2 })]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(incident());
    vi.mocked(markSelfHealFailure).mockResolvedValue(
      incident({
        status: "waiting",
        history: ["Poging 1/3 is afgerond maar de controle bleef failure."],
        nextAttemptAt: new Date("2026-08-20T10:05:00.000Z"),
      }),
    );

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.holdNotification).toBe(true);
    expect(updateOutcome).toHaveBeenCalledWith(
      41,
      "Poging 1/3 is afgerond maar de controle bleef failure.",
    );
    expect(markSelfHealFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        exhausted: false,
        nextAttemptAt: new Date("2026-08-20T10:05:00.000Z"),
      }),
    );
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("does not start the second attempt before its due time", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run({ run_attempt: 2 })]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({
        status: "waiting",
        nextAttemptAt: new Date("2026-08-20T10:05:00.000Z"),
      }),
    );

    const decision = await maybeAutoRetry("fps-api", new Date("2026-08-20T10:04:59.000Z"));

    expect(decision.holdNotification).toBe(true);
    expect(claimSelfHealAttempt).not.toHaveBeenCalled();
  });

  it("starts attempt two when the five-minute wait has elapsed", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run({ run_attempt: 2 })]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({
        status: "waiting",
        nextAttemptAt: new Date("2026-08-20T10:05:00.000Z"),
      }),
    );
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(
      incident({ status: "starting", attempts: 2, observedRunAttempt: 1 }),
    );

    await maybeAutoRetry("fps-api", new Date("2026-08-20T10:05:00.000Z"));

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining("poging 2/3"),
        runId: "200:attempt:2",
      }),
    );
    expect(rerunFailedJobs).toHaveBeenCalledOnce();
  });

  it("escalates after the third failure with all attempts in the message", async () => {
    const exhausted = incident({
      attempts: 3,
      status: "exhausted",
      observedRunAttempt: 3,
      history: [
        "Poging 1/3 bleef rood.",
        "Poging 2/3 bleef rood.",
        "Poging 3/3 is afgerond maar de controle bleef failure.",
      ],
    });
    vi.mocked(latestRuns).mockResolvedValue([run({ run_attempt: 4 })]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({ attempts: 3, observedRunAttempt: 3 }),
    );
    vi.mocked(markSelfHealFailure).mockResolvedValue(exhausted);

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("na drie pogingen gestopt");
    expect(decision.escalationDetail).toContain("Poging 1/3");
    expect(decision.escalationDetail).toContain("Poging 2/3");
    expect(decision.escalationDetail).toContain("Poging 3/3");
  });

  it("consumes a new attempt instead of replaying an ambiguous stale claim", async () => {
    vi.mocked(latestRuns).mockResolvedValue([run()]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({
        status: "starting",
        attempts: 1,
        lastActionLogId: 40,
        updatedAt: new Date("2026-08-20T09:49:00.000Z"),
      }),
    );
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(
      incident({ status: "starting", attempts: 2, lastActionLogId: 40 }),
    );

    await maybeAutoRetry("fps-api", now);

    expect(updateOutcome).toHaveBeenCalledWith(
      40,
      expect.stringContaining("onbekende uitkomst"),
    );
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.stringContaining("poging 2/3") }),
    );
  });

  it("escalates an ambiguous third claim instead of executing a fourth action", async () => {
    const staleThird = incident({
      status: "starting",
      attempts: 3,
      lastActionLogId: 43,
      updatedAt: new Date("2026-08-20T09:49:00.000Z"),
      history: ["Poging 1/3 faalde.", "Poging 2/3 faalde."],
    });
    vi.mocked(latestRuns).mockResolvedValue([run()]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(staleThird);
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(null);
    vi.mocked(markSelfHealFailure).mockResolvedValue(
      incident({
        ...staleThird,
        status: "exhausted",
        history: [
          ...staleThird.history,
          "Poging 3/3 heeft door een serveronderbreking een onbekende uitkomst en wordt niet opnieuw uitgevoerd.",
        ],
      }),
    );

    const decision = await maybeAutoRetry("fps-api", now);

    expect(decision.escalationDetail).toContain("Poging 3/3");
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });
});

describe("service restart workflow", () => {
  const safeRestartWorkflow = {
    id: 9,
    ref: "v1.2.3",
    definition: {
      name: "herstart",
      on: { workflow_dispatch: null },
      jobs: {
        restart: { steps: [{ run: "systemctl restart app" }] },
      },
    },
  };
  const serviceIncident = incident({
    incidentKey: "service:app.example:1",
    kind: "service_restart",
    repo: "app-repo",
    targetId: "app.example",
    status: "starting",
  });

  it("reads an explicit host-to-repository mapping", () => {
    process.env.SERVICE_RESTART_REPOS = "app.example=app-repo, api.example=api-repo";
    expect(restartRepoForHost("app.example")).toBe("app-repo");
    expect(restartRepoForHost("unknown.example")).toBeNull();
  });

  it("alerts directly when the mapped repo has no herstart workflow", async () => {
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(serviceIncident);
    vi.mocked(findRestartWorkflow).mockResolvedValue(null);
    vi.mocked(markSelfHealUnavailable).mockResolvedValue();

    const decision = await maybeAutoRestartService({
      host: "app.example",
      repo: "app-repo",
      outageStartedAt: 1,
      now,
    });

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("workflow_dispatch");
    expect(logAction).not.toHaveBeenCalled();
    expect(dispatchRestartWorkflow).not.toHaveBeenCalled();
  });

  it("dispatches the verified workflow and records the action", async () => {
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(serviceIncident);
    vi.mocked(findRestartWorkflow).mockResolvedValue(safeRestartWorkflow);
    vi.mocked(dispatchRestartWorkflow).mockResolvedValue({ ok: true, message: "gestart" });

    const decision = await maybeAutoRestartService({
      host: "app.example",
      repo: "app-repo",
      outageStartedAt: 1,
      now,
    });

    expect(decision.holdNotification).toBe(true);
    expect(dispatchRestartWorkflow).toHaveBeenCalledWith(
      "app-repo",
      safeRestartWorkflow,
    );
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auto_restart", action: expect.stringContaining("poging 1/3") }),
    );
    expect(markSelfHealRunning).toHaveBeenCalledWith(
      expect.objectContaining({ nextAttemptAt: new Date("2026-08-20T10:05:00.000Z") }),
    );
  });

  it("refuses a herstart workflow that contains a forbidden migration", async () => {
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(serviceIncident);
    vi.mocked(findRestartWorkflow).mockResolvedValue({
      ...safeRestartWorkflow,
      definition: {
        name: "herstart",
        on: { workflow_dispatch: null },
        jobs: {
          restart: {
            steps: [
              { run: "systemctl restart app" },
              { run: "pnpm prisma migrate deploy" },
            ],
          },
        },
      },
    });

    const decision = await maybeAutoRestartService({
      host: "app.example",
      repo: "app-repo",
      outageStartedAt: 1,
      now,
    });

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("verboden");
    expect(logAction).not.toHaveBeenCalled();
    expect(dispatchRestartWorkflow).not.toHaveBeenCalled();
  });

  it("uses a fifteen-minute wait after the second service restart", async () => {
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({
        ...serviceIncident,
        status: "waiting",
        attempts: 1,
        nextAttemptAt: now,
      }),
    );
    vi.mocked(claimSelfHealAttempt).mockResolvedValue(
      incident({ ...serviceIncident, status: "starting", attempts: 2 }),
    );
    vi.mocked(findRestartWorkflow).mockResolvedValue(safeRestartWorkflow);
    vi.mocked(dispatchRestartWorkflow).mockResolvedValue({ ok: true, message: "gestart" });

    await maybeAutoRestartService({
      host: "app.example",
      repo: "app-repo",
      outageStartedAt: 1,
      now,
    });

    expect(markSelfHealRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        nextAttemptAt: new Date("2026-08-20T10:15:00.000Z"),
      }),
    );
  });

  it("escalates after the third service restart remains unreachable", async () => {
    const runningThird = incident({
      ...serviceIncident,
      status: "running",
      attempts: 3,
      nextAttemptAt: now,
      lastActionLogId: 55,
      history: [
        "Poging 1/3 bleef onbereikbaar.",
        "Poging 2/3 bleef onbereikbaar.",
      ],
    });
    vi.mocked(getSelfHealIncident).mockResolvedValue(runningThird);
    vi.mocked(markSelfHealFailure).mockResolvedValue(
      incident({
        ...runningThird,
        status: "exhausted",
        history: [
          ...runningThird.history,
          "Poging 3/3 is uitgevoerd maar app.example bleef onbereikbaar.",
        ],
      }),
    );

    const decision = await maybeAutoRestartService({
      host: "app.example",
      repo: "app-repo",
      outageStartedAt: 1,
      now,
    });

    expect(decision.holdNotification).toBe(false);
    expect(decision.escalationDetail).toContain("Poging 3/3");
    expect(claimSelfHealAttempt).not.toHaveBeenCalled();
    expect(dispatchRestartWorkflow).not.toHaveBeenCalled();
  });
});

describe("recovery settlement", () => {
  it("marks a successful retried run and its incident as recovered", async () => {
    vi.mocked(latestRuns).mockResolvedValue([
      run({ status: "completed", conclusion: "success", run_attempt: 3 }),
    ]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(
      incident({ attempts: 2, lastActionLogId: 77 }),
    );
    vi.mocked(markSelfHealRecovered).mockResolvedValue();

    await expect(settleRecovery("fps-api")).resolves.toBe(true);

    expect(updateOutcome).toHaveBeenCalledWith(
      77,
      "geslaagd — hersteld na 2 automatische poging(en)",
    );
    expect(markSelfHealRecovered).toHaveBeenCalledWith("build:fps-api:200");
  });

  it("keeps the historical recovered badge when only the audit row remains", async () => {
    vi.mocked(latestRuns).mockResolvedValue([
      run({ status: "completed", conclusion: "success", run_attempt: 2 }),
    ]);
    vi.mocked(getSelfHealIncident).mockResolvedValue(null);
    vi.mocked(findAutoRetry).mockResolvedValue({ id: 5, outcome: "geslaagd" });

    await expect(settleRecovery("fps-api")).resolves.toBe(true);
  });

  it("does not settle an active service incident helper by accident", async () => {
    vi.mocked(getActiveSelfHealIncident).mockResolvedValue(null);
    expect(getActiveSelfHealIncident).not.toHaveBeenCalled();
  });
});