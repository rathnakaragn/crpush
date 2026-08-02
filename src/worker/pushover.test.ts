import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPushover, priorityForType } from './pushover';

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

  it('includes priority in the body when non-zero', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ status: 1 }) });
    await sendPushover('t', 'u', 'Title', 'Message', 'https://example.com', 1);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.priority).toBe('1');
  });

  it('omits priority from the body when zero or undefined', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ status: 1 }) });
    await sendPushover('t', 'u', 'Title', 'Message', 'https://example.com', 0);
    await sendPushover('t', 'u', 'Title', 'Message', 'https://example.com');
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(calls[0][1].body).priority).toBeUndefined();
    expect(JSON.parse(calls[1][1].body).priority).toBeUndefined();
  });
});

describe('priorityForType', () => {
  it('defaults: pairing high, result normal, completion low', () => {
    expect(priorityForType('pairing')).toBe(1);
    expect(priorityForType('result')).toBe(0);
    expect(priorityForType('completion')).toBe(-1);
  });

  it('defaults to normal for unknown types', () => {
    expect(priorityForType('something-else')).toBe(0);
  });

  it('reads overrides from priority_<type> settings keys', () => {
    const map = { priority_pairing: '0', priority_result: '-2', priority_completion: '1' };
    expect(priorityForType('pairing', map)).toBe(0);
    expect(priorityForType('result', map)).toBe(-2);
    expect(priorityForType('completion', map)).toBe(1);
  });

  it('falls back to the default on empty or non-numeric overrides', () => {
    expect(priorityForType('pairing', { priority_pairing: '' })).toBe(1);
    expect(priorityForType('completion', { priority_completion: 'abc' })).toBe(-1);
  });

  it('clamps overrides to the -2..1 range (no emergency)', () => {
    expect(priorityForType('result', { priority_result: '2' })).toBe(1);
    expect(priorityForType('result', { priority_result: '-9' })).toBe(-2);
  });
});
