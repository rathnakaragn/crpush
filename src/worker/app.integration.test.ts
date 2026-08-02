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

// SELF.scheduled exists at runtime but is missing from the installed
// @cloudflare/vitest-pool-workers type definitions.
const runCron = () =>
  (SELF as unknown as { scheduled: (opts: { cron: string }) => Promise<unknown> })
    .scheduled({ cron: "*/5 * * * *" });

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

  it("serves self-contained CSS (no CDN) and shows the version footer", async () => {
    const loginBody = await (await SELF.fetch(`${BASE}/login`)).text();
    expect(loginBody).toContain("<style>");
    expect(loginBody).not.toContain("cdn.tailwindcss.com");

    const dashBody = await (await authed("/")).text();
    expect(dashBody).not.toContain("cdn.tailwindcss.com");
    expect(dashBody).toMatch(/OpenCRBot v\d+\.\d+\.\d+/);
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

describe("POST /sessions/:id/start", () => {
  it("does not resume a completed session", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'completed')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    const res = await authed(`/sessions/${id}/start`, { method: "POST" });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare("SELECT status FROM chess_sessions WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("completed");
  });

  it("keeps a stopped session stopped when the snapshot refresh fails", async () => {
    // Outbound fetches fail in the test environment, so fetchPlayerData
    // returns null — the silent-resume precondition — and status must not flip.
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'stopped')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    const res = await authed(`/sessions/${id}/start`, { method: "POST" });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare("SELECT status FROM chess_sessions WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("stopped");
  });
});

describe("POST /sessions/:id/delete", () => {
  it("deletes a stopped session and its notifications", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'stopped')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;
    await env.DB.prepare(
      "INSERT INTO notifications (session_id, type, title, message, round_number) VALUES (?, 'result', 't', 'm', 1)"
    ).bind(id).run();

    const res = await authed(`/sessions/${id}/delete`, { method: "POST" });
    expect(res.status).toBe(302);

    const session = await env.DB.prepare("SELECT id FROM chess_sessions WHERE id = ?").bind(id).first();
    expect(session).toBeNull();
    const notif = await env.DB.prepare("SELECT id FROM notifications WHERE session_id = ?").bind(id).first();
    expect(notif).toBeNull();
  });

  it("refuses to delete a running session", async () => {
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'running')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    const res = await authed(`/sessions/${id}/delete`, { method: "POST" });
    expect(res.status).toBe(302);

    const session = await env.DB.prepare("SELECT id FROM chess_sessions WHERE id = ?").bind(id).first();
    expect(session).not.toBeNull();
  });

  it("redirects without error for a nonexistent session id", async () => {
    const res = await authed(`/sessions/9999/delete`, { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("scheduled (cron)", () => {
  it("prunes worker logs older than 30 days and sent notifications older than 90 days", async () => {
    await env.DB.prepare(
      "INSERT INTO worker_logs (level, source, message, created_at) VALUES ('info', 'test', 'old-log', datetime('now', '-40 days'))"
    ).run();
    await env.DB.prepare(
      "INSERT INTO worker_logs (level, source, message) VALUES ('info', 'test', 'fresh-log')"
    ).run();
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'completed')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;
    await env.DB.prepare(
      "INSERT INTO notifications (session_id, type, title, message, sent, round_number, created_at) VALUES (?, 'result', 'old', 'm', 1, 1, datetime('now', '-100 days'))"
    ).bind(id).run();
    await env.DB.prepare(
      "INSERT INTO notifications (session_id, type, title, message, sent, round_number) VALUES (?, 'result', 'fresh', 'm', 1, 2)"
    ).bind(id).run();

    await runCron();

    const oldLog = await env.DB.prepare("SELECT id FROM worker_logs WHERE message = 'old-log'").first();
    expect(oldLog).toBeNull();
    const freshLog = await env.DB.prepare("SELECT id FROM worker_logs WHERE message = 'fresh-log'").first();
    expect(freshLog).not.toBeNull();
    const oldNotif = await env.DB.prepare("SELECT id FROM notifications WHERE title = 'old'").first();
    expect(oldNotif).toBeNull();
    const freshNotif = await env.DB.prepare("SELECT id FROM notifications WHERE title = 'fresh'").first();
    expect(freshNotif).not.toBeNull();
  }, 15000);

  it("marks a session as error after 3 consecutive fetch failures", async () => {
    // Outbound fetches fail in the test environment, so every cron run is a
    // fetch failure for the session.
    await env.DB.prepare(
      "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, status) VALUES (?, 'tnr123456', '42', '', 'IND', 'running')"
    ).bind(VALID_SESSION_URL).run();
    const { results } = await env.DB.prepare("SELECT id FROM chess_sessions").all<{ id: number }>();
    const id = results[0].id;

    for (let i = 0; i < 3; i++) {
      await runCron();
    }

    const row = await env.DB.prepare("SELECT status, fail_count FROM chess_sessions WHERE id = ?").bind(id)
      .first<{ status: string; fail_count: number }>();
    expect(row?.status).toBe("error");
    expect(row?.fail_count).toBe(3);
  }, 30000);
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

  it("renders priority selects with defaults (pairing high, result normal, completion low)", async () => {
    const body = await (await authed("/settings")).text();
    expect(body).toContain("Notification Priority");
    expect(body).toMatch(/name="priority_pairing"[\s\S]*?<option value="1" selected/);
    expect(body).toMatch(/name="priority_result"[\s\S]*?<option value="0" selected/);
    expect(body).toMatch(/name="priority_completion"[\s\S]*?<option value="-1" selected/);
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

  it("saves per-type priority settings", async () => {
    const res = await authed("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "priority_pairing=0&priority_result=-1&priority_completion=-2",
    });
    expect(res.status).toBe(302);

    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'priority_%' ORDER BY key"
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: "priority_completion", value: "-2" },
      { key: "priority_pairing", value: "0" },
      { key: "priority_result", value: "-1" },
    ]);
  });
});

describe("POST /settings/test", () => {
  it("redirects to /settings?testerror=1 when tokens are not configured", async () => {
    const res = await authed("/settings/test", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?testerror=1");
  });
});
