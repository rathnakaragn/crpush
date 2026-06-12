import { describe, it, expect, beforeEach } from "vitest";
import { b64url, createSessionCookie, verifySessionCookie, hashPassword, verifyPassword } from "./auth";

describe("b64url", () => {
  it("encodes to base64url (no +, /, =)", () => {
    const buf = new Uint8Array([251, 252, 253, 254]).buffer;
    const result = b64url(buf);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });
});

describe("createSessionCookie / verifySessionCookie", () => {
  let key: CryptoKey;

  beforeEach(async () => {
    key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("test-secret-32-bytes-long-xxxxxxx"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
    );
  });

  it("verifies a freshly created cookie", async () => {
    const cookie = await createSessionCookie(key, "admin");
    const username = await verifySessionCookie(key, cookie);
    expect(username).toBe("admin");
  });

  it("rejects a tampered signature", async () => {
    const cookie = await createSessionCookie(key, "admin");
    const tampered = cookie.slice(0, -4) + "xxxx";
    const result = await verifySessionCookie(key, tampered);
    expect(result).toBeNull();
  });

  it("rejects an expired cookie", async () => {
    // Manually craft an expired cookie
    const exp = Math.floor(Date.now() / 1000) - 1; // 1 second in the past
    const payload = btoa(`admin:${exp}`);
    const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const cookie = `${payload}.${sig}`;
    const result = await verifySessionCookie(key, cookie);
    expect(result).toBeNull();
  });

  it("rejects a cookie with no dot separator", async () => {
    const result = await verifySessionCookie(key, "nodot");
    expect(result).toBeNull();
  });

  it("handles username containing a colon", async () => {
    const cookie = await createSessionCookie(key, "admin:extra");
    const username = await verifySessionCookie(key, cookie);
    expect(username).toBe("admin:extra");
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifies a freshly hashed password", async () => {
    const hash = await hashPassword("secret123");
    expect(await verifyPassword("secret123", hash)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("secret123");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("returns false for malformed stored value (no colon)", async () => {
    expect(await verifyPassword("anything", "nocolon")).toBe(false);
  });

  it("produces different hashes for same password (random salt)", async () => {
    const h1 = await hashPassword("same");
    const h2 = await hashPassword("same");
    expect(h1).not.toBe(h2);
  });
});
