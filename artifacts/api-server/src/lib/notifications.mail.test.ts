/**
 * Fanout semantics of the notification module with the mail channel:
 *   delivered = slack OR push OR mail — a mail failure can never block the
 *   other channels, and mail alone is enough to count as delivered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./push.js", () => ({
  sendPushToAll: vi.fn(async () => false),
}));

vi.mock("./mail.js", () => ({
  sendMailSafe: vi.fn(async () => "off" as const),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyRepoRed, notifyAnomaly } from "./notifications.js";
import { sendMailSafe } from "./mail.js";
import { sendPushToAll } from "./push.js";
import type { RepoSummary } from "./github.js";

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

const originalEnv = { ...process.env };

beforeEach(() => {
  // No Slack webhook: Slack channel off.
  delete process.env["SLACK_WEBHOOK_URL"];
  delete process.env["NOTIFICATIONS_ENABLED"];
  vi.mocked(sendMailSafe).mockReset().mockResolvedValue("off");
  vi.mocked(sendPushToAll).mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("mail fanout OR-semantics", () => {
  it("counts as delivered when only the mail channel succeeds", async () => {
    vi.mocked(sendMailSafe).mockResolvedValue("sent");

    const delivered = await notifyRepoRed(redSummary);

    expect(delivered).toBe(true);
    expect(vi.mocked(sendMailSafe)).toHaveBeenCalledTimes(1);
    const [subject, body] = vi.mocked(sendMailSafe).mock.calls[0]!;
    expect(subject).toContain("fps-api");
    expect(body).toContain("tests falen");
  });

  it("is not delivered when every channel fails", async () => {
    const delivered = await notifyRepoRed(redSummary);
    expect(delivered).toBe(false);
  });

  it("a queued mail counts as handled — the outbox owns the retry, no resend", async () => {
    vi.mocked(sendMailSafe).mockResolvedValue("queued");

    const delivered = await notifyRepoRed(redSummary);

    // Delivered=true advances the monitor's notified-state, so the same
    // alert is NOT sent again next poll; only the outbox retries the mail.
    expect(delivered).toBe(true);
  });

  it("a mail that could not even be queued does not count as delivered", async () => {
    vi.mocked(sendMailSafe).mockResolvedValue("failed");

    const delivered = await notifyRepoRed(redSummary);

    expect(delivered).toBe(false); // next poll retries the whole notification
  });

  it("a throwing mail channel never blocks push delivery", async () => {
    vi.mocked(sendMailSafe).mockRejectedValue(new Error("mail exploded"));
    vi.mocked(sendPushToAll).mockResolvedValue(true);

    const delivered = await notifyRepoRed(redSummary);

    expect(delivered).toBe(true);
  });

  it("anomaly notifications also fan out to mail", async () => {
    vi.mocked(sendMailSafe).mockResolvedValue("sent");

    const delivered = await notifyAnomaly(
      "fps-api",
      {
        commitSha: "abc1234",
        commitTitle: "chore: big change",
        fileName: "src/schema.ts",
        linesChanged: 450,
        commitUrl: "https://github.com/fps/fps-api/commit/abc1234",
      },
      "https://github.com/fps/fps-api",
    );

    expect(delivered).toBe(true);
    const [subject, body] = vi.mocked(sendMailSafe).mock.calls[0]!;
    expect(subject).toContain("Afwijking");
    expect(body).toContain("src/schema.ts");
  });
});
