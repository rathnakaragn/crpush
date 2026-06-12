// ── Cookie auth ───────────────────────────────────────────────────────────────

export async function getCookieSecret(db: D1Database): Promise<CryptoKey> {
  let secret = (await db.prepare("SELECT value FROM settings WHERE key = 'session_cookie_secret'")
    .first<{ value: string }>())?.value;
  if (!secret) {
    secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("session_cookie_secret", secret).run();
  }
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function createSessionCookie(key: CryptoKey, username: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  const payload = btoa(`${username}:${exp}`);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySessionCookie(key: CryptoKey, cookie: string): Promise<string | null> {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  try {
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const decoded = atob(payload);
    const sep = decoded.lastIndexOf(":");
    const username = decoded.slice(0, sep);
    const expStr = decoded.slice(sep + 1);
    if (parseInt(expStr) < Math.floor(Date.now() / 1000)) return null;
    return username;
  } catch {
    return null;
  }
}

export async function getAuthUser(req: Request, db: D1Database): Promise<string | null> {
  const cookieHeader = req.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const key = await getCookieSecret(db);
  return verifySessionCookie(key, decodeURIComponent(match[1]));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password),
    "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 },
    keyMaterial, 256
  );
  const hash = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expectedHash] = stored.split(":");
  if (!salt || !expectedHash) return false;
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password),
    "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 },
    keyMaterial, 256
  );
  const hash = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return hash === expectedHash;
}
