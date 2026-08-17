import { describe, it, expect } from "vitest";
import { isQuietTime } from "./quiet.js";

/**
 * All instants below are given in UTC; Europe/Amsterdam is UTC+2 in summer
 * (CEST) and UTC+1 in winter (CET). Comments show the local Amsterdam time.
 */
describe("isQuietTime (Europe/Amsterdam)", () => {
  // ── Weekdays: quiet 22:00 → 07:15 ──
  it("Monday 07:14 local is still quiet", () => {
    expect(isQuietTime(new Date("2026-08-17T05:14:00Z"))).toBe(true); // Mon 07:14 CEST
  });
  it("Monday 07:15 local is allowed", () => {
    expect(isQuietTime(new Date("2026-08-17T05:15:00Z"))).toBe(false); // Mon 07:15 CEST
  });
  it("Monday 12:00 local is allowed", () => {
    expect(isQuietTime(new Date("2026-08-17T10:00:00Z"))).toBe(false); // Mon 12:00 CEST
  });
  it("Monday 21:59 local is allowed", () => {
    expect(isQuietTime(new Date("2026-08-17T19:59:00Z"))).toBe(false); // Mon 21:59 CEST
  });
  it("Monday 22:00 local is quiet", () => {
    expect(isQuietTime(new Date("2026-08-17T20:00:00Z"))).toBe(true); // Mon 22:00 CEST
  });
  it("Tuesday 02:00 local is quiet", () => {
    expect(isQuietTime(new Date("2026-08-18T00:00:00Z"))).toBe(true); // Tue 02:00 CEST
  });

  // ── Weekend mornings: quiet until 09:00 ──
  it("Saturday 08:59 local is still quiet", () => {
    expect(isQuietTime(new Date("2026-08-22T06:59:00Z"))).toBe(true); // Sat 08:59 CEST
  });
  it("Saturday 09:00 local is allowed", () => {
    expect(isQuietTime(new Date("2026-08-22T07:00:00Z"))).toBe(false); // Sat 09:00 CEST
  });
  it("Saturday morning after a Friday-evening start uses the weekend boundary (07:30 still quiet)", () => {
    expect(isQuietTime(new Date("2026-08-22T05:30:00Z"))).toBe(true); // Sat 07:30 CEST
  });
  it("Sunday 08:30 local is quiet", () => {
    expect(isQuietTime(new Date("2026-08-23T06:30:00Z"))).toBe(true); // Sun 08:30 CEST
  });
  it("Monday morning after the weekend uses the weekday boundary again (08:00 allowed)", () => {
    expect(isQuietTime(new Date("2026-08-24T06:00:00Z"))).toBe(false); // Mon 08:00 CEST
  });

  // ── Winter time (CET, UTC+1) — DST handled via the IANA zone ──
  it("Wednesday in January 07:00 local (06:00 UTC) is quiet", () => {
    expect(isQuietTime(new Date("2026-01-14T06:00:00Z"))).toBe(true); // Wed 07:00 CET
  });
  it("Wednesday in January 07:15 local (06:15 UTC) is allowed", () => {
    expect(isQuietTime(new Date("2026-01-14T06:15:00Z"))).toBe(false); // Wed 07:15 CET
  });
  it("Wednesday in January 22:00 local (21:00 UTC) is quiet", () => {
    expect(isQuietTime(new Date("2026-01-14T21:00:00Z"))).toBe(true); // Wed 22:00 CET
  });
});
