import { describe, it, expect } from "vitest";
import { parseChessUrl } from "./db";

describe("parseChessUrl", () => {
  it("parses a standard chess-results.com URL", () => {
    const result = parseChessUrl("https://chess-results.com/tnr123456.aspx?lan=1&art=9&fed=IND&snr=42");
    expect(result).toEqual({ server: "", tournament_id: "tnr123456", player_snr: "42", federation: "IND" });
  });

  it("parses a URL with subdomain", () => {
    const result = parseChessUrl("https://chess.chess-results.com/tnr999.aspx?snr=7&fed=USA");
    expect(result).toEqual({ server: "chess", tournament_id: "tnr999", player_snr: "7", federation: "USA" });
  });

  it("defaults federation to IND when fed param missing", () => {
    const result = parseChessUrl("https://chess-results.com/tnr1.aspx?snr=1");
    expect(result?.federation).toBe("IND");
  });

  it("returns null when snr is missing", () => {
    expect(parseChessUrl("https://chess-results.com/tnr1.aspx?lan=1")).toBeNull();
  });

  it("returns null for non-chess-results.com domain", () => {
    expect(parseChessUrl("https://example.com/tnr1.aspx?snr=1")).toBeNull();
  });

  it("returns null when tournament path is missing", () => {
    expect(parseChessUrl("https://chess-results.com/?snr=1")).toBeNull();
  });

  it("handles URL without protocol prefix", () => {
    const result = parseChessUrl("chess-results.com/tnr5.aspx?snr=3");
    expect(result).not.toBeNull();
    expect(result?.tournament_id).toBe("tnr5");
  });
});
