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

import { listMonitoredRepos, repoSummary } from "../lib/github.js";
import reposRouter from "./repos.js";

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
