const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

export async function sendPushover(
  appToken: string,
  userKey: string,
  title: string,
  message: string,
  url: string,
): Promise<boolean> {
  try {
    const res = await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: appToken,
        user: userKey,
        title,
        message,
        url,
        url_title: 'View on chess-results.com',
      }),
    });
    const data = await res.json() as { status: number };
    return data.status === 1;
  } catch {
    return false;
  }
}
