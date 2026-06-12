import { parseSessionData, calculatePoints, type ChessSession } from "./chess";

// ── HTML helpers ──────────────────────────────────────────────────────────────

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function statusBadge(status: string): string {
  const styles: Record<string, string> = {
    running: "bg-green-100 text-green-800",
    stopped: "bg-gray-100 text-gray-700",
    completed: "bg-blue-100 text-blue-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? "bg-gray-100 text-gray-700"}">${status}</span>`;
}

export function levelBadge(level: string): string {
  const styles: Record<string, string> = {
    info: "bg-gray-100 text-gray-700",
    warn: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[level] ?? "bg-gray-100 text-gray-700"}">${level}</span>`;
}

export function layout(title: string, content: string, activePage = ""): string {
  const link = (href: string, label: string, page: string) =>
    `<a href="${href}" class="text-sm ${activePage === page ? "text-blue-600 font-medium" : "text-gray-600 hover:text-gray-900"}">${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — OpenCRBot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 sticky top-0 z-10">
    <a href="/" class="font-bold text-gray-900 text-lg">♟ OpenCRBot</a>
    ${link("/", "Sessions", "sessions")}
    ${link("/notifications", "Notifications", "notifications")}
    ${link("/logs", "Logs", "logs")}
    ${link("/settings", "Settings", "settings")}
    <div class="ml-auto">
      <form method="POST" action="/logout">
        <button type="submit" class="text-sm text-gray-500 hover:text-gray-900">Logout</button>
      </form>
    </div>
  </nav>
  <main class="max-w-5xl mx-auto px-6 py-8">${content}</main>
</body>
</html>`;
}

export function formatSession(s: Record<string, unknown>) {
  const data = parseSessionData(s as unknown as ChessSession);
  return {
    id: s.id as number,
    url: s.url as string,
    status: s.status as string,
    notify: Boolean(s.notify ?? 1),
    tournament: data.tournament_name || "",
    player: data.player?.name || "Unknown",
    rank: data.player?.current_rank || "?",
    points: calculatePoints(data.matches || []),
    completedRounds: data.completed_rounds || 0,
    totalRounds: data.total_rounds || 0,
  };
}
