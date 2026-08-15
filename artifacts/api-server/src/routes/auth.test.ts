/**
 * Integration tests for POST /api/auth/login.
 *
 * These tests spin up a minimal Express app with only the auth router, so they
 * exercise the full HTTP path (rate-limiter → password check → cookie) without
 * needing a database or background monitor.
 *
 * Each test uses a unique X-Forwarded-For IP so the in-memory failMap in
 * auth.ts stays isolated across tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";
import authRouter from "./auth.js";

// ---------------------------------------------------------------------------
// Minimal test app
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1); // honour X-Forwarded-For → req.ip
app.use(cookieParser());
app.use(express.json());
app.use("/api", authRouter);

const agent = supertest(app);

// ---------------------------------------------------------------------------
// Environment stubs — set before any test runs
// ---------------------------------------------------------------------------

const CORRECT_PASSWORD = "geheim123";
const TEST_SECRET = "test-session-secret";

beforeAll(() => {
  process.env.ADMIN_PASSWORD = CORRECT_PASSWORD;
  process.env.SESSION_SECRET = TEST_SECRET;
});

// ---------------------------------------------------------------------------
// Fake timers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POST /api/auth/login with the given password, spoofing the client IP. */
function login(ip: string, password: string) {
  return agent
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ password });
}

/** POST with a wrong password `n` times for the given IP. */
async function failTimes(ip: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await login(ip, "fout-wachtwoord");
  }
}

// ---------------------------------------------------------------------------
// 1. 5 foute pogingen → 6e geeft 429 met Nederlandse melding
// ---------------------------------------------------------------------------

describe("POST /api/auth/login — brute-force blokkering", () => {
  it("geeft 401 bij de eerste vier foute pogingen (nog geen blokkering)", async () => {
    const ip = "10.0.1.1";
    for (let i = 0; i < 4; i++) {
      const res = await login(ip, "fout");
      expect(res.status).toBe(401);
    }
  });

  it("geeft 429 bij de 5e foute poging (drempel bereikt)", async () => {
    const ip = "10.0.1.2";
    await failTimes(ip, 4);
    const res = await login(ip, "fout");
    expect(res.status).toBe(429);
  });

  it("bevat een Nederlandse foutmelding bij 429", async () => {
    const ip = "10.0.1.3";
    await failTimes(ip, 4);
    const res = await login(ip, "fout");
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Te veel mislukte inlogpogingen/);
    expect(res.body.error).toMatch(/seconde/); // Dutch time unit
  });

  it("geeft ook 429 bij de 6e poging als het IP al geblokkeerd is", async () => {
    const ip = "10.0.1.4";
    await failTimes(ip, 5); // 5e poging blokkeert
    const res = await login(ip, "fout"); // 6e poging
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Te veel mislukte inlogpogingen/);
  });

  it("geeft 429 zelfs met het juiste wachtwoord als het IP geblokkeerd is", async () => {
    const ip = "10.0.1.5";
    await failTimes(ip, 5); // blokkeert het IP
    const res = await login(ip, CORRECT_PASSWORD); // correct wachtwoord, maar geblokkeerd
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// 2. Na een succesvol inloggen is de teller gereset
// ---------------------------------------------------------------------------

describe("POST /api/auth/login — teller reset na succesvol inloggen", () => {
  it("staat 4 nieuwe foute pogingen toe na een succesvolle login (teller op 0)", async () => {
    const ip = "10.0.2.1";

    // Bouw wat mislukte pogingen op
    await failTimes(ip, 3);

    // Succesvol inloggen — teller moet resetten
    const loginRes = await login(ip, CORRECT_PASSWORD);
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.ok).toBe(true);

    // Na reset: 4 foute pogingen mogen geen 429 geven
    for (let i = 0; i < 4; i++) {
      const res = await login(ip, "fout-na-reset");
      expect(res.status).toBe(401);
    }
  });

  it("blokkeert het IP opnieuw na 5 nieuwe foute pogingen post-reset", async () => {
    const ip = "10.0.2.2";

    // Eerste blokkering opbouwen en wissen via succesvolle login
    await failTimes(ip, 4);
    await login(ip, CORRECT_PASSWORD);

    // Opnieuw 5 foute pogingen: 5e moet 429 geven
    await failTimes(ip, 4);
    const res = await login(ip, "fout");
    expect(res.status).toBe(429);
  });

  it("retourneert een sessie-cookie bij succesvol inloggen", async () => {
    const ip = "10.0.2.3";
    const res = await login(ip, CORRECT_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookies: string[] = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"]
      : [res.headers["set-cookie"]];
    expect(cookies.some((c: string) => c.startsWith("fps_sessie="))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Na het verstrijken van het tijdvenster zijn nieuwe pogingen weer toegestaan
// ---------------------------------------------------------------------------

describe("POST /api/auth/login — tijdvenster verloopt", () => {
  it("is geblokkeerd direct na 5 foute pogingen", async () => {
    const ip = "10.0.3.1";
    await failTimes(ip, 5);
    const res = await login(ip, "fout");
    expect(res.status).toBe(429);
  });

  it("staat nieuwe pogingen toe nadat het blokkeringsvenster (60 s) is verstreken", async () => {
    const ip = "10.0.3.2";
    await failTimes(ip, 5); // IP wordt geblokkeerd

    vi.advanceTimersByTime(60_001); // 60+ seconden vooruit

    // Nu moet een nieuwe poging weer 401 (onjuist wachtwoord) geven, niet 429
    const res = await login(ip, "fout-na-verloop");
    expect(res.status).toBe(401);
  });

  it("staat succesvol inloggen toe nadat het blokkeringsvenster is verstreken", async () => {
    const ip = "10.0.3.3";
    await failTimes(ip, 5);

    vi.advanceTimersByTime(60_001);

    const res = await login(ip, CORRECT_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("melding bevat resterende seconden als het IP nog half geblokkeerd is", async () => {
    const ip = "10.0.3.4";
    await failTimes(ip, 5); // geblokkeerd voor 60 s

    vi.advanceTimersByTime(30_000); // 30 s vooruit — nog ~30 s geblokkeerd

    const res = await login(ip, "fout");
    expect(res.status).toBe(429);
    // Melding moet een getal bevatten (resterende seconden)
    expect(res.body.error).toMatch(/\d+\s*seconde/);
  });
});
