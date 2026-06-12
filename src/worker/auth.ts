export function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function cookieKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function makeSessionCookie(password: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  const payload = String(exp);
  const key = await cookieKey(password);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySessionCookie(cookie: string, password: string): Promise<boolean> {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  try {
    const key = await cookieKey(password);
    const std = sig.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - std.length % 4) % 4);
    const sigBytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return false;
    return parseInt(payload) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
