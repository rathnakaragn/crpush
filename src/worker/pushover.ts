const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

export async function sendPushover(
  appToken: string,
  userKey: string,
  title: string,
  message: string,
  url?: string,
): Promise<boolean> {
  try {
    const body: Record<string, string> = { token: appToken, user: userKey, title, message };
    if (url) { body.url = url; body.url_title = 'View on chess-results.com'; }
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
