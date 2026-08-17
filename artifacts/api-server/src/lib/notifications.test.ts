import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyRepoRed, notifyAnomaly } from "./notifications.js";
import type { RepoSummary, Anomaly } from "./github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function errorResponse(status: number, body = "error"): Response {
  return new Response(body, { status });
}

const VALID_WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxx";

const redSummary: RepoSummary = {
  name: "fps-api",
  status: "red",
  staleReason: null,
  lastCommitAt: "2026-08-15T08:00:00Z",
  lastPushAt: "2026-08-15T08:00:00Z",
  lastCommitTitle: "fix: broken build",
  failReason: "tests falen",
  htmlUrl: "https://github.com/fps/fps-api",
  anomaly: null,
  recoveredAfterRetry: false,
};

const anomaly: Anomaly = {
  commitSha: "abc1234",
  commitTitle: "chore: big file change",
  fileName: "src/generated/schema.ts",
  linesChanged: 450,
  commitUrl: "https://github.com/fps/fps-api/commit/abc1234",
};

// ---------------------------------------------------------------------------
// notifyRepoRed
// ---------------------------------------------------------------------------

describe("notifyRepoRed", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = VALID_WEBHOOK;
    delete process.env.NOTIFICATIONS_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("POSTs to the Slack webhook and returns true on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse());

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(VALID_WEBHOOK);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("includes the repo name and fail reason in the payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse());

    await notifyRepoRed(redSummary);

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("fps-api");
    expect(bodyStr).toContain("tests falen");
  });

  it("returns false and does not call fetch when NOTIFICATIONS_ENABLED=false", async () => {
    process.env.NOTIFICATIONS_ENABLED = "false";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false and does not call fetch when SLACK_WEBHOOK_URL is absent", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false and does not call fetch when SLACK_WEBHOOK_URL is not a hooks.slack.com URL", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://evil.example.com/webhook";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false when the Slack webhook responds with an error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await notifyRepoRed(redSummary);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// notifyAnomaly
// ---------------------------------------------------------------------------

describe("notifyAnomaly", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = VALID_WEBHOOK;
    delete process.env.NOTIFICATIONS_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("POSTs to the Slack webhook and returns true on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse());

    const result = await notifyAnomaly("fps-api", anomaly, "https://github.com/fps/fps-api");

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("includes the file name and lines changed in the payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse());

    await notifyAnomaly("fps-api", anomaly, "https://github.com/fps/fps-api");

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("src/generated/schema.ts");
    expect(bodyStr).toContain("450");
    expect(bodyStr).toContain("fps-api");
  });

  it("returns false when NOTIFICATIONS_ENABLED=false", async () => {
    process.env.NOTIFICATIONS_ENABLED = "false";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await notifyAnomaly("fps-api", anomaly, null);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false when SLACK_WEBHOOK_URL is absent", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await notifyAnomaly("fps-api", anomaly, null);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to a constructed GitHub URL when repoUrl is null", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse());

    await notifyAnomaly("fps-api", anomaly, null);

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("fps-api");
  });

  it("returns false when the webhook responds with an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(400, "invalid_payload"));

    const result = await notifyAnomaly("fps-api", anomaly, null);

    expect(result).toBe(false);
  });
});
