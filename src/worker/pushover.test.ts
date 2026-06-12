import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPushover } from './pushover';

describe('sendPushover', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when Pushover responds with status 1', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 1 }),
    });
    const result = await sendPushover('apptoken', 'userkey', 'Test Title', 'Test message', 'https://example.com');
    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends correct JSON body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 1 }),
    });
    await sendPushover('mytoken', 'myuser', 'Round 3: WON!', 'vs Smith', 'https://chess-results.com/tnr123.aspx');
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.token).toBe('mytoken');
    expect(body.user).toBe('myuser');
    expect(body.title).toBe('Round 3: WON!');
    expect(body.message).toBe('vs Smith');
    expect(body.url).toBe('https://chess-results.com/tnr123.aspx');
    expect(body.url_title).toBe('View on chess-results.com');
  });

  it('returns false when Pushover responds with status 0', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 0, errors: ['user key is invalid'] }),
    });
    const result = await sendPushover('apptoken', 'badkey', 'Title', 'Message', 'https://example.com');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    const result = await sendPushover('apptoken', 'userkey', 'Title', 'Message', 'https://example.com');
    expect(result).toBe(false);
  });
});
