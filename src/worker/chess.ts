import { and, eq, sql } from "drizzle-orm";
import type { AppDB } from "./drizzle";
import { chessSessions, notifications, settings, workerLogs } from "./schema";

// ── HTML entity decoder ──────────────────────────────────────────────────────

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&frac12;/g, '½')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface MatchData {
  round_number: number;
  opponent_name: string;
  opponent_rank: string;
  opponent_rating: number;
  color: string;
  result: string;
  board: string;
}

export interface SessionData {
  tournament_name?: string;
  time_control?: string;
  time_control_type?: string;
  total_rounds: number;
  completed_rounds: number;
  player: {
    name: string;
    current_rank: string;
    starting_rank: string;
    rating: number;
    kFactor: number;
  };
  ratingChange: number;
  performanceRating: number;
  matches: MatchData[];
}

export interface TournamentStanding {
  rank: number;
  name: string;
  rating: number;
  points: number;
  federation: string;
  title: string;
  ratingChange: number;
  tiebreaks: number[];
}

export interface TournamentInfo {
  name: string;
  organizer: string;
  federation: string;
  location: string;
  dates: string;
  timeControl: string;
  timeControlType: 'blitz' | 'rapid' | 'standard' | null;
  tournamentType: string;
  totalRounds: number;
  currentRound: number;
  playerCount: number;
  avgRating: number;
  lastUpdate: string;
  standings: TournamentStanding[];
}

export interface ChessSession {
  id: number;
  url: string;
  server: string;
  tournament_id: string;
  player_snr: string;
  federation: string;
  status: string;
  notify: number;
  fail_count: number;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  type: 'pairing' | 'result' | 'completion';
  session: ChessSession;
  oldData: SessionData;
  newData: SessionData;
  match?: MatchData;
}

// ── Parser ───────────────────────────────────────────────────────────────────

const EMPTY_SESSION_DATA: SessionData = {
  total_rounds: 0, completed_rounds: 0,
  player: { name: 'Unknown', current_rank: '?', starting_rank: '?', rating: 0, kFactor: 20 },
  ratingChange: 0, performanceRating: 0, matches: [],
};

export function parseSessionData(session: ChessSession): SessionData {
  try {
    const d = JSON.parse(session.data || '{}');
    return {
      tournament_name: d.tournament_name,
      time_control: d.time_control,
      time_control_type: d.time_control_type,
      total_rounds: d.total_rounds || 0,
      completed_rounds: d.completed_rounds || 0,
      player: d.player || EMPTY_SESSION_DATA.player,
      ratingChange: d.ratingChange || 0,
      performanceRating: d.performanceRating || 0,
      matches: d.matches || [],
    };
  } catch {
    return { ...EMPTY_SESSION_DATA };
  }
}

function getBaseUrl(server: string): string {
  return server ? `https://${server}.chess-results.com` : 'https://chess-results.com';
}

function buildPlayerUrl(server: string, tournamentId: string, playerSnr: string, federation: string): string {
  return `${getBaseUrl(server)}/${tournamentId}.aspx?lan=1&art=9&fed=${federation}&snr=${playerSnr}`;
}

function buildTournamentUrl(server: string, tournamentId: string): string {
  return `${getBaseUrl(server)}/${tournamentId}.aspx?lan=1&art=1`;
}

function buildTournamentDetailsUrl(server: string, tournamentId: string): string {
  return `${getBaseUrl(server)}/${tournamentId}.aspx?lan=1&turdet=YES`;
}

function isMatchCompleted(result: string): boolean {
  if (!result || result.trim() === '') return false;
  const r = result.trim();
  return ['1', '0', '½', '0.5', '1/2'].some(v => r.includes(v));
}

function normalizeResult(result: string): string {
  const r = result.trim();
  if (r.includes('½') || r === '0.5' || r === '1/2') return '0.5';
  if (r === '1') return '1';
  if (r === '0') return '0';
  return r;
}

export function calculatePoints(matches: MatchData[]): number {
  return matches.reduce((total, match) => {
    if (!isMatchCompleted(match.result)) return total;
    return total + parseFloat(normalizeResult(match.result) || '0');
  }, 0);
}

function calculateExpectedScore(playerRating: number, opponentRating: number): number {
  const diff = Math.max(-400, Math.min(400, opponentRating - playerRating));
  return 1 / (1 + Math.pow(10, diff / 400));
}

export function calculateTotalRatingChange(
  playerRating: number,
  matches: MatchData[],
  kFactor = 20,
): { total: number; perGame: Array<{ round: number; change: number; expected: number }> } {
  const perGame: Array<{ round: number; change: number; expected: number }> = [];
  let total = 0;
  for (const match of matches) {
    if (!isMatchCompleted(match.result)) continue;
    const oppRating = match.opponent_rating || playerRating;
    const expected = calculateExpectedScore(playerRating, oppRating);
    const actual = normalizeResult(match.result);
    const score = actual === '1' ? 1 : actual === '0' ? 0 : 0.5;
    const change = kFactor * (score - expected);
    perGame.push({ round: match.round_number, change: Math.round(change * 100) / 100, expected: Math.round(expected * 100) / 100 });
    total += change;
  }
  return { total: Math.round(total * 100) / 100, perGame };
}

function parseStandingsTable(html: string): TournamentStanding[] {
  const standings: TournamentStanding[] = [];
  const rowRegex = /<tr[^>]*class="CRn?g[12](?:\s+[^"]*)?(?<!"b)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (rowHtml.includes('<th')) continue;
    const cells = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (cells.length < 8) continue;
    const cellTexts = cells.map(cell => cell.replace(/<[^>]+>/g, '').trim());
    const rank = parseInt(cellTexts[0]) || 0;
    if (rank === 0) continue;
    const nameMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
    const playerName = decodeHtmlEntities(nameMatch?.[1]?.trim() || cellTexts[4] || 'Unknown');
    let rating = 0, points = 0, ratingChange = 0, title = '';
    if (/^(GM|IM|FM|CM|WGM|WIM|WFM|WCM|AFM|ACM)$/i.test(cellTexts[3])) title = cellTexts[3].toUpperCase();
    let ratingIdx = -1;
    for (let i = 5; i < cellTexts.length; i++) {
      // Rating cell is either a real rating (3-4 digits) or exactly "0" for
      // unrated players — small numbers like points/tiebreaks must not match,
      // and the unrated "0" must still anchor the points search that follows.
      if (/^\d{1,4}$/.test(cellTexts[i])) {
        const val = parseInt(cellTexts[i]);
        if (val === 0 || val >= 100) { rating = val; ratingIdx = i; break; }
      }
    }
    let pointsIdx = -1;
    if (ratingIdx >= 0) {
      for (let i = ratingIdx + 1; i < Math.min(ratingIdx + 4, cellTexts.length); i++) {
        const ptsText = cellTexts[i];
        if (/^[0-9]+[,\.]?[05]?$/.test(ptsText)) {
          const val = parseFloat(ptsText.replace(',', '.'));
          if (val <= 20) { points = val; pointsIdx = i; break; }
        }
      }
    }
    const tiebreaks: number[] = [];
    const numericAfterPoints: { idx: number; val: number; text: string }[] = [];
    if (pointsIdx >= 0) {
      for (let i = pointsIdx + 1; i < cellTexts.length; i++) {
        const text = cellTexts[i];
        if (/^-?\d+[,\.]?\d*$/.test(text)) {
          const val = parseFloat(text.replace(',', '.'));
          if (!(Number.isInteger(val) && val > 100 && val < 3000)) numericAfterPoints.push({ idx: i, val, text });
        }
      }
    }
    if (numericAfterPoints.length > 0) {
      const last = numericAfterPoints[numericAfterPoints.length - 1];
      const hasDecimal = last.text.includes('.') || last.text.includes(',');
      const isLikelyRatingChange = last.val < 0 || (hasDecimal && Math.abs(last.val) < 20);
      if (isLikelyRatingChange) {
        ratingChange = last.val;
        for (let i = 0; i < numericAfterPoints.length - 1; i++) tiebreaks.push(numericAfterPoints[i].val);
      } else {
        for (const item of numericAfterPoints) tiebreaks.push(item.val);
      }
    }
    const fedMatch = rowHtml.match(/class="tn_([A-Z]{3})"/i);
    standings.push({ rank, name: playerName, rating, points, federation: fedMatch?.[1] || '', title, ratingChange, tiebreaks });
  }
  return standings;
}

const FETCH_TIMEOUT_MS = 10_000;

// Thrown when chess-results.com serves its daily-limit page. Propagates up to
// checkForUpdates, which aborts the cycle and sets a polling backoff — it must
// never be counted as a per-session fetch failure.
export class RateLimitError extends Error {}

export function isRateLimitedHtml(html: string): boolean {
  return html.includes('exceeded') && html.includes('daily limit');
}

export async function fetchTournamentData(server: string, tournamentId: string): Promise<TournamentInfo | null> {
  try {
    const [detailsRes, standingsRes] = await Promise.all([
      fetch(buildTournamentDetailsUrl(server, tournamentId), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      fetch(buildTournamentUrl(server, tournamentId), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    ]);
    const detailsHtml = await detailsRes.text();
    const standingsHtml = await standingsRes.text();
    if (isRateLimitedHtml(standingsHtml) || isRateLimitedHtml(detailsHtml)) throw new RateLimitError('tournament fetch');
    return parseTournamentHtml(standingsHtml, detailsHtml);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error('Error fetching tournament data:', err);
    return null;
  }
}

export function parseTournamentHtml(standingsHtml: string, detailsHtml?: string): TournamentInfo | null {
  try {
    const infoHtml = detailsHtml || standingsHtml;
    const nameMatch = infoHtml.match(/<h2>([^<]+)<\/h2>/i);
    const name = nameMatch?.[1]?.trim() || 'Tournament';
    const extractField = (label: string, source = infoHtml): string => {
      const regex = new RegExp(`>${label}</td>\\s*<td[^>]*>(.+?)</td>`, 'is');
      const m = source.match(regex);
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    };
    const organizer = extractField('Organizer\\(s\\)');
    const federation = extractField('Federation');
    const tcBlitz = extractField('Time control \\(Blitz\\)');
    const tcRapid = extractField('Time control \\(Rapid\\)');
    const tcStandard = extractField('Time control \\(Standard\\)');
    const timeControl = tcBlitz || tcRapid || tcStandard || extractField('Time control');
    const timeControlType: TournamentInfo['timeControlType'] = tcBlitz ? 'blitz' : tcRapid ? 'rapid' : tcStandard ? 'standard' : null;
    const location = extractField('Location');
    const totalRoundsStr = extractField('Number of rounds');
    const tournamentType = extractField('Tournament type');
    const dates = extractField('Date');
    const avgMatch = infoHtml.match(/>Rating-Ø \/ Average age<\/td>\s*<td[^>]*>(\d+)\s*\/\s*(\d+)<\/td>/i);
    const avgRating = parseInt(avgMatch?.[1] || '0');
    const updateMatch = infoHtml.match(/Last update ([^,<]+)/i);
    const lastUpdate = updateMatch?.[1]?.trim() || '';
    const roundMatch = standingsHtml.match(/Rank after Round (\d+)/i);
    const currentRound = parseInt(roundMatch?.[1] || '0');
    const standings = parseStandingsTable(standingsHtml);
    let totalRounds = parseInt(totalRoundsStr) || 0;
    if (totalRounds === 0) {
      const roundLinks = standingsHtml.match(/rd=(\d+)/gi) || [];
      const roundNumbers = roundLinks.map(r => parseInt(r.replace(/rd=/i, '')));
      totalRounds = roundNumbers.length > 0 ? Math.max(...roundNumbers) : 0;
    }
    if (totalRounds === 0 && currentRound > 0) totalRounds = currentRound;
    return { name, organizer, federation, location, dates, timeControl, timeControlType, tournamentType, totalRounds, currentRound, playerCount: standings.length, avgRating, lastUpdate, standings };
  } catch (err) {
    console.error('Error parsing tournament HTML:', err);
    return null;
  }
}

function parseMatchesTable(html: string): MatchData[] {
  const matches: MatchData[] = [];
  const rowRegex = /<tr[^>]*class="CRn?g[12](?:\s+[^"]*)?(?<!"b)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (rowHtml.includes('<th')) continue;
    const cells = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (cells.length < 5) continue;
    const cellTexts = cells.map(cell => cell.replace(/<[^>]+>/g, '').trim());
    const roundNum = parseInt(cellTexts[0]) || 0;
    if (roundNum === 0) continue;
    const nameMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
    let opponentName = decodeHtmlEntities(nameMatch?.[1]?.trim() || cellTexts[3] || cellTexts[4] || 'Unknown');
    if (opponentName.toLowerCase() === 'bye' || opponentName.toLowerCase() === 'not paired') {
      opponentName = opponentName.charAt(0).toUpperCase() + opponentName.slice(1).toLowerCase();
    }
    let result = '';
    const nestedResult = rowHtml.match(/<div class="Farbe[ws]T"><\/div><\/td><td[^>]*>([^<]*)<\/td>/i);
    if (nestedResult) result = nestedResult[1].trim();
    if (!result) {
      const lastCell = cellTexts[cellTexts.length - 1] || '';
      const directResult = lastCell.match(/([+-])\s*([01½])/);
      if (directResult) result = directResult[2];
    }
    if (!result) {
      const searchStart = Math.max(0, cellTexts.length - 2);
      for (let i = cellTexts.length - 1; i >= searchStart; i--) {
        if (/^[01½]$/.test(cellTexts[i])) { result = cellTexts[i]; break; }
      }
    }
    result = result.replace('&frac12;', '½');
    let color = '';
    if (rowHtml.includes('FarbewT')) color = 'White';
    else if (rowHtml.includes('FarbesT')) color = 'Black';
    let opponentRating = 0;
    for (let i = 4; i < Math.min(7, cellTexts.length); i++) {
      if (/^\d{3,4}$/.test(cellTexts[i])) { opponentRating = parseInt(cellTexts[i]); break; }
    }
    matches.push({ round_number: roundNum, opponent_name: opponentName, opponent_rank: cellTexts[2] || '', opponent_rating: opponentRating, color, result, board: cellTexts[1] || '' });
  }
  return matches;
}

export async function fetchPlayerData(server: string, tournamentId: string, playerSnr: string, federation: string, overrideUrl?: string): Promise<SessionData | null> {
  try {
    // Use the original URL if provided (preserves extra params like SNode for multi-section tournaments)
    const url = overrideUrl || buildPlayerUrl(server, tournamentId, playerSnr, federation);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const html = await res.text();
    if (isRateLimitedHtml(html)) throw new RateLimitError('player fetch');
    return parsePlayerHtml(html);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error('Error fetching player data:', err);
    return null;
  }
}

export function parsePlayerHtml(html: string): SessionData | null {
  try {
    const nameMatch = html.match(/>Name<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
    const playerName = decodeHtmlEntities(nameMatch?.[1]?.trim() || 'Unknown');
    const tournamentMatch = html.match(/<h2>([^<]+)<\/h2>/i);
    let tournamentName = decodeHtmlEntities(tournamentMatch?.[1]?.trim() ?? '');
    if (tournamentName?.includes('Contact:')) tournamentName = tournamentName.split('Contact:')[0].trim();
    let totalRounds = 0;
    const numRoundsMatch = html.match(/>Number of rounds<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    if (numRoundsMatch) totalRounds = parseInt(numRoundsMatch[1]);
    if (totalRounds === 0) {
      const rdPattern = html.match(/Rd\.?\s*(\d+)\s*\/\s*(\d+)/i);
      if (rdPattern) totalRounds = parseInt(rdPattern[2]);
    }
    if (totalRounds === 0) {
      const roundLinks = html.match(/rd=(\d+)/gi) || [];
      const roundNumbers = roundLinks.map(r => parseInt(r.replace(/rd=/i, '')));
      totalRounds = roundNumbers.length > 0 ? Math.max(...roundNumbers) : 0;
    }
    const matches = parseMatchesTable(html);
    if (totalRounds === 0 && matches.length > 0) totalRounds = matches.length;
    const rankMatch = html.match(/>Rank<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    const currentRank = rankMatch?.[1] || '?';
    const startRankMatch = html.match(/>Starting rank<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    const startingRank = startRankMatch?.[1] || currentRank;
    const ratingIntMatch = html.match(/>Rating international<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    const ratingNatMatch = html.match(/>Rating national<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    const playerRating = parseInt(ratingIntMatch?.[1] || ratingNatMatch?.[1] || '0');
    const kFactorMatch = html.match(/<td class="CRr">(\d+)<\/td>\s*<td class="CRr">[+-]?\d/i);
    const kFactor = parseInt(kFactorMatch?.[1] || '20');
    const ratingChangeMatch = html.match(/>FIDE rtg \+\/-<\/td>\s*<td[^>]*>([+-]?\d+[,.]?\d*)<\/td>/i);
    const ratingChange = parseFloat((ratingChangeMatch?.[1] || '0').replace(',', '.'));
    const perfRatingMatch = html.match(/>Performance rating<\/td>\s*<td[^>]*>(\d+)<\/td>/i);
    const performanceRating = parseInt(perfRatingMatch?.[1] || '0');
    const completedRounds = matches.filter(m => isMatchCompleted(m.result)).length;
    const timeControlMatch = html.match(/>Time control[^<]*<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
    const time_control = timeControlMatch ? decodeHtmlEntities(timeControlMatch[1].trim()) : undefined;
    return { tournament_name: tournamentName, time_control, total_rounds: totalRounds, completed_rounds: completedRounds, player: { name: playerName, current_rank: currentRank, starting_rank: startingRank, rating: playerRating, kFactor }, ratingChange, performanceRating, matches };
  } catch (err) {
    console.error('Error parsing player HTML:', err);
    return null;
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

const REQUEST_DELAY_MS = 2000;

function groupByTournament(sessions: ChessSession[]): Map<string, ChessSession[]> {
  const groups = new Map<string, ChessSession[]>();
  for (const session of sessions) {
    const key = `${session.server}:${session.tournament_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(session);
  }
  return groups;
}

function findPlayerInStandings(standings: TournamentStanding[], playerName: string): TournamentStanding | undefined {
  const normalize = (name: string) => name.toLowerCase().replace(/,/g, '').trim();
  const target = normalize(playerName);
  return standings.find(s => {
    const n = normalize(s.name);
    return n === target || n.split(' ').reverse().join(' ') === target || target.split(' ').reverse().join(' ') === n;
  });
}

function hasStandingsChanged(oldData: SessionData, standing: TournamentStanding): boolean {
  const oldPoints = calculatePoints(oldData.matches);
  const oldRank = parseInt(oldData.player.current_rank) || 0;
  return standing.rank !== oldRank || standing.points !== oldPoints;
}

async function saveNotification(
  db: AppDB,
  sessionId: number,
  type: string,
  title: string,
  message: string,
  sent: boolean,
  roundNumber: number,
): Promise<number> {
  try {
    const notifType = type as "pairing" | "result" | "completion";
    const result = await db
      .insert(notifications)
      .values({ sessionId, type: notifType, title, message, sent: sent ? 1 : 0, roundNumber })
      .returning({ id: notifications.id });
    return result[0]?.id ?? 0;
  } catch {
    // Likely a dedup constraint violation — skip silently
    return 0;
  }
}

async function markNotificationSent(db: AppDB, id: number): Promise<void> {
  await db.update(notifications).set({ sent: 1 }).where(eq(notifications.id, id));
}


function formatNotification(n: Notification): { title: string; message: string } {
  const { type, newData, match } = n;
  const points = calculatePoints(newData.matches);

  switch (type) {
    case 'pairing':
      if (!match) return { title: '', message: '' };
      return {
        title: `Round ${match.round_number} Pairing`,
        message: `${newData.player.name} vs ${match.opponent_name}\nPlaying: ${match.color || 'TBD'}\nBoard: ${match.board || 'TBD'}\nRank: #${newData.player.current_rank} | Points: ${points}/${newData.completed_rounds}`,
      };
    case 'result': {
      if (!match) return { title: '', message: '' };
      const r = normalizeResult(match.result);
      const resultText = r === '1' ? 'WON' : r === '0' ? 'LOST' : 'DRAW';
      const oldRank = parseInt(n.oldData.player.current_rank) || 0;
      const newRank = parseInt(newData.player.current_rank) || 0;
      let rankChange = '';
      if (oldRank > newRank) rankChange = ` (↑${oldRank - newRank})`;
      else if (newRank > oldRank) rankChange = ` (↓${newRank - oldRank})`;
      let ratingInfo = '';
      if (newData.ratingChange !== 0) ratingInfo = `\nRating: ${newData.ratingChange >= 0 ? '+' : ''}${newData.ratingChange}`;
      return {
        title: `Round ${match.round_number}: ${resultText}!`,
        message: `${newData.player.name} vs ${match.opponent_name}\nNew Rank: #${newData.player.current_rank}${rankChange}\nPoints: ${points}/${newData.completed_rounds}${ratingInfo}`,
      };
    }
    case 'completion': {
      let ratingInfo = '';
      if (newData.ratingChange !== 0) {
        ratingInfo = `\nRating: ${newData.ratingChange >= 0 ? '+' : ''}${newData.ratingChange}`;
        if (newData.performanceRating > 0) ratingInfo += ` (Perf: ${newData.performanceRating})`;
      }
      return {
        title: 'Tournament Complete!',
        message: `${newData.player.name}\n${newData.tournament_name || 'Tournament'}\nFinal Rank: #${newData.player.current_rank}\nFinal Score: ${points}/${newData.total_rounds}${ratingInfo}`,
      };
    }
    default:
      return { title: '', message: '' };
  }
}

const MAX_CONSECUTIVE_FAILURES = 3;

async function recordFetchFailure(
  db: AppDB,
  session: ChessSession,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
): Promise<void> {
  const failCount = (session.fail_count ?? 0) + 1;
  if (failCount >= MAX_CONSECUTIVE_FAILURES) {
    await db.update(chessSessions)
      .set({ status: "error", failCount, updatedAt: sql`(datetime('now'))` })
      .where(eq(chessSessions.id, session.id));
    await writeLog(`Session ${session.id} marked as error after ${failCount} consecutive fetch failures`, 'error', 'cron');
  } else {
    await db.update(chessSessions)
      .set({ failCount })
      .where(eq(chessSessions.id, session.id));
    await writeLog(`Fetch failed for session ${session.id} (${failCount}/${MAX_CONSECUTIVE_FAILURES})`, 'warn', 'cron');
  }
}

async function checkPlayerUpdate(
  db: AppDB,
  session: ChessSession,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
  tournament?: TournamentInfo | null,
): Promise<Notification[]> {
  const notifications: Notification[] = [];
  // A literal '{}' snapshot means the add-time fetch failed: adopt the first
  // successful fetch as the baseline without notifying, or a mid-tournament
  // add would burst notifications for every past round. (A successful
  // pre-tournament fetch stores player info, not '{}', so real round-1
  // pairings still notify.)
  const isBaselineAdoption = (session.data || "{}").trim() === "{}";
  try {
    const oldData = parseSessionData(session);
    // Pass original URL to preserve params like SNode (multi-section tournaments)
    const newData = await fetchPlayerData(session.server, session.tournament_id, session.player_snr, session.federation, session.url);
    if (newData) {
      // Category and time control come from the tournament details page
      // (player pages often lack them); they drive the adaptive poll cadence.
      newData.time_control_type = tournament?.timeControlType ?? oldData.time_control_type;
      if (!newData.time_control) newData.time_control = tournament?.timeControl || oldData.time_control;
    }
    if (!newData) {
      console.warn(`[chess] Could not fetch player data for session ${session.id}`);
      await recordFetchFailure(db, session, writeLog);
      return notifications;
    }
    // Check for results on existing matches and new matches
    const oldByRound = new Map(oldData.matches.map(m => [m.round_number, m]));

    for (const newMatch of newData.matches) {
      const oldMatch = oldByRound.get(newMatch.round_number);
      if (!oldMatch) {
        // New match (round not seen before)
        notifications.push({
          type: isMatchCompleted(newMatch.result) ? 'result' : 'pairing',
          session, oldData, newData, match: newMatch,
        });
      } else if (!isMatchCompleted(oldMatch.result) && isMatchCompleted(newMatch.result)) {
        // Existing match that now has a result
        notifications.push({ type: 'result', session, oldData, newData, match: newMatch });
      }
    }
    // Auto-stop completed tournaments
    if (newData.total_rounds > 0 && newData.completed_rounds >= newData.total_rounds && oldData.completed_rounds < newData.total_rounds) {
      notifications.push({ type: 'completion', session, oldData, newData });
      await db.update(chessSessions)
        .set({ status: "completed", updatedAt: sql`(datetime('now'))` })
        .where(eq(chessSessions.id, session.id));
    }
    // Persist updated data; a successful fetch resets the failure streak
    await db.update(chessSessions)
      .set({ data: JSON.stringify(newData), failCount: 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(chessSessions.id, session.id));
    if (isBaselineAdoption && notifications.length > 0) {
      await writeLog(`Adopted baseline snapshot for session ${session.id} silently (${notifications.length} past event(s) not notified)`, 'info', 'cron');
      notifications.length = 0;
    }
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error(`[chess] Error checking session ${session.id}:`, err);
    await recordFetchFailure(db, session, writeLog);
  }
  return notifications;
}

// Extracts the base thinking time in minutes from a time-control string like
// "15 MINUTES +5 SECONDS BONUS FROM MOVE 1", "15+5", or "90 min + 30 sec".
export function parseBaseMinutes(timeControl?: string): number | null {
  if (!timeControl) return null;
  const m = timeControl.match(/(\d+)\s*(?:min|minutes|')/i) || timeControl.match(/^\s*(\d+)\s*\+/);
  return m ? parseInt(m[1], 10) : null;
}

// Cron fires every minute; the handler self-paces per session phase:
// - awaiting a pairing (before round 1, or last result is in and the next
//   round isn't paired yet): every minute — the only window where speed
//   matters, since the board number must arrive before the round starts.
//   Classical events pair long before rounds, so standard eases to 5.
// - round in progress (pairing known, result pending): nothing can happen for
//   roughly the base time control, so poll every base-minutes (clamped 5–15).
// The fastest session wins for the whole cycle. Idle or quiet hours → every
// 5th minute. Any real-world UTC offset is a multiple of 15 minutes, so
// minute-divisibility is timezone-independent.
export function sessionCadence(d: SessionData): number {
  const type = d.time_control_type;
  const inRound = d.matches.length > 0 && d.matches.some(m => !isMatchCompleted(m.result));
  if (inRound) {
    const base = parseBaseMinutes(d.time_control);
    if (base != null) return Math.min(15, Math.max(5, base));
    return type === 'blitz' || type == null ? 5 : 15;
  }
  return type === 'standard' ? 5 : 1;
}

export function pollCadence(sessions: SessionData[], isNight: boolean): number {
  if (sessions.length === 0 || isNight) return 5;
  return Math.min(...sessions.map(sessionCadence));
}

export function shouldRunCron(cadenceMinutes: number, minute: number): boolean {
  return minute % cadenceMinutes === 0;
}

export interface PollResult {
  sessions: number;
  notifications: number;
  errors: number;
  skipped?: boolean;
  rateLimited?: boolean;
}

const CYCLE_GUARD_MS = 50_000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;

async function setSetting(db: AppDB, key: string, value: string): Promise<void> {
  await db.insert(settings).values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function checkForUpdates(
  db: AppDB,
  sendNotification: (title: string, message: string, url: string, type: string) => Promise<boolean>,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
  opts: { deliver?: boolean } = {},
): Promise<PollResult> {
  // Rate-limit backoff: after chess-results.com's daily-limit page, skip
  // silently until the backoff expires (the warn log + alert fired once when
  // it was set).
  const backoff = await db.select().from(settings).where(eq(settings.key, 'rate_limited_until')).limit(1);
  if (backoff[0] && Date.parse(backoff[0].value) > Date.now()) {
    return { sessions: 0, notifications: 0, errors: 0, skipped: true };
  }

  // Overlap guard: a cycle that started <50s ago may still be running — skip
  // rather than risk double-sending the retry pass. The guard is cleared in
  // finally; if a cycle crashes hard the stale guard expires on its own.
  const guard = await db.select().from(settings).where(eq(settings.key, 'cycle_started_at')).limit(1);
  if (guard[0] && Date.now() - Date.parse(guard[0].value) < CYCLE_GUARD_MS) {
    await writeLog('Cycle skipped — previous poll still running', 'info', 'cron');
    return { sessions: 0, notifications: 0, errors: 0, skipped: true };
  }
  await setSetting(db, 'cycle_started_at', new Date().toISOString());

  try {
    return await runCycle(db, sendNotification, writeLog, opts.deliver ?? true);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const until = new Date(Date.now() + RATE_LIMIT_BACKOFF_MS).toISOString();
      await setSetting(db, 'rate_limited_until', until);
      await writeLog(`Rate limited by chess-results.com — polling paused until ${until}`, 'warn', 'cron');
      return { sessions: 0, notifications: 0, errors: 0, rateLimited: true };
    }
    throw err;
  } finally {
    await db.delete(settings).where(eq(settings.key, 'cycle_started_at'));
  }
}

async function runCycle(
  db: AppDB,
  sendNotification: (title: string, message: string, url: string, type: string) => Promise<boolean>,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
  // During quiet hours polling continues but delivery is deferred: notifications
  // are saved unsent and the retry pass delivers them on the first cycle after.
  deliver: boolean,
): Promise<PollResult> {
  // Prune old rows so worker_logs / notifications don't grow unbounded
  await db.delete(workerLogs).where(sql`${workerLogs.createdAt} < datetime('now', '-30 days')`);
  await db.delete(notifications).where(and(
    eq(notifications.sent, 1),
    sql`${notifications.createdAt} < datetime('now', '-90 days')`,
  ));

  // Retry notifications that failed to send (within the last 24 hours)
  if (deliver) {
    const unsent = await db
      .select({ id: notifications.id, type: notifications.type, title: notifications.title, message: notifications.message, url: chessSessions.url })
      .from(notifications)
      .innerJoin(chessSessions, eq(notifications.sessionId, chessSessions.id))
      .where(and(
        eq(notifications.sent, 0),
        eq(chessSessions.notify, 1),
        sql`${notifications.createdAt} > datetime('now', '-24 hours')`,
      ));

    let retried = 0;
    for (const n of unsent) {
      const ok = await sendNotification(n.title, n.message, n.url, n.type);
      if (ok) { await markNotificationSent(db, n.id); retried++; }
    }
    if (unsent.length > 0) {
      await writeLog(`Retry: ${retried}/${unsent.length} unsent notification(s) delivered`, retried < unsent.length ? 'warn' : 'info', 'cron');
    }
  }

  const rows = await db.select().from(chessSessions).where(eq(chessSessions.status, "running"));
  // Map camelCase Drizzle results back to snake_case ChessSession interface
  const running: ChessSession[] = rows.map(r => ({
    id: r.id,
    url: r.url,
    server: r.server ?? "",
    tournament_id: r.tournamentId,
    player_snr: r.playerSnr,
    federation: r.federation ?? "IND",
    status: r.status ?? "running",
    notify: r.notify ?? 1,
    fail_count: r.failCount ?? 0,
    data: r.data ?? "{}",
    created_at: r.createdAt ?? "",
    updated_at: r.updatedAt ?? "",
  }));

  if (running.length === 0) {
    return { sessions: 0, notifications: 0, errors: 0 };
  }

  const groups = groupByTournament(running);
  let notifCount = 0;
  let errorCount = 0;
  let isFirst = true;

  for (const [tournamentKey, sessions] of groups) {
    const [server, tournamentId] = tournamentKey.split(':');
    if (!isFirst) await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    isFirst = false;

    try {
      const tournamentData = await fetchTournamentData(server, tournamentId);

      for (const session of sessions) {
        const oldData = parseSessionData(session);

        // Auto-stop sessions already complete based on stored data (e.g. added after last round)
        if (oldData.total_rounds > 0 && oldData.completed_rounds >= oldData.total_rounds) {
          await db.update(chessSessions)
            .set({ status: "completed", updatedAt: sql`(datetime('now'))` })
            .where(eq(chessSessions.id, session.id));
          await writeLog(`Auto-stopped completed session: ${oldData.player.name} (${oldData.completed_rounds}/${oldData.total_rounds})`, 'info', 'cron');
          continue;
        }

        let needsFetch = true;

        if (tournamentData) {
          const standing = findPlayerInStandings(tournamentData.standings, oldData.player.name);
          // >= (not >): when all known rounds have results, the next pairing
          // can appear without any standings change — keep watching the
          // player page until it does.
          const hasNewRound = tournamentData.currentRound >= oldData.matches.length;
          needsFetch = !standing || hasStandingsChanged(oldData, standing) || hasNewRound;
          if (!needsFetch) {
            await writeLog(`No change for ${oldData.player.name} in ${oldData.tournament_name || tournamentId}`, 'info', 'cron');
          }
        }

        if (needsFetch) {
          await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
          const notifications = await checkPlayerUpdate(db, session, writeLog, tournamentData);

          for (const notification of notifications) {
            const { title, message } = formatNotification(notification);
            if (!message) continue;

            const roundNumber = notification.match?.round_number ?? -1;
            const notifId = await saveNotification(db, notification.session.id, notification.type, title, message, false, roundNumber);
            if (notifId === 0) continue;

            notifCount++;
            await writeLog(`${notification.type} notification: ${title}`, 'info', 'cron');

            if (deliver && notification.session.notify === 1) {
              const sent = await sendNotification(title, message, notification.session.url, notification.type);
              if (sent) await markNotificationSent(db, notifId);
            } else if (!deliver) {
              await writeLog(`Deferred (quiet hours): ${title}`, 'info', 'cron');
            }
          }

          if (notifications.length === 0) {
            await writeLog(`Checked ${oldData.player.name} — no updates`, 'info', 'cron');
          }
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      await writeLog(`Error processing tournament ${tournamentKey}: ${err}`, 'error', 'cron');
      errorCount++;
    }
  }

  return { sessions: running.length, notifications: notifCount, errors: errorCount };
}
