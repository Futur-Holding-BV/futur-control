import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseLinkNext, listMonitoredRepos } from "./github.js";

// ---------------------------------------------------------------------------
// parseLinkNext — pure unit tests
// ---------------------------------------------------------------------------

describe("parseLinkNext", () => {
  it("returns null when header is null", () => {
    expect(parseLinkNext(null)).toBeNull();
  });

  it("returns null when there is no rel=next link", () => {
    const header =
      '<https://api.github.com/orgs/fps/repos?page=3>; rel="last"';
    expect(parseLinkNext(header)).toBeNull();
  });

  it("extracts the next URL from a single-relation header", () => {
    const header =
      '<https://api.github.com/orgs/fps/repos?page=2&per_page=100>; rel="next"';
    expect(parseLinkNext(header)).toBe(
      "https://api.github.com/orgs/fps/repos?page=2&per_page=100",
    );
  });

  it("extracts the next URL from a multi-relation header", () => {
    const header =
      '<https://api.github.com/orgs/fps/repos?page=2&per_page=100>; rel="next", ' +
      '<https://api.github.com/orgs/fps/repos?page=5&per_page=100>; rel="last"';
    expect(parseLinkNext(header)).toBe(
      "https://api.github.com/orgs/fps/repos?page=2&per_page=100",
    );
  });
});

// ---------------------------------------------------------------------------
// listMonitoredRepos — integration-style tests with mocked fetch
// ---------------------------------------------------------------------------

function makeRepo(name: string) {
  return { name, html_url: `https://github.com/fps/${name}`, pushed_at: null, default_branch: "main" };
}

function mockFetchPage(repos: object[], nextUrl?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (nextUrl) {
    headers.set("Link", `<${nextUrl}>; rel="next"`);
  }
  return new Response(JSON.stringify(repos), { status: 200, headers });
}

describe("listMonitoredRepos", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Provide required env vars
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "fps-test-org";
    delete process.env.MONITORED_REPOS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("uses the MONITORED_REPOS env var when set, without calling fetch", async () => {
    process.env.MONITORED_REPOS = " Repo-A , Repo-B , Repo-C ";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const repos = await listMonitoredRepos();

    expect(repos).toEqual(["Repo-A", "Repo-B", "Repo-C"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches a single page of org repos when no Link header is present", async () => {
    const page1 = [makeRepo("Repo-One"), makeRepo("Repo-Two")];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockFetchPage(page1));

    const repos = await listMonitoredRepos();

    expect(repos).toEqual(["Repo-One", "Repo-Two"]);
  });

  it("follows pagination links to collect repos from all pages", async () => {
    const page1 = [makeRepo("Alpha"), makeRepo("Beta")];
    const page2 = [makeRepo("Gamma"), makeRepo("Delta")];
    const page3 = [makeRepo("Epsilon")];

    const page2Url = "https://api.github.com/orgs/fps-test-org/repos?page=2&per_page=100";
    const page3Url = "https://api.github.com/orgs/fps-test-org/repos?page=3&per_page=100";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockFetchPage(page1, page2Url))
      .mockResolvedValueOnce(mockFetchPage(page2, page3Url))
      .mockResolvedValueOnce(mockFetchPage(page3));

    const repos = await listMonitoredRepos();

    expect(repos).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("passes the correct Authorization header on every page request", async () => {
    const page1 = [makeRepo("Secure-Repo")];
    const page2 = [makeRepo("Another-Secure-Repo")];
    const page2Url = "https://api.github.com/orgs/fps-test-org/repos?page=2&per_page=100";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockFetchPage(page1, page2Url))
      .mockResolvedValueOnce(mockFetchPage(page2));

    await listMonitoredRepos();

    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    }
  });
});
