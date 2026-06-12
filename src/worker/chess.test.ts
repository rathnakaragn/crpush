import { describe, it, expect } from 'vitest';
import { calculatePoints, calculateTotalRatingChange, parseSessionData } from './chess';
import type { ChessSession } from './chess';

const makeSession = (overrides: Partial<ChessSession> = {}): ChessSession => ({
  id: 1, url: '', server: '', tournament_id: '', player_snr: '',
  federation: 'IND', status: 'running', notify: 1,
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
