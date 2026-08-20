/**
 * Read-only GitHub API client for the FPS-Beheercentrum.
 * Uses GITHUB_TOKEN and GITHUB_ORG from the environment.
 * Never performs any write operation.
 */
import { parse } from "yaml";

const GITHUB_API = "https://api.github.com";

const CACHE_TTL_MS = 60_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function githubOrg(): string {
  return requiredEnv("GITHUB_ORG");
}

async function ghFetch(path: string, accept?: string): Promise<Response> {
  const token = requiredEnv("GITHUB_TOKEN");
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
}

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function ghFetchUrl(url: string): Promise<Response> {
  const token = requiredEnv("GITHUB_TOKEN");
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
}

async function ghJson<T>(path: string): Promise<T> {
  const res = await ghFetch(path);
  if (!res.ok) {
    throw new GitHubError(
      `GitHub API ${res.status} voor ${path.split("?")[0]}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** Parse the URL for rel="next" from a GitHub Link header, or null if absent. */
export function parseLinkNext(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Fetch all pages of a GitHub list endpoint that returns T[]. */
async function ghJsonAll<T>(firstPath: string): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = `${GITHUB_API}${firstPath}`;

  while (url) {
    const res = await ghFetchUrl(url);
    if (!res.ok) {
      throw new GitHubError(
        `GitHub API ${res.status} voor ${firstPath.split("?")[0]}`,
        res.status,
      );
    }
    const page = (await res.json()) as T[];
    results.push(...page);
    url = parseLinkNext(res.headers.get("Link"));
  }

  return results;
}

interface GhRepo {
  name: string;
  html_url: string;
  pushed_at: string | null;
  default_branch: string;
}

/**
 * Returns the list of repositories to monitor.
 *
 * Configurable via the MONITORED_REPOS environment variable
 * (comma-separated repo names). When the variable is absent,
 * all repositories of the GitHub organisation are returned
 * automatically — including those added after the last deploy —
 * so the list never needs a code change.
 */
export async function listMonitoredRepos(): Promise<string[]> {
  const envList = process.env.MONITORED_REPOS;
  if (envList) {
    return envList
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }

  const org = githubOrg();
  const repos = await ghJsonAll<GhRepo>(
    `/orgs/${org}/repos?per_page=100&type=all&sort=pushed`,
  );
  return repos.map((r) => r.name);
}

interface GhCommitListItem {
  sha: string;
  html_url: string;
  commit: { message: string; committer?: { date?: string } | null };
}

interface GhCommitDetail {
  sha: string;
  html_url: string;
  commit: { message: string };
  files?: Array<{
    filename: string;
    additions: number;
    deletions: number;
  }>;
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ...
  html_url: string;
  updated_at: string;
  run_attempt?: number;
  /** Workflow definition and exact commit used by this run. */
  path?: string;
  head_sha?: string;
}

interface GhJob {
  id: number;
  name: string;
  conclusion: string | null;
  html_url: string;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

export type Status = "green" | "yellow" | "red" | "gray";

export interface Anomaly {
  commitSha: string;
  commitTitle: string;
  fileName: string;
  linesChanged: number;
  commitUrl: string;
}

export interface RepoSummary {
  name: string;
  status: Status;
  /** Set when the staleness check influenced the status (plain Dutch). */
  staleReason: string | null;
  /** Timestamp of the most recent commit, when available. */
  lastCommitAt: string | null;
  lastPushAt: string | null;
  lastCommitTitle: string | null;
  failReason: string | null;
  htmlUrl: string | null;
  anomaly: Anomaly | null;
  /** True when the latest check succeeded only after an automatic retry. */
  recoveredAfterRetry: boolean;
}

export interface CheckRunInfo {
  name: string;
  status: Status;
  completedAt: string | null;
  commitTitle: string | null;
  url: string | null;
}

export interface FailedCheckDetail {
  name: string;
  errorLines: string[];
  logUrl: string;
}

const ANOMALY_LINE_THRESHOLD = 300;

function runStatus(run: GhWorkflowRun | undefined): Status {
  if (!run) return "gray";
  if (run.status !== "completed") return "gray";
  if (run.conclusion === "success") return "green";
  if (run.conclusion === "failure" || run.conclusion === "timed_out")
    return "red";
  return "gray";
}

function commitTitle(message: string): string {
  return message.split("\n")[0] ?? message;
}

/** Translate a failed job/step name into plain Dutch. */
export function plainFailReason(names: string[]): string {
  const joined = names.join(" ").toLowerCase();
  if (joined.includes("typecheck") || joined.includes("type-check") || joined.includes("tsc"))
    return "typecheck faalt";
  if (joined.includes("test")) return "tests falen";
  if (joined.includes("lint")) return "lint faalt";
  if (joined.includes("build") || joined.includes("compile")) return "build faalt";
  if (joined.includes("deploy")) return "deploystap faalt";
  if (joined.includes("install") || joined.includes("dependenc"))
    return "installatie van afhankelijkheden faalt";
  const first = names[0];
  return first ? `controle "${first}" faalt` : "controle faalt";
}

export async function latestRuns(repo: string, count: number): Promise<GhWorkflowRun[]> {
  const org = githubOrg();
  const data = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(
    `/repos/${org}/${repo}/actions/runs?per_page=${count}`,
  );
  return data.workflow_runs ?? [];
}

export async function failedJobNames(repo: string, runId: number): Promise<string[]> {
  const org = githubOrg();
  try {
    const data = await ghJson<{ jobs: GhJob[] }>(
      `/repos/${org}/${repo}/actions/runs/${runId}/jobs?per_page=50`,
    );
    const names: string[] = [];
    for (const job of data.jobs ?? []) {
      if (job.conclusion === "failure") {
        const failedStep = job.steps?.find((s) => s.conclusion === "failure");
        names.push(failedStep ? failedStep.name : job.name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function detectAnomaly(repo: string): Promise<Anomaly | null> {
  const org = githubOrg();
  try {
    const commits = await ghJson<GhCommitListItem[]>(
      `/repos/${org}/${repo}/commits?per_page=1`,
    );
    const head = commits[0];
    if (!head) return null;
    const detail = await ghJson<GhCommitDetail>(
      `/repos/${org}/${repo}/commits/${head.sha}`,
    );
    for (const file of detail.files ?? []) {
      const changed = file.additions + file.deletions;
      if (changed > ANOMALY_LINE_THRESHOLD) {
        return {
          commitSha: detail.sha,
          commitTitle: commitTitle(detail.commit.message),
          fileName: file.filename,
          linesChanged: changed,
          commitUrl: detail.html_url,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchRepoSummary(repo: string): Promise<RepoSummary> {
  const org = githubOrg();

  const [repoInfo, commits, runs, anomaly] = await Promise.all([
    ghJson<GhRepo>(`/repos/${org}/${repo}`).catch(() => null),
    ghJson<GhCommitListItem[]>(`/repos/${org}/${repo}/commits?per_page=1`).catch(
      () => [] as GhCommitListItem[],
    ),
    latestRuns(repo, 1).catch(() => [] as GhWorkflowRun[]),
    detectAnomaly(repo),
  ]);

  const latest = runs[0];
  const checkStatus = runStatus(latest);

  let failReason: string | null = null;
  if (checkStatus === "red" && latest) {
    const names = await failedJobNames(repo, latest.id);
    failReason = plainFailReason(names);
  }

  // Staleness: code without recent commits turns yellow/red per the
  // configurable per-repo thresholds; no commit info means never green.
  const lastCommitAt = commits[0]?.commit.committer?.date ?? null;
  const { applyStaleness, getRepoThresholds } = await import("./staleness.js");
  const thresholds = await getRepoThresholds(repo);
  const stale = applyStaleness(
    checkStatus,
    lastCommitAt ? new Date(lastCommitAt) : null,
    thresholds,
  );
  const status = stale.status;
  if (status === "red" && !failReason) {
    failReason = stale.staleReason;
  }

  let recoveredAfterRetry = false;
  if (status === "green" && latest && (latest.run_attempt ?? 1) > 1) {
    const { wasRecoveredAfterRetry } = await import("./selfheal.js");
    recoveredAfterRetry = await wasRecoveredAfterRetry(
      repo,
      latest.id,
      latest.run_attempt,
      latest.conclusion,
    );
  }

  return {
    name: repo,
    status,
    staleReason: stale.staleReason,
    lastCommitAt,
    lastPushAt: repoInfo?.pushed_at ?? null,
    lastCommitTitle: commits[0] ? commitTitle(commits[0].commit.message) : null,
    failReason,
    htmlUrl: repoInfo?.html_url ?? null,
    anomaly,
    recoveredAfterRetry,
  };
}
export function repoSummary(repo: string, bypass = false): Promise<RepoSummary> {
  return withCache(`summary:${repo}`, bypass, () => fetchRepoSummary(repo));
}

/**
 * The single deliberate exception to "read-only": re-running an existing
 * GitHub Actions check. This never changes code, settings, or deployments —
 * it only asks GitHub to execute the same check again. Requires the token
 * to have actions:write; a 403 is reported as a plain-language error.
 */
export async function rerunFailedJobs(
  repo: string,
  runId: number,
): Promise<{ ok: boolean; message: string }> {
  const org = githubOrg();
  const token = requiredEnv("GITHUB_TOKEN");
  const res = await fetch(
    `${GITHUB_API}/repos/${org}/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (res.status === 201) {
    return { ok: true, message: "Controle opnieuw gestart op GitHub." };
  }
  if (res.status === 403) {
    return {
      ok: false,
      message:
        "GitHub weigerde de herstart: het token heeft alleen leesrechten (actions:write ontbreekt).",
    };
  }
  return {
    ok: false,
    message: `GitHub weigerde de herstart (status ${res.status}).`,
  };
}

interface GhWorkflow {
  id: number;
  name: string;
  state: string;
  path: string;
}

export interface RestartWorkflowTarget {
  id: number;
  ref: string;
  definition: unknown;
}

function decodeWorkflowYaml(content: { content?: string; encoding?: string }): string | null {
  if (content.encoding !== "base64" || !content.content) return null;
  return Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWorkflowDispatch(definition: unknown): boolean {
  if (!isRecord(definition)) return false;
  const triggers = definition["on"];
  if (triggers === "workflow_dispatch") return true;
  if (Array.isArray(triggers)) return triggers.includes("workflow_dispatch");
  return isRecord(triggers) &&
    Object.prototype.hasOwnProperty.call(triggers, "workflow_dispatch");
}

/** Finds an active workflow named "herstart" that declares workflow_dispatch. */
export async function findRestartWorkflow(
  repo: string,
): Promise<RestartWorkflowTarget | null> {
  const org = githubOrg();
  const [workflows, releases] = await Promise.all([
    ghJson<{ workflows: GhWorkflow[] }>(`/repos/${org}/${repo}/actions/workflows?per_page=100`),
    ghJson<{
      tag_name: string;
      immutable?: boolean;
      draft?: boolean;
    }[]>(`/repos/${org}/${repo}/releases?per_page=100`),
  ]);
  const workflow = (workflows.workflows ?? []).find(
    (candidate) => candidate.state === "active" && candidate.name.trim().toLowerCase() === "herstart",
  );
  if (!workflow) return null;

  for (const release of releases) {
    if (!release.immutable || release.draft || !release.tag_name) continue;
    try {
      const content = await ghJson<{ content?: string; encoding?: string }>(
        `/repos/${org}/${repo}/contents/${workflow.path}?ref=${encodeURIComponent(release.tag_name)}`,
      );
      const yaml = decodeWorkflowYaml(content);
      if (!yaml) continue;
      const definition: unknown = parse(yaml);
      if (
        !isRecord(definition) ||
        definition["name"] !== "herstart" ||
        !hasWorkflowDispatch(definition)
      ) continue;
      return {
        id: workflow.id,
        ref: release.tag_name,
        definition,
      };
    } catch {
      // Deze release bevatte het huidige herstartpad niet; probeer de volgende.
    }
  }
  return null;
}

/** Loads the exact workflow definition used by a run, never the current branch. */
export async function loadWorkflowRunDefinition(
  repo: string,
  run: GhWorkflowRun,
): Promise<unknown | null> {
  if (!run.path || !run.head_sha) return null;
  const org = githubOrg();
  const content = await ghJson<{ content?: string; encoding?: string }>(
    `/repos/${org}/${repo}/contents/${run.path}?ref=${encodeURIComponent(run.head_sha)}`,
  );
  const yaml = decodeWorkflowYaml(content);
  return yaml ? parse(yaml) : null;
}

/** Dispatches a restart workflow at a GitHub-enforced immutable release tag. */
export async function dispatchRestartWorkflow(
  repo: string,
  workflow: RestartWorkflowTarget,
): Promise<{ ok: boolean; message: string }> {
  const org = githubOrg();
  const token = requiredEnv("GITHUB_TOKEN");
  const res = await fetch(
    `${GITHUB_API}/repos/${org}/${repo}/actions/workflows/${workflow.id}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: workflow.ref }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  return res.status === 204
    ? { ok: true, message: "Herstartworkflow gestart vanaf een onveranderlijke release." }
    : { ok: false, message: `GitHub weigerde de herstartworkflow (status ${res.status}).` };
}

/** First N error-looking lines from the failed job's log of a run. */
export async function failedRunErrorLines(
  repo: string,
  runId: number,
  max = 40,
): Promise<string[]> {
  const org = githubOrg();
  try {
    const data = await ghJson<{ jobs: GhJob[] }>(
      `/repos/${org}/${repo}/actions/runs/${runId}/jobs?per_page=50`,
    );
    const failedJob = (data.jobs ?? []).find((j) => j.conclusion === "failure");
    if (!failedJob) return [];
    const logRes = await ghFetch(
      `/repos/${org}/${repo}/actions/jobs/${failedJob.id}/logs`,
    );
    if (!logRes.ok) return [];
    return extractErrorLines(await logRes.text(), max);
  } catch {
    return [];
  }
}

/** First N lines of a job log that look like errors. */
function extractErrorLines(log: string, max: number): string[] {
  const lines = log.split("\n");
  const errorLines: string[] = [];
  const pattern = /##\[error\]|(^|\s)error(\s|:|\b)|failed|FAIL\b/i;
  for (const raw of lines) {
    // Strip timestamp prefix like "2026-08-15T07:00:00.0000000Z "
    const line = raw.replace(/^\S+Z\s/, "").trim();
    if (!line) continue;
    if (pattern.test(line)) {
      errorLines.push(line.replace(/##\[error\]/g, "").trim());
      if (errorLines.length >= max) break;
    }
  }
  return errorLines;
}

async function failedCheckDetail(
  repo: string,
  run: GhWorkflowRun,
): Promise<FailedCheckDetail> {
  const org = githubOrg();
  let name = run.name ?? "Controle";
  let errorLines: string[] = [];

  try {
    const data = await ghJson<{ jobs: GhJob[] }>(
      `/repos/${org}/${repo}/actions/runs/${run.id}/jobs?per_page=50`,
    );
    const failedJob = (data.jobs ?? []).find((j) => j.conclusion === "failure");
    if (failedJob) {
      const failedStep = failedJob.steps?.find(
        (s) => s.conclusion === "failure",
      );
      name = failedStep ? failedStep.name : failedJob.name;
      const logRes = await ghFetch(
        `/repos/${org}/${repo}/actions/jobs/${failedJob.id}/logs`,
      );
      if (logRes.ok) {
        const log = await logRes.text();
        errorLines = extractErrorLines(log, 10);
      }
    }
  } catch {
    // Log niet beschikbaar; laat errorLines leeg.
  }

  return { name, errorLines, logUrl: run.html_url };
}

export interface RepoDetail {
  name: string;

  status: Status;
  /** Set when the staleness check influenced the status (plain Dutch). */

  staleReason: string | null;

  lastPushAt: string | null;

  lastCommitTitle: string | null;

  failReason: string | null;

  htmlUrl: string | null;

  checks: CheckRunInfo[];

  failedCheck: FailedCheckDetail | null;
  /** True when the latest check succeeded only after an automatic retry. */

  recoveredAfterRetry: boolean;

  anomaly: Anomaly | null;
}

async function fetchRepoDetail(repo: string): Promise<RepoDetail> {
  const org = githubOrg();

  const [repoInfo, commits, runs, anomaly] = await Promise.all([
    ghJson<GhRepo>(`/repos/${org}/${repo}`).catch(() => null),
    ghJson<GhCommitListItem[]>(`/repos/${org}/${repo}/commits?per_page=1`).catch(
      () => [] as GhCommitListItem[],
    ),
    latestRuns(repo, 5).catch(() => [] as GhWorkflowRun[]),
    detectAnomaly(repo),
  ]);

  const latest = runs[0];
  const checkStatus = runStatus(latest);

  let failReason: string | null = null;
  let failedCheck: FailedCheckDetail | null = null;
  if (checkStatus === "red" && latest) {
    const names = await failedJobNames(repo, latest.id);
    failReason = plainFailReason(names);
    failedCheck = await failedCheckDetail(repo, latest);
  }

  // Same staleness rules as the summary, so both views agree on the status.
  const lastCommitAt = commits[0]?.commit.committer?.date ?? null;
  const { applyStaleness, getRepoThresholds } = await import("./staleness.js");
  const stale = applyStaleness(
    checkStatus,
    lastCommitAt ? new Date(lastCommitAt) : null,
    await getRepoThresholds(repo),
  );
  const status = stale.status;
  if (status === "red" && !failReason) {
    failReason = stale.staleReason;
  }

  const checks: CheckRunInfo[] = runs.map((run) => ({
    name: run.name ?? "Controle",
    status: runStatus(run),
    completedAt: run.updated_at ?? null,
    commitTitle: run.display_title ?? null,
    url: run.html_url ?? null,
  }));

  let recoveredAfterRetry = false;
  if (status === "green" && latest && (latest.run_attempt ?? 1) > 1) {
    const { wasRecoveredAfterRetry } = await import("./selfheal.js");
    recoveredAfterRetry = await wasRecoveredAfterRetry(
      repo,
      latest.id,
      latest.run_attempt,
      latest.conclusion,
    );
  }

  return {
    name: repo,
    status,
    staleReason: stale.staleReason,
    lastPushAt: repoInfo?.pushed_at ?? null,
    lastCommitTitle: commits[0] ? commitTitle(commits[0].commit.message) : null,
    failReason,
    htmlUrl: repoInfo?.html_url ?? null,
    checks,
    failedCheck,
    anomaly,
    recoveredAfterRetry,
  };
}
export function repoDetail(repo: string, bypass = false): Promise<RepoDetail> {
  return withCache(`detail:${repo}`, bypass, () => fetchRepoDetail(repo));
}

const cache = new Map<string, CacheEntry<any>>();

/**
 * Drops the cached summary and detail for one repo, so a settings change
 * (e.g. staleness thresholds) is visible on the very next fetch.
 */
export function invalidateRepoCache(repo: string): void {
  cache.delete(`summary:${repo}`);
  cache.delete(`detail:${repo}`);
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

async function withCache<T>(
  key: string,
  bypass: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!bypass) {
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > Date.now()) {
      return entry.data;
    }
  }
  const data = await fn();
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}
