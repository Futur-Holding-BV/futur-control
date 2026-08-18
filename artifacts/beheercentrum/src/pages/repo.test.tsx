/**
 * UI test: 'Hersteld na herhaling' badge on the repo detail page
 *
 * Confirms that:
 *   1. When navigating directly to /repo/:name (repos list not yet loaded),
 *      the badge is rendered from repo.recoveredAfterRetry on the detail object.
 *   2. The badge is absent when recoveredAfterRetry is false.
 *   3. The badge is absent when the status is not green, even if the flag is true.
 *   4. When the list IS loaded, the badge is driven by repoSummary.recoveredAfterRetry
 *      (the list value takes precedence via the `??` fallback chain).
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

// Wouter — pin the route param and render Link as a plain anchor.
vi.mock("wouter", () => ({
  useParams: () => ({ name: "test-repo" }),
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
let mockRepo: unknown = null;
let mockRepos: unknown[] = [];
let mockProposals: unknown[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useGetRepoDetail: () => ({
    data: mockRepo,
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
  useGetRepoSettings: () => ({ data: null }),
  getGetRepoSettingsQueryKey: (_name: string) => ["repoSettings", _name],
  useUpdateRepoSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RepoDetail object that repo.tsx is happy to render. */
function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-repo",
    status: "green" as const,
    staleReason: null,
    failReason: null,
    lastPushAt: null,
    lastCommitTitle: null,
    htmlUrl: null,
    checks: [],
    failedCheck: null,
    recoveredAfterRetry: false,
    ...overrides,
  };
}

const BADGE_TEXT = "Hersteld na herhaling";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RepoDetail — recovered-after-retry badge", () => {
  beforeEach(() => {
    mockRepos = [];
    mockProposals = [];
  });

  it("renders the badge when navigating directly and repo.recoveredAfterRetry is true", () => {
    // Direct navigation: repos list is empty, detail has recoveredAfterRetry: true.
    mockRepo = makeDetail({ recoveredAfterRetry: true, status: "green" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.getByText(BADGE_TEXT)).toBeInTheDocument();
  });

  it("does not render the badge when repo.recoveredAfterRetry is false (direct navigation)", () => {
    mockRepo = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });

  it("does not render the badge when status is not green, even if recoveredAfterRetry is true", () => {
    mockRepo = makeDetail({ recoveredAfterRetry: true, status: "red" });
    mockRepos = [];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });

  it("renders the badge from repoSummary when the repos list is loaded and its flag is true", () => {
    // List summary has the flag set; detail object does not — badge should still appear.
    mockRepo = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [{ name: "test-repo", recoveredAfterRetry: true }];

    render(<RepoDetail />);

    expect(screen.getByText(BADGE_TEXT)).toBeInTheDocument();
  });

  it("does not render the badge when both repos list and detail have recoveredAfterRetry: false", () => {
    mockRepo = makeDetail({ recoveredAfterRetry: false, status: "green" });
    mockRepos = [{ name: "test-repo", recoveredAfterRetry: false }];

    render(<RepoDetail />);

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
  });
});
