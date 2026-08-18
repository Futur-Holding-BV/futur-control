/**
 * UI test: gray repo card with staleReason
 *
 * Confirms that when the list API returns a gray repo with a staleReason,
 * the home page renders that reason alongside the HelpCircle icon so the
 * operator is never left with a bare, unexplained gray dot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./home";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Tanstack Query — we only need a queryClient stub for invalidateQueries.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// Wouter — render <Link> as a plain anchor so we don't need a router.
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// API client hooks — controlled per test via the module-level variables below.
let mockRepos: unknown[] = [];
let mockExpiryItems: unknown[] = [];
let mockProposals: unknown[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useListRepos: () => ({ data: mockRepos, isLoading: false, isError: false, isRefetching: false }),
  getListReposQueryKey: () => ["listRepos"],
  useListExpiryItems: () => ({ data: mockExpiryItems }),
  useListProposals: () => ({ data: mockProposals }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal repo object that satisfies the type expected by home.tsx */
function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-repo",
    status: "gray" as const,
    staleReason: null,
    failReason: null,
    lastPushAt: null,
    lastCommitTitle: null,
    recoveredAfterRetry: false,
    anomaly: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Home — gray repo card with staleReason", () => {
  beforeEach(() => {
    mockExpiryItems = [];
    mockProposals = [];
  });

  it("renders the staleReason text when the API includes one for a gray repo", () => {
    const reason =
      "geen actieve GitHub Actions-checks gevonden en geen commit-informatie beschikbaar";
    mockRepos = [makeRepo({ staleReason: reason })];

    render(<Home />);

    // The staleReason text must appear on screen.
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("does not render a staleReason block when staleReason is null", () => {
    const reason =
      "geen actieve GitHub Actions-checks gevonden en geen commit-informatie beschikbaar";
    mockRepos = [makeRepo({ staleReason: null })];

    render(<Home />);

    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it("renders the HelpCircle svg alongside the staleReason text", () => {
    const reason = "geen commit-informatie beschikbaar — ouderdom van de code kan niet worden vastgesteld";
    mockRepos = [makeRepo({ status: "gray", staleReason: reason })];

    render(<Home />);

    // The reason text is inside the same container as the HelpCircle icon.
    const reasonEl = screen.getByText(reason);
    // The icon is the previous sibling svg within the same flex wrapper.
    const wrapper = reasonEl.closest("div.flex");
    expect(wrapper).toBeInTheDocument();
    const svg = wrapper?.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("does not show a staleReason block for a green repo", () => {
    const reason = "zou niet getoond mogen worden";
    mockRepos = [makeRepo({ status: "green", staleReason: reason })];

    render(<Home />);

    // home.tsx only renders the block when isGray is true.
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });
});
