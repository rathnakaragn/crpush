const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

// Pushover priorities: -2 lowest, -1 low, 0 normal, 1 high.
// Emergency (2) is deliberately unsupported — it requires retry/expire params.
export const DEFAULT_PRIORITIES: Record<string, number> = {
  pairing: 1,
  result: 0,
  completion: -1,
};

export function priorityForType(
  type: string,
  settingsMap: Record<string, string | undefined> = {},
): number {
  const fallback = DEFAULT_PRIORITIES[type] ?? 0;
  const raw = settingsMap[`priority_${type}`];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(-2, Math.min(1, n));
}

export async function sendPushover(
  appToken: string,
  userKey: string,
  title: string,
  message: string,
  url?: string,
  priority?: number,
): Promise<boolean> {
  try {
    const body: Record<string, string> = { token: appToken, user: userKey, title, message };
    if (url) { body.url = url; body.url_title = 'View on chess-results.com'; }
    if (typeof priority === 'number' && priority !== 0) body.priority = String(priority);
    const res = await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { status: number };
    return data.status === 1;
  } catch {
    return false;
  }
}
