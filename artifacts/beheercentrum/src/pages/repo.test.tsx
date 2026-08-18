/**
 * UI tests for the repo detail page
 *
 * Suite 1 — 'Hersteld na herhaling' badge:
 *   Confirms that when navigating directly to /repo/:name (repos list not yet
 *   loaded), the badge is rendered from repo.recoveredAfterRetry on the detail
 *   object, and that the repoSummary value takes precedence when the list IS
 *   loaded.
 *
 * Suite 2 — anomaly warning direct-navigation fallback:
 *   Confirms that when a user navigates directly to a repo detail URL (without
 *   having loaded the list first), the detail page still shows the
 *   "Afwijking gedetecteerd" warning card by falling back to `repo.anomaly`
 *   from the RepoDetail response (repoSummary is absent in this path).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import RepoDetail from "./repo";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Tanstack Query — only needs a stub queryClient.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// Wouter — pin the route param via a mutable variable; render Link as a plain anchor.
let mockRepoName = "test-repo";
vi.mock("wouter", () => ({
  useParams: () => ({ name: mockRepoName }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => <a href={href} {...rest}>{children}</a>,
}));

// API client hooks — controlled per test via the variables below.
let mockDetail: unknown = null;
let mockRepos: unknown[] | undefined = [];
let mockProposals: unknown[] = [];
let mockSettings: unknown = null;

vi.mock("@workspace/api-client-react", () => ({
  useGetRepoDetail: () => ({
    data: mockDetail,
    isLoading: false,
    isError: false,
    error: null,
    isRefetching: false,
  }),
  getGetRepoDetailQueryKey: (_name: string) => ["repoDetail", _name],
  useListRepos: () => ({ data: mockRepos }),
  getListReposQueryKey: () => ["listRepos"],
  useListProposals: () => ({ data: mockProposals }),
  // StalenessSettings sub-component — return no data so it renders nothing.
  useGetRepoSettings: () => ({ data: mockSettings }),
  getGetRepoSettingsQueryKey: (_name: string) => ["repoSettings", _name],
  useUpdateRepoSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RepoDetail object that repo.tsx is happy to render. */
function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    name: mockRepoName,
    status: "green" as const,
    staleReason: null,
    failReason: null,
    lastPushAt: null,
    lastCommitTitle: null,
    htmlUrl: null,
    checks: [],
    failedCheck: null,
    recoveredAfterRetry: false,
    anomaly: null,
    ...overrides,
  };
}

const BADGE_TEXT = "Hersteld na herhaling";

const ANOMALY = {
  commitSha: "abc1234",
  commitTitle: "refactor: move all files",
  fileName: "src/big-module.ts",
  linesChanged: 450,
  commitUrl: "https://github.com/org/my-repo/commit/abc1234",
};

// ---------------------------------------------------------------------------
// Suite 1: recovered-after-retry badge
// ---------------------------------------------------------------------------

describe("RepoDetail — recovered-after-retry badge", () => {
  beforeEach(() => {
    mockRepoName = "test-repo";
    mockRepos = [];
    mockProposals = [];
    mockSettings = null;
  });

  it("renders the badge when navigating directly and repo.recoveredAfterRetry is true", () => {
    mockDetail = makeDetail({ recoveredAfterRetry: true, status: "green" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.getByText(BADGE_TEXT)).toBeInTheDocument();
  });

  it("does not render the badge when repo.recoveredAfterRetry is false (direct navigation)", () => {
    mockDetail = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });

  it("does not render the badge when status is not green, even if recoveredAfterRetry is true", () => {
    mockDetail = makeDetail({ recoveredAfterRetry: true, status: "red" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });

  it("renders the badge from repoSummary when the repos list is loaded and its flag is true", () => {
    // List summary has the flag set; detail object does not — badge should still appear.
    mockDetail = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [{ name: "test-repo", recoveredAfterRetry: true }];

    render(<RepoDetail />);

    expect(screen.getByText(BADGE_TEXT)).toBeInTheDocument();
  });

  it("does not render the badge when both repos list and detail have recoveredAfterRetry: false", () => {
    mockDetail = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [{ name: "test-repo", recoveredAfterRetry: false }];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: anomaly warning — direct-navigation fallback
// ---------------------------------------------------------------------------

describe("RepoDetail — anomaly warning fallback when list is not loaded", () => {
  beforeEach(() => {
    mockRepoName = "my-repo";
    mockRepos = undefined; // undefined = list was never fetched (direct navigation)
    mockProposals = [];
    mockSettings = null;
  });

  it("shows the anomaly warning when RepoDetail.anomaly is set and repoSummary is absent", () => {
    mockDetail = makeDetail({ anomaly: ANOMALY });

    render(<RepoDetail />);

    expect(screen.getByText("Afwijking gedetecteerd")).toBeInTheDocument();
  });

  it("includes the file name and line count from the anomaly", () => {
    mockDetail = makeDetail({ anomaly: ANOMALY });

    render(<RepoDetail />);

    expect(screen.getByText(/450 regels/)).toBeInTheDocument();
    expect(screen.getByText(/src\/big-module\.ts/)).toBeInTheDocument();
  });

  it("renders a link to the anomaly commit", () => {
    mockDetail = makeDetail({ anomaly: ANOMALY });

    render(<RepoDetail />);

    const link = screen.getByRole("link", { name: /Bekijk Commit/i });
    expect(link).toHaveAttribute("href", ANOMALY.commitUrl);
  });

  it("does not render the anomaly warning when anomaly is null", () => {
    mockDetail = makeDetail({ anomaly: null });

    render(<RepoDetail />);

    expect(screen.queryByText("Afwijking gedetecteerd")).not.toBeInTheDocument();
  });

  it("uses repoSummary.anomaly when the list IS loaded and repoSummary has an anomaly", () => {
    // Detail has no anomaly; the list entry has one — summary takes precedence.
    const summaryAnomaly = { ...ANOMALY, linesChanged: 999, fileName: "from-summary.ts" };
    mockRepos = [
      {
        name: "my-repo",
        status: "green",
        anomaly: summaryAnomaly,
        recoveredAfterRetry: false,
      },
    ];
    mockDetail = makeDetail({ anomaly: null });

    render(<RepoDetail />);

    expect(screen.getByText("Afwijking gedetecteerd")).toBeInTheDocument();
    expect(screen.getByText(/999 regels/)).toBeInTheDocument();
    expect(screen.getByText(/from-summary\.ts/)).toBeInTheDocument();
  });

  it("falls back to repo.anomaly when the list is loaded but the repo entry has no anomaly", () => {
    mockRepos = [
      {
        name: "my-repo",
        status: "green",
        anomaly: null,
        recoveredAfterRetry: false,
      },
    ];
    mockDetail = makeDetail({ anomaly: ANOMALY });

    render(<RepoDetail />);

    // Falls back to the detail-level anomaly.
    expect(screen.getByText("Afwijking gedetecteerd")).toBeInTheDocument();
    expect(screen.getByText(/450 regels/)).toBeInTheDocument();
  });
});
