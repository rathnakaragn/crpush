import { describe, it, expect } from 'vitest';
import { calculatePoints, calculateTotalRatingChange, parseSessionData, shouldRunCron, pollCadence, sessionCadence, parseBaseMinutes, isRateLimitedHtml } from './chess';
import type { ChessSession } from './chess';

const makeSession = (overrides: Partial<ChessSession> = {}): ChessSession => ({
  id: 1, url: '', server: '', tournament_id: '', player_snr: '',
  federation: 'IND', status: 'running', notify: 1, fail_count: 0,
  data: '{}', created_at: '', updated_at: '', ...overrides,
});

describe('calculatePoints', () => {
  it('sums completed match results', () => {
    const matches = [
      { round_number: 1, result: '1', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
      { round_number: 2, result: '0', opponent_name: 'B', opponent_rank: '2', opponent_rating: 1600, color: 'Black', board: '2' },
      { round_number: 3, result: '½', opponent_name: 'C', opponent_rank: '3', opponent_rating: 1400, color: 'White', board: '3' },
    ];
    expect(calculatePoints(matches)).toBe(1.5);
  });

  it('ignores matches without a result', () => {
    const matches = [
      { round_number: 1, result: '', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
      { round_number: 2, result: '1', opponent_name: 'B', opponent_rank: '2', opponent_rating: 1600, color: 'Black', board: '2' },
    ];
    expect(calculatePoints(matches)).toBe(1);
  });

  it('returns 0 for empty match array', () => {
    expect(calculatePoints([])).toBe(0);
  });
});

describe('calculateTotalRatingChange', () => {
  it('gains ~10 Elo for winning against an equal opponent', () => {
    const matches = [
      { round_number: 1, result: '1', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
    ];
    const { total } = calculateTotalRatingChange(1500, matches, 20);
    expect(total).toBeGreaterThan(9);
    expect(total).toBeLessThan(11);
  });

  it('returns 0 for no completed matches', () => {
    const { total } = calculateTotalRatingChange(1500, [], 20);
    expect(total).toBe(0);
  });

  it('loses Elo for losing to a lower-rated opponent', () => {
    const matches = [
      { round_number: 1, result: '0', opponent_name: 'A', opponent_rank: '5', opponent_rating: 1300, color: 'White', board: '1' },
    ];
    const { total } = calculateTotalRatingChange(1500, matches, 20);
    expect(total).toBeLessThan(-10);
  });
});

describe('parseSessionData', () => {
  it('returns defaults for empty JSON', () => {
    const data = parseSessionData(makeSession({ data: '{}' }));
    expect(data.total_rounds).toBe(0);
    expect(data.matches).toEqual([]);
    expect(data.player.name).toBe('Unknown');
  });

  it('returns defaults for invalid JSON', () => {
    const data = parseSessionData(makeSession({ data: 'not-json' }));
    expect(data.total_rounds).toBe(0);
    expect(data.player.name).toBe('Unknown');
  });

  it('parses stored session data correctly', () => {
    const session = makeSession({
      data: JSON.stringify({
        total_rounds: 7, completed_rounds: 3,
        player: { name: 'Smith, John', current_rank: '5', starting_rank: '8', rating: 1650, kFactor: 20 },
        ratingChange: 12, performanceRating: 1700, matches: [],
      }),
    });
    const data = parseSessionData(session);
    expect(data.total_rounds).toBe(7);
    expect(data.player.name).toBe('Smith, John');
    expect(data.ratingChange).toBe(12);
  });
});

describe("quiet hours logic", () => {
  function isQuietHour(hour: number, nightStart: number, nightEnd: number): boolean {
    return nightStart > nightEnd
      ? hour >= nightStart || hour < nightEnd
      : hour >= nightStart && hour < nightEnd;
  }

  it("is quiet at 23:00 when quiet hours are 23–6", () => {
    expect(isQuietHour(23, 23, 6)).toBe(true);
  });

  it("is quiet at 2:00 (midnight crossing)", () => {
    expect(isQuietHour(2, 23, 6)).toBe(true);
  });

  it("is not quiet at 10:00", () => {
    expect(isQuietHour(10, 23, 6)).toBe(false);
  });

  it("handles midnight as hour 0 (not 24)", () => {
    expect(isQuietHour(0, 23, 6)).toBe(true);
  });

  it("same-hemisphere: quiet 9–17 does not wrap", () => {
    expect(isQuietHour(12, 9, 17)).toBe(true);
    expect(isQuietHour(8, 9, 17)).toBe(false);
    expect(isQuietHour(18, 9, 17)).toBe(false);
  });

  it("boundary: nightEnd hour is not quiet", () => {
    expect(isQuietHour(6, 23, 6)).toBe(false);
  });
});

describe('parseBaseMinutes', () => {
  it('parses chess-results style time controls', () => {
    expect(parseBaseMinutes('15 MINUTES +5 SECONDS BONUS FROM MOVE NUMBER 1')).toBe(15);
    expect(parseBaseMinutes('90 min + 30 sec/move')).toBe(90);
    expect(parseBaseMinutes('15+5')).toBe(15);
    expect(parseBaseMinutes("25'+10\"")).toBe(25);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseBaseMinutes(undefined)).toBeNull();
    expect(parseBaseMinutes('unknown')).toBeNull();
  });
});

const sessionData = (overrides: Record<string, unknown> = {}) => ({
  total_rounds: 7, completed_rounds: 3,
  player: { name: 'X', current_rank: '1', starting_rank: '1', rating: 0, kFactor: 20 },
  ratingChange: 0, performanceRating: 0, matches: [],
  ...overrides,
});
const resultMatch = (round: number) => ({ round_number: round, opponent_name: 'A', opponent_rank: '1', opponent_rating: 0, color: 'White', result: '1', board: '1' });
const pairingMatch = (round: number) => ({ ...resultMatch(round), result: '' });

describe('sessionCadence', () => {
  it('polls every minute while awaiting a pairing (incl. before round 1)', () => {
    expect(sessionCadence(sessionData({ time_control_type: 'rapid' }))).toBe(1);
    expect(sessionCadence(sessionData({ time_control_type: 'rapid', matches: [resultMatch(1)] }))).toBe(1);
    expect(sessionCadence(sessionData({}))).toBe(1);
  });

  it('relaxes to base time control minutes while a round is in progress', () => {
    const inRound = sessionData({
      time_control_type: 'rapid',
      time_control: '15 MINUTES +5 SECONDS BONUS FROM MOVE NUMBER 1',
      matches: [resultMatch(1), pairingMatch(2)],
    });
    expect(sessionCadence(inRound)).toBe(15);
  });

  it('clamps in-round cadence to 5–15 minutes', () => {
    expect(sessionCadence(sessionData({ time_control: '3+2', matches: [pairingMatch(1)] }))).toBe(5);
    expect(sessionCadence(sessionData({ time_control: '90 min + 30 sec', matches: [pairingMatch(1)] }))).toBe(15);
  });

  it('falls back by category when the time control is unparseable', () => {
    expect(sessionCadence(sessionData({ time_control_type: 'blitz', matches: [pairingMatch(1)] }))).toBe(5);
    expect(sessionCadence(sessionData({ time_control_type: 'rapid', matches: [pairingMatch(1)] }))).toBe(15);
    expect(sessionCadence(sessionData({ matches: [pairingMatch(1)] }))).toBe(5);
  });

  it('eases the pairing watch to 5 min for classical events', () => {
    expect(sessionCadence(sessionData({ time_control_type: 'standard' }))).toBe(5);
  });
});

describe('pollCadence', () => {
  it('lets the fastest session win', () => {
    const awaiting = sessionData({ time_control_type: 'rapid' });
    const inRound = sessionData({ time_control: '15+5', matches: [pairingMatch(1)] });
    expect(pollCadence([inRound, awaiting], false)).toBe(1);
    expect(pollCadence([inRound], false)).toBe(15);
  });

  it('polls every 5th minute when idle or during quiet hours', () => {
    expect(pollCadence([], false)).toBe(5);
    expect(pollCadence([sessionData({})], true)).toBe(5);
  });
});

describe('shouldRunCron', () => {
  it('runs on minutes divisible by the cadence', () => {
    expect(shouldRunCron(1, 7)).toBe(true);
    expect(shouldRunCron(5, 55)).toBe(true);
    expect(shouldRunCron(5, 7)).toBe(false);
    expect(shouldRunCron(10, 40)).toBe(true);
    expect(shouldRunCron(10, 41)).toBe(false);
  });
});

describe('isRateLimitedHtml', () => {
  it('detects the chess-results daily-limit page', () => {
    expect(isRateLimitedHtml('<html>You have exceeded the daily limit of downloads</html>')).toBe(true);
  });

  it('does not flag normal tournament pages', () => {
    expect(isRateLimitedHtml('<html><h2>Some Open 2026</h2>daily pairings</html>')).toBe(false);
    expect(isRateLimitedHtml('')).toBe(false);
  });
});
