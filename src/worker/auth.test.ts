import { describe, it, expect } from "vitest";
import { b64url, makeSessionCookie, verifySessionCookie } from "./auth";

describe("b64url", () => {
  it("encodes a buffer to base64url without padding", async () => {
    const buf = new TextEncoder().encode("hello");
    const result = b64url(buf.buffer as ArrayBuffer);
    expect(result).toBe("aGVsbG8");
    expect(result).not.toContain("=");
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
  });

  it("replaces + with - and / with _", async () => {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("test-key"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("data")));
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
    expect(sig).not.toContain("=");
  });
});

describe("makeSessionCookie", () => {
  it("returns a string in payload.signature format", async () => {
    const cookie = await makeSessionCookie("mypassword");
    const parts = cookie.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\d+$/);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("payload is a future unix timestamp (7 days from now)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const cookie = await makeSessionCookie("mypassword");
    const exp = parseInt(cookie.split(".")[0]);
    const after = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThanOrEqual(before + 86400 * 7 - 1);
    expect(exp).toBeLessThanOrEqual(after + 86400 * 7 + 1);
  });

  it("different passwords produce different signatures", async () => {
    const c1 = await makeSessionCookie("password1");
    const c2 = await makeSessionCookie("password2");
    expect(c1.split(".")[1]).not.toBe(c2.split(".")[1]);
  });
});

describe("verifySessionCookie", () => {
  it("verifies a freshly made cookie", async () => {
    const password = "s3cr3t";
    const cookie = await makeSessionCookie(password);
    expect(await verifySessionCookie(cookie, password)).toBe(true);
  });

  it("rejects a cookie verified with the wrong password", async () => {
    const cookie = await makeSessionCookie("correct-password");
    expect(await verifySessionCookie(cookie, "wrong-password")).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const password = "s3cr3t";
    const cookie = await makeSessionCookie(password);
    const [, sig] = cookie.split(".");
    const fakeExp = Math.floor(Date.now() / 1000) + 99999;
    const tampered = `${fakeExp}.${sig}`;
    expect(await verifySessionCookie(tampered, password)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const password = "s3cr3t";
    const cookie = await makeSessionCookie(password);
    const [payload] = cookie.split(".");
    const tampered = `${payload}.invalidsignatureXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    expect(await verifySessionCookie(tampered, password)).toBe(false);
  });

  it("rejects a cookie with no dot separator", async () => {
    expect(await verifySessionCookie("nodothere", "password")).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const password = "s3cr3t";
    const expiredPayload = String(Math.floor(Date.now() / 1000) - 1);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expiredPayload)));
    const expiredCookie = `${expiredPayload}.${sig}`;
    expect(await verifySessionCookie(expiredCookie, password)).toBe(false);
  });

  it("rejects an empty string", async () => {
    expect(await verifySessionCookie("", "password")).toBe(false);
  });
});
