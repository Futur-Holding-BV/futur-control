import { Router, type IRouter } from "express";
import {
  SESSION_COOKIE,
  adminPassword,
  createSessionToken,
  loginBlockedMs,
  passwordMatches,
  recordFailedLogin,
  requireAuth,
  resetLoginCounter,
  sessionCookieOptions,
} from "../lib/auth.js";

const router: IRouter = Router();

router.post("/auth/login", (req, res) => {
  if (!adminPassword() || !process.env.SESSION_SECRET) {
    res.status(503).json({
      error:
        "De inlog is nog niet ingericht: het geheim ADMIN_PASSWORD (en SESSION_SECRET) ontbreekt.",
    });
    return;
  }

  // Brute-force check
  const ip = req.ip ?? "unknown";
  const blockedMs = loginBlockedMs(ip);
  if (blockedMs > 0) {
    const secLeft = Math.ceil(blockedMs / 1000);
    res.status(429).json({
      error: `Te veel mislukte inlogpogingen. Probeer het over ${secLeft} seconde${secLeft === 1 ? "" : "n"} opnieuw.`,
    });
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!passwordMatches(password)) {
    const nowBlockedMs = recordFailedLogin(ip);
    if (nowBlockedMs > 0) {
      const secLeft = Math.ceil(nowBlockedMs / 1000);
      res.status(429).json({
        error: `Te veel mislukte inlogpogingen. Probeer het over ${secLeft} seconde${secLeft === 1 ? "" : "n"} opnieuw.`,
      });
    } else {
      res.status(401).json({ error: "Onjuist wachtwoord." });
    }
    return;
  }

  resetLoginCounter(ip);
  const token = createSessionToken();
  if (!token) {
    res.status(503).json({ error: "De inlog is nog niet ingericht (SESSION_SECRET ontbreekt)." });
    return;
  }
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.json({ ok: true });
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});

export default router;
