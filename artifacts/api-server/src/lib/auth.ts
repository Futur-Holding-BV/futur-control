import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const SESSION_COOKIE = "fps_sessie";
const SESSION_DAYS = 30;

function secret(): string | null {
  return process.env.SESSION_SECRET ?? null;
}

export function adminPassword(): string | null {
  return process.env.ADMIN_PASSWORD ?? null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Token = `<expiry epoch ms>.<hmac>`, signed with SESSION_SECRET. */
export function createSessionToken(): string | null {
  const key = secret();
  if (!key) return null;
  const exp = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return `${exp}.${sign(exp, key)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  const key = secret();
  if (!key || !token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(exp, key);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > Date.now();
}

export function passwordMatches(candidate: string): boolean {
  const expected = adminPassword();
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Length leak is acceptable; timingSafeEqual requires equal lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

/** Fail closed: without a valid session cookie every guarded route is 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  if (verifySessionToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "Niet ingelogd." });
}
