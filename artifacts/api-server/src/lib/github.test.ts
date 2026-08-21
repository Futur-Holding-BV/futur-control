import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dispatchRestartWorkflow,
  findRestartWorkflow,
  getMonitoredRepoSelection,
  listMonitoredRepos,
  loadWorkflowRunDefinition,
  parseLinkNext,
} from "./github.js";

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

  it("uses MONITORED_REPOS but makes omitted org repositories visible", async () => {
    process.env.MONITORED_REPOS = " Repo-A , Repo-B , Repo-C ";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockFetchPage([
        makeRepo("Repo-A"),
        makeRepo("Repo-B"),
        makeRepo("FPS-Finance"),
        makeRepo("FPS-Archief"),
        makeRepo("FPS-Connect"),
        makeRepo("Koersa"),
        makeRepo("beheercentrum"),
      ]),
    );

    const selection = await getMonitoredRepoSelection();

    expect(selection.repos).toEqual(["Repo-A", "Repo-B", "Repo-C"]);
    expect(selection.omittedByOverride).toEqual([
      "FPS-Finance",
      "FPS-Archief",
      "FPS-Connect",
      "Koersa",
      "beheercentrum",
    ]);
    expect(selection.unknownInOverride).toEqual(["Repo-C"]);
    expect(fetchSpy).toHaveBeenCalledOnce();
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

  it("discovers current and future organisation repositories without an override", async () => {
    const page1 = [
      makeRepo("FPS-Finance"),
      makeRepo("FPS-Archief"),
      makeRepo("FPS-Connect"),
    ];
    const page2 = [
      makeRepo("Koersa"),
      makeRepo("beheercentrum"),
      makeRepo("Toekomstige-Codebase"),
    ];
    const page2Url = "https://api.github.com/orgs/fps-test-org/repos?page=2&per_page=100";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockFetchPage(page1, page2Url))
      .mockResolvedValueOnce(mockFetchPage(page2));

    const selection = await getMonitoredRepoSelection();

    expect(selection).toEqual({
      repos: [
        "FPS-Finance",
        "FPS-Archief",
        "FPS-Connect",
        "Koersa",
        "beheercentrum",
        "Toekomstige-Codebase",
      ],
      orgRepos: [
        "FPS-Finance",
        "FPS-Archief",
        "FPS-Connect",
        "Koersa",
        "beheercentrum",
        "Toekomstige-Codebase",
      ],
      overrideActive: false,
      omittedByOverride: [],
      unknownInOverride: [],
    });
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

describe("explicit restart workflow", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "fps-test-org";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only an active workflow named herstart with workflow_dispatch", async () => {
    const yaml = Buffer.from("name: herstart\non:\n  workflow_dispatch:\n").toString("base64");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflows: [
              {
                id: 91,
                name: "herstart",
                state: "active",
                path: ".github/workflows/herstart.yml",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { tag_name: "v1.2.3", immutable: true, draft: false },
        ]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ encoding: "base64", content: yaml }), {
          status: 200,
        }),
      );

    await expect(findRestartWorkflow("app-repo")).resolves.toEqual({
      id: 91,
      ref: "v1.2.3",
      definition: {
        name: "herstart",
        on: { workflow_dispatch: null },
      },
    });
  });

  it("rejects a workflow where workflow_dispatch appears only in a comment", async () => {
    const yaml = Buffer.from(
      "name: herstart\non:\n  push:\n# workflow_dispatch:\n",
    ).toString("base64");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflows: [
              {
                id: 91,
                name: "herstart",
                state: "active",
                path: ".github/workflows/herstart.yml",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { tag_name: "v1.2.3", immutable: true, draft: false },
        ]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ encoding: "base64", content: yaml }), {
          status: 200,
        }),
      );

    await expect(findRestartWorkflow("app-repo")).resolves.toBeNull();
  });

  it("rejects an immutable tagged workflow whose own name is not herstart", async () => {
    const yaml = Buffer.from(
      "name: deploy\non:\n  workflow_dispatch:\n",
    ).toString("base64");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflows: [
              {
                id: 91,
                name: "herstart",
                state: "active",
                path: ".github/workflows/herstart.yml",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { tag_name: "v1.2.3", immutable: true, draft: false },
        ]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ encoding: "base64", content: yaml }), {
          status: 200,
        }),
      );

    await expect(findRestartWorkflow("app-repo")).resolves.toBeNull();
  });

  it("loads the workflow definition from the exact commit used by the run", async () => {
    const yaml = Buffer.from(
      "name: CI\non: push\njobs:\n  build:\n    steps:\n      - run: pnpm test\n",
    ).toString("base64");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ encoding: "base64", content: yaml }), {
        status: 200,
      }),
    );

    await expect(
      loadWorkflowRunDefinition("app-repo", {
        id: 8,
        name: "CI",
        display_title: "CI",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.test/run/8",
        updated_at: "2026-08-20T10:00:00Z",
        path: ".github/workflows/ci.yml",
        head_sha: "abc123",
      }),
    ).resolves.toMatchObject({ name: "CI", jobs: expect.any(Object) });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/contents/.github/workflows/ci.yml?ref=abc123",
    );
  });

  it("dispatches the verified workflow at its immutable release tag", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      dispatchRestartWorkflow("app-repo", {
        id: 91,
        ref: "v1.2.3",
        definition: {},
      }),
    ).resolves.toEqual({
      ok: true,
      message: "Herstartworkflow gestart vanaf een onveranderlijke release.",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ ref: "v1.2.3" }));
  });

  it("rejects a restart workflow when no immutable release exists", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflows: [
              {
                id: 91,
                name: "herstart",
                state: "active",
                path: ".github/workflows/herstart.yml",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { tag_name: "v1.2.3", immutable: false, draft: false },
        ]), { status: 200 }),
      );

    await expect(findRestartWorkflow("app-repo")).resolves.toBeNull();
  });
});
