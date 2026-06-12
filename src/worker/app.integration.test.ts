import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "https://example.com";
const TEST_PASSWORD = "test-password";
const VALID_SESSION_URL = "https://chess-results.com/tnr123456.aspx?lan=1&art=9&fed=IND&snr=42";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function login(password = TEST_PASSWORD): Promise<string> {
  const res = await SELF.fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
  const raw = res.headers.get("Set-Cookie") ?? "";
  const match = raw.match(/session=([^;]+)/);
  return match ? `session=${match[1]}` : "";
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = await login();
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> ?? {}), Cookie: cookie },
    redirect: "manual",
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("Auth middleware", () => {
  it("redirects unauthenticated GET / to /login", async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("redirects unauthenticated GET /settings to /login", async () => {
    const res = await SELF.fetch(`${BASE}/settings`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("allows unauthenticated GET /login through", async () => {
    const res = await SELF.fetch(`${BASE}/login`, { redirect: "manual" });
    expect(res.status).toBe(200);
  });
});

describe("POST /login", () => {
  it("redirects to / and sets session cookie on correct password", async () => {
    const res = await SELF.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${TEST_PASSWORD}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toMatch(/session=/);
    expect(res.headers.get("Set-Cookie")).toMatch(/HttpOnly/);
  });

  it("redirects to /login?error=1 on wrong password", async () => {
    const res = await SELF.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=wrongpassword",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=1");
  });

  it("shows error message on /login?error=1", async () => {
    const res = await SELF.fetch(`${BASE}/login?error=1`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Incorrect password");
  });
});

describe("POST /logout", () => {
  it("clears session cookie and redirects to /login", async () => {
    const cookie = await login();
    const res = await SELF.fetch(`${BASE}/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
  });
});

// ── Sessions page ─────────────────────────────────────────────────────────────

describe("GET /", () => {
  it("returns 200 with sessions page when authenticated", async () => {
    const res = await authed("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Sessions");
    expect(body).toContain("Add New Session");
    expect(body).toContain("No sessions yet");
  });

  it("shows session count in header", async () => {
    const res = await authed("/");
    const body = await res.text();
    expect(body).toContain("0 running");
    expect(body).toContain("0 notifications sent");
  });
});

describe("POST /sessions", () => {
  it("rejects an empty URL and redirects to /", async () => {
    const res = await authed("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "url=",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const { results } = await env.DB.prepare("SELECT COUNT(*) as c FROM chess_sessions").all<{ c: number }>();
    expect(results[0].c).toBe(0);
  });

  it("rejects a non-chess-results.com URL and redirects to /", async () => {
    const res = await authed("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fexample.com%2Ftnr123.aspx%3Fsnr%3D1",
    });
    expect(res.status).toBe(302);
    const { results } = await env.DB.prepare("SELECT COUNT(*) as c FROM chess_sessions").all<{ c: number }>();
    expect(results[0].c).toBe(0);
  });

  it("creates a session for a valid chess-results.com URL", async () => {
    const res = await authed("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `url=${encodeURIComponent(VALID_SESSION_URL)}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const { results } = await env.DB.prepare("SELECT * FROM chess_sessions").all<{ url: string; status: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe(VALID_SESSION_URL);
    expect(results[0].status).toBe("running");
  });

  it("does not create a duplicate running session for the same URL", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation) VALUES (?, 'tnr123456', '42', '', 'IND')"
    ).bind(VALID_SESSION_URL).run();

    const res = await authed("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `url=${encodeURIComponent(VALID_SESSION_URL)}`,
    });
    expect(res.status).toBe(302);
    const { results } = await env.DB.prepare("SELECT COUNT(*) as c FROM chess_sessions").all<{ c: number }>();
    expect(results[0].c).toBe(1);
  });
});

describe("POST /sessions/:id/stop", () => {
  it("sets session status to stopped", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation) VALUES (?, 'tnr123456', '42', '', 'IND')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    const res = await authed(`/sessions/${id}/stop`, { method: "POST" });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare("SELECT status FROM chess_sessions WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("stopped");
  });
});

describe("POST /sessions/:id/toggle-notify", () => {
  it("toggles notify from 1 to 0", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, notify) VALUES (?, 'tnr123456', '42', '', 'IND', 1)"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    await authed(`/sessions/${id}/toggle-notify`, { method: "POST" });
    const row = await env.DB.prepare("SELECT notify FROM chess_sessions WHERE id = ?").bind(id).first<{ notify: number }>();
    expect(row?.notify).toBe(0);
  });

  it("toggles notify from 0 to 1", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, notify) VALUES (?, 'tnr123456', '42', '', 'IND', 0)"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    await authed(`/sessions/${id}/toggle-notify`, { method: "POST" });
    const row = await env.DB.prepare("SELECT notify FROM chess_sessions WHERE id = ?").bind(id).first<{ notify: number }>();
    expect(row?.notify).toBe(1);
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────

describe("GET /notifications", () => {
  it("returns 200 with notifications page", async () => {
    const res = await authed("/notifications");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Notifications");
    expect(body).toContain("No notifications yet");
  });
});

// ── Logs ─────────────────────────────────────────────────────────────────────

describe("GET /logs", () => {
  it("returns 200 with logs page", async () => {
    const res = await authed("/logs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Worker Logs");
    expect(body).toContain("No logs yet");
  });
});

describe("POST /logs/clear", () => {
  it("deletes all logs and redirects to /logs", async () => {
    await env.DB.prepare("INSERT INTO worker_logs (level, source, message) VALUES ('info', 'test', 'hello')").run();
    const res = await authed("/logs/clear", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/logs");
    const { results } = await env.DB.prepare("SELECT COUNT(*) as c FROM worker_logs").all<{ c: number }>();
    expect(results[0].c).toBe(0);
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("GET /settings", () => {
  it("returns 200 with settings page", async () => {
    const res = await authed("/settings");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Settings");
    expect(body).toContain("Pushover");
    expect(body).toContain("Quiet Hours");
  });
});

describe("POST /settings", () => {
  it("saves settings and redirects to /settings?saved=1", async () => {
    const res = await authed("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "pushover_app_token=mytoken&pushover_user_key=myuserkey&timezone=UTC&night_start_hour=22&night_end_hour=7",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?saved=1");

    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'pushover_app_token'").first<{ value: string }>();
    expect(row?.value).toBe("mytoken");
  });
});

describe("POST /settings/test", () => {
  it("redirects to /settings?testerror=1 when tokens are not configured", async () => {
    const res = await authed("/settings/test", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?testerror=1");
  });
});
