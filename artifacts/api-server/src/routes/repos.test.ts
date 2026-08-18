/**
 * Integration test for GET /api/repos — verifies that the staleReason field
 * is present in the JSON response when a repo is gray with no workflow runs
 * and no commit information.
 *
 * A future change to the route handler or the openapi schema that silently
 * drops staleReason would leave operators with an unexplained bare gray dot.
 * This test catches that regression on the full HTTP path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import supertest from "supertest";
import type pino from "pino";

// ---------------------------------------------------------------------------
// Mock the github lib before importing the router so the router picks up stubs.
// ---------------------------------------------------------------------------

vi.mock("../lib/github.js", () => ({
  listMonitoredRepos: vi.fn(),
  repoSummary: vi.fn(),
  repoDetail: vi.fn(),
  GitHubError: class GitHubError extends Error {},
  invalidateRepoCache: vi.fn(),
}));

// Needed when importing the full app — prevent DB and background-monitor side
// effects from running inside unit tests.
vi.mock("@workspace/db", () => ({
  ensureTablesExist: vi.fn().mockResolvedValue(undefined),
  db: {},
}));

vi.mock("../lib/monitor.js", () => ({
  startMonitor: vi.fn(),
}));

// Replace requireAuth with a pass-through so the full-stack tests can reach the
// route handler without a real session cookie.
vi.mock("../lib/auth.js", () => ({
  requireAuth: vi.fn(
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) => next(),
  ),
  cleanupExpiredLoginAttempts: vi.fn().mockResolvedValue(undefined),
  sessionCookieOptions: vi.fn().mockReturnValue({}),
}));

import { listMonitoredRepos, repoSummary, GitHubError } from "../lib/github.js";
import reposRouter from "./repos.js";
// Full middleware stack (auth, cors, body-parsing, error handling) — imported
// after all vi.mock() calls so every dependency is already stubbed.
import fullApp from "../app.js";

// ---------------------------------------------------------------------------
// Minimal test app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// pino-http attaches req.log; provide a fully-typed silent stub.
const silentLogger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silentLogger,
  level: "silent",
  isLevelEnabled: () => false,
} as unknown as pino.Logger;

app.use((_req: Request, _res: Response, next: NextFunction) => {
  (_req as Request & { log: pino.Logger }).log = silentLogger;
  next();
});

app.use("/api", reposRouter);

const agent = supertest(app);

// ---------------------------------------------------------------------------
// Gray repo fixture — no workflow runs, no commit info
// ---------------------------------------------------------------------------

const GRAY_REPO_NAME = "fps-org/test-repo";

const grayRepoSummary = {
  name: GRAY_REPO_NAME,
  status: "gray" as const,
  lastCommitAt: null,
  lastPushAt: null,
  lastCommitTitle: null,
  failReason: null,
  staleReason:
    "geen actieve GitHub Actions-checks gevonden en geen commit-informatie beschikbaar",
  htmlUrl: null,
  anomaly: null,
  recoveredAfterRetry: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/repos — staleReason field", () => {
  beforeEach(() => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([GRAY_REPO_NAME]);
    vi.mocked(repoSummary).mockResolvedValue(grayRepoSummary);
  });

  it("responds with HTTP 200", async () => {
    const res = await agent.get("/api/repos");
    expect(res.status).toBe(200);
  });

  it("returns an array with one entry for the monitored repo", async () => {
    const res = await agent.get("/api/repos");
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it("includes staleReason as a non-null, non-empty string for a gray repo with no runs and no commits", async () => {
    const res = await agent.get("/api/repos");
    const repo = res.body[0];
    expect(repo.staleReason).toBeTruthy();
    expect(typeof repo.staleReason).toBe("string");
    expect(repo.staleReason.length).toBeGreaterThan(0);
  });

  it("reports the repo status as gray", async () => {
    const res = await agent.get("/api/repos");
    expect(res.body[0].status).toBe("gray");
  });

  it("staleReason is absent (null/undefined) for a green repo", async () => {
    vi.mocked(repoSummary).mockResolvedValue({
      ...grayRepoSummary,
      status: "green",
      staleReason: null,
    });

    const res = await agent.get("/api/repos");
    expect(res.status).toBe(200);
    // The schema uses nullish() so the field may be null or absent — either is fine.
    const reason = res.body[0].staleReason;
    expect(reason == null || reason === "").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitHub unreachable — error path
// ---------------------------------------------------------------------------

describe("GET /api/repos — GitHub unreachable", () => {
  it("returns HTTP 502 when listMonitoredRepos throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 503 voor /orgs/fps-org/repos",
        503,
      ),
    );

    const res = await agent.get("/api/repos");
    expect(res.status).toBe(502);
  });

  it("includes a non-empty error string in the body when listMonitoredRepos throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 503 voor /orgs/fps-org/repos",
        503,
      ),
    );

    const res = await agent.get("/api/repos");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it("returns HTTP 502 when repoSummary throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([GRAY_REPO_NAME]);
    vi.mocked(repoSummary).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 502 voor /repos/fps-org/test-repo",
        502,
      ),
    );

    const res = await agent.get("/api/repos");
    expect(res.status).toBe(502);
  });

  it("includes a non-empty error string in the body when repoSummary throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([GRAY_REPO_NAME]);
    vi.mocked(repoSummary).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 502 voor /repos/fps-org/test-repo",
        502,
      ),
    );

    const res = await agent.get("/api/repos");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Full middleware stack — GitHub unreachable
//
// These tests drive the complete Express app (cors, cookie-parser, pino-http,
// requireAuth, error middleware) to confirm that no middleware layer silently
// swallows the GitHubError and returns an empty array in its place.
// ---------------------------------------------------------------------------

describe("GET /api/repos — full middleware stack, GitHub unreachable", () => {
  const fullAgent = supertest(fullApp);

  it("does NOT return an empty array when listMonitoredRepos throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 503 voor /orgs/fps-org/repos",
        503,
      ),
    );

    const res = await fullAgent.get("/api/repos");
    // The body must not be an empty array — that would leave the dashboard blank
    // with no explanation for the operator.
    expect(Array.isArray(res.body) && res.body.length === 0).toBe(false);
  });

  it("returns HTTP 502 through the full stack when listMonitoredRepos throws a GitHubError", async () => {
    vi.mocked(listMonitoredRepos).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 503 voor /orgs/fps-org/repos",
        503,
      ),
    );

    const res = await fullAgent.get("/api/repos");
    expect(res.status).toBe(502);
  });

  it("returns a non-empty error string in the body through the full stack when GitHub is down", async () => {
    vi.mocked(listMonitoredRepos).mockRejectedValue(
      new (GitHubError as unknown as new (msg: string, status: number) => Error)(
        "GitHub API 503 voor /orgs/fps-org/repos",
        503,
      ),
    );

    const res = await fullAgent.get("/api/repos");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});
