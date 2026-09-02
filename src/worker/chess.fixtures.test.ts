import { describe, it, expect } from 'vitest';
import { parsePlayerHtml, parseTournamentHtml, calculatePoints } from './chess';
import playerHtml from './__fixtures__/player.html?raw';
import standingsHtml from './__fixtures__/standings.html?raw';
import detailsHtml from './__fixtures__/details.html?raw';

// Real pages captured from chess-results.com (tnr1468113, 2026-08-02) so a
// markup change on their side shows up as a parser regression here.

describe('parsePlayerHtml (real fixture)', () => {
  const data = parsePlayerHtml(playerHtml)!;

  it('parses tournament and round info', () => {
    expect(data).not.toBeNull();
    expect(data.tournament_name).toContain('OUTPACE CHESS');
    expect(data.total_rounds).toBe(7);
    expect(data.completed_rounds).toBe(5);
  });

  it('parses the player card', () => {
    expect(data.player.name).toBe('Avyaan, Ajith');
    expect(data.player.current_rank).toBe('18');
    expect(data.player.starting_rank).toBe('1');
    expect(data.player.rating).toBe(1542);
    expect(data.performanceRating).toBe(1472);
  });

  it('parses all matches including the upcoming pairing', () => {
    expect(data.matches).toHaveLength(6);
    expect(data.matches[0]).toEqual({
      round_number: 1,
      opponent_name: 'Mohammed, Zain Rotiwale',
      opponent_rank: '37',
      opponent_rating: 0,
      color: 'Black',
      result: '1',
      board: '1',
    });
    // Round 6 is a pairing without a result yet
    expect(data.matches[5].round_number).toBe(6);
    expect(data.matches[5].result).toBe('');
    expect(data.matches[5].board).toBe('9');
    expect(calculatePoints(data.matches)).toBe(3);
  });
});

describe('parseTournamentHtml (real fixture)', () => {
  const info = parseTournamentHtml(standingsHtml, detailsHtml)!;

  it('parses tournament details', () => {
    expect(info).not.toBeNull();
    expect(info.name).toContain('OUTPACE CHESS');
    expect(info.organizer).toBe('OUTPACE ACADEMY');
    expect(info.tournamentType).toBe('Swiss-System');
    expect(info.timeControl).toContain('15 MINUTES');
    expect(info.timeControlType).toBe('rapid');
    expect(info.totalRounds).toBe(7);
    expect(info.currentRound).toBe(5);
    expect(info.playerCount).toBe(73);
    expect(info.avgRating).toBe(1050);
  });

  it('parses the standings table', () => {
    expect(info.standings.length).toBe(73);
    const second = info.standings[1];
    expect(second.rank).toBe(2);
    expect(second.snr).toBe('8');
    expect(second.name).toBe('S., Hariharan Murukappan');
    expect(second.rating).toBe(1410);
    expect(second.points).toBe(5);
  });

  it('parses points for unrated players (rating cell is "0")', () => {
    const leader = info.standings[0];
    expect(leader.rank).toBe(1);
    expect(leader.name).toBe('Bhevin, Saarang');
    expect(leader.rating).toBe(0);
    expect(leader.points).toBe(5);
    expect(leader.tiebreaks).toEqual([14, 16, 16]);
  });
});
