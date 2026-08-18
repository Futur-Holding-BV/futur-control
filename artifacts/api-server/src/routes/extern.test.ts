/**
 * Tests voor het externe leesadres en het sleutelbeheer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state: {
  keyRows: Array<{ name: string; key: string; createdAt: Date }>;
  snapshots: Array<Record<string, unknown>>;
} = { keyRows: [], snapshots: [] };

const loggedActions: Array<Record<string, unknown>> = [];

vi.mock("../lib/actionlog.js", () => ({
  logAction: vi.fn(async (input: Record<string, unknown>) => {
    loggedActions.push(input);
    return 1;
  }),
}));

vi.mock("@workspace/db", () => {
  const makeSelect = () => ({
    from: (table: unknown) => {
      const isKeys = table === "API_KEYS";
      const rows = isKeys ? state.keyRows : state.snapshots;
      const result = Promise.resolve(rows) as Promise<unknown> & {
        where: () => Promise<unknown>;
      };
      result.where = () => Promise.resolve(rows);
      return result;
    },
  });
  return {
    db: {
      select: () => makeSelect(),
      insert: () => ({
        values: (v: { name: string; key: string }) => {
          const exists = state.keyRows.some((r) => r.name === v.name);
          const doInsert = () => {
            if (!exists)
              state.keyRows.push({ ...v, createdAt: new Date() });
          };
          return {
            onConflictDoNothing: () => {
              const p = Promise.resolve() as Promise<void> & {
                returning: () => Promise<Array<{ name: string }>>;
              };
              p.returning = () => {
                doInsert();
                return Promise.resolve(exists ? [] : [{ name: v.name }]);
              };
              doInsert();
              return p;
            },
          };
        },
      }),
      delete: () => ({
        where: () => ({
          returning: () => {
            // eenvoudige nabootsing: verwijder de laatst opgevraagde naam via marker
            const naam = state.snapshots.length === -1 ? "" : deleteTarget;
            const before = state.keyRows.length;
            state.keyRows = state.keyRows.filter((r) => r.name !== naam);
            return Promise.resolve(
              before === state.keyRows.length ? [] : [{ name: naam }],
            );
          },
        }),
      }),
    },
    apiKeys: "API_KEYS",
    repoStatusSnapshots: "SNAPSHOTS",
  };
});

let deleteTarget = "";

const { externPublicRouter, externAdminRouter, resetRateLimiter, isRateLimited } =
  await import("./extern.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(externPublicRouter);
  app.use((req, _res, next) => {
    // vang de doelnaam voor de delete-mock
    const m = /^\/extern\/sleutels\/(.+)$/.exec(req.path);
    if (m && req.method === "DELETE") deleteTarget = decodeURIComponent(m[1]!);
    next();
  });
  app.use(externAdminRouter);
  return app;
}

beforeEach(() => {
  state.keyRows = [
    { name: "connect", key: "geheime-sleutel", createdAt: new Date() },
  ];
  state.snapshots = [];
  loggedActions.length = 0;
  resetRateLimiter();
});

describe("GET /extern/status", () => {
  it("weigert zonder of met verkeerde sleutel, zonder gegevens", async () => {
    const app = makeApp();
    const r1 = await request(app).get("/extern/status");
    expect(r1.status).toBe(401);
    expect(r1.body.storingen).toBeUndefined();
    const r2 = await request(app)
      .get("/extern/status")
      .set("X-Lees-Sleutel", "fout");
    expect(r2.status).toBe(401);
    expect(loggedActions.length).toBe(0);
  });

  it("geeft samenvatting met omschrijving, tijdstip en adres per storing", async () => {
    const sinds = new Date("2026-08-18T04:00:00Z");
    state.snapshots = [
      { repoName: "app-x", status: "red", problemSince: sinds },
      { repoName: "app-y", status: "gray", problemSince: sinds },
      { repoName: "ok", status: "green", problemSince: null },
    ];
    const res = await request(makeApp())
      .get("/extern/status")
      .set("X-Lees-Sleutel", "geheime-sleutel");
    expect(res.status).toBe(200);
    expect(res.body.zwaarste).toBe("rood");
    expect(res.body.aantalStoringen).toBe(2);
    const [a, b] = res.body.storingen;
    expect(a.omschrijving).toContain("Controle faalt");
    expect(b.omschrijving).toContain("Geen werkende controle");
    expect(a.tijdstip).toBe(sinds.toISOString());
    expect(a.adres.endsWith("/repo/app-x")).toBe(true);
  });

  it("logt elke geldige aanvraag met de sleutelnaam", async () => {
    const res = await request(makeApp())
      .get("/extern/status")
      .set("X-Lees-Sleutel", "geheime-sleutel");
    expect(res.status).toBe(200);
    expect(loggedActions.length).toBe(1);
    expect(loggedActions[0]!["kind"]).toBe("extern_lezen");
    expect(String(loggedActions[0]!["reason"])).toContain("connect");
  });

  it("weigert boven de 60 aanvragen per minuut per sleutel", async () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) expect(isRateLimited("s", now + i)).toBe(false);
    expect(isRateLimited("s", now + 100)).toBe(true);
    // andere sleutel heeft een eigen venster
    expect(isRateLimited("anders", now + 100)).toBe(false);
    // nieuw venster na een minuut
    expect(isRateLimited("s", now + 61_000)).toBe(false);
  });

  it("geeft 429 via de route wanneer de limiet bereikt is", async () => {
    const app = makeApp();
    for (let i = 0; i < 60; i++) {
      await request(app)
        .get("/extern/status")
        .set("X-Lees-Sleutel", "geheime-sleutel");
    }
    const res = await request(app)
      .get("/extern/status")
      .set("X-Lees-Sleutel", "geheime-sleutel");
    expect(res.status).toBe(429);
    const laatste = loggedActions[loggedActions.length - 1]!;
    expect(String(laatste["outcome"])).toContain("geweigerd");
  });

  it("geeft 'rustig' zonder problemen en 'aandacht' bij geel", async () => {
    state.snapshots = [{ repoName: "a", status: "green", problemSince: null }];
    let res = await request(makeApp())
      .get("/extern/status")
      .set("X-Lees-Sleutel", "geheime-sleutel");
    expect(res.body.zwaarste).toBe("rustig");
    state.snapshots = [{ repoName: "a", status: "yellow", problemSince: null }];
    resetRateLimiter();
    res = await request(makeApp())
      .get("/extern/status")
      .set("X-Lees-Sleutel", "geheime-sleutel");
    expect(res.body.zwaarste).toBe("aandacht");
  });
});

describe("sleutelbeheer", () => {
  it("somt namen op zonder sleutelwaarden", async () => {
    const res = await request(makeApp()).get("/extern/sleutels");
    expect(res.status).toBe(200);
    expect(res.body.sleutels[0].naam).toBe("connect");
    expect(JSON.stringify(res.body)).not.toContain("geheime-sleutel");
  });

  it("maakt een sleutel aan en toont de waarde éénmalig", async () => {
    const res = await request(makeApp())
      .post("/extern/sleutels")
      .send({ naam: "planner" });
    expect(res.status).toBe(201);
    expect(res.body.naam).toBe("planner");
    expect(res.body.sleutel.length).toBeGreaterThan(20);
  });

  it("weigert dubbele namen en rare namen", async () => {
    const app = makeApp();
    expect(
      (await request(app).post("/extern/sleutels").send({ naam: "connect" }))
        .status,
    ).toBe(409);
    expect(
      (await request(app).post("/extern/sleutels").send({ naam: "x" })).status,
    ).toBe(400);
  });

  it("trekt een sleutel in zonder de rest te raken", async () => {
    state.keyRows.push({ name: "planner", key: "k2", createdAt: new Date() });
    const app = makeApp();
    const res = await request(app).delete("/extern/sleutels/planner");
    expect(res.status).toBe(200);
    expect(state.keyRows.map((r) => r.name)).toEqual(["connect"]);
    expect((await request(app).delete("/extern/sleutels/bestaat-niet")).status).toBe(404);
  });
});
