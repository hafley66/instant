// fzf-style fuzzy matching, client-side. fuzzyScore does a case-insensitive
// subsequence match (every query char must appear in order) and rewards tight,
// word-aligned matches. fuzzyFilter ranks a row list by the score of a derived
// key string. Good enough for a few thousand rows; revisit SQLite FTS past that.

// Word-start chars: a match right after one of these (or a camelHump) scores a
// bonus, so "ac" hits "activity" and "app/config" strongly.
function isBoundary(prev: string, cur: string): boolean {
  if (prev === "" ) return true;
  if (/[\s/_\-.:]/.test(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase(); // camelHump
}

// Returns a score (higher = better) or null if `query` is not a subsequence of
// `text`. Bonuses: consecutive run, word-start, prefix. Penalties: leading gap,
// total gaps.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  if (q.length > t.length) return null;

  let score = 0;
  let ti = 0;
  let prevMatch = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const found = t.indexOf(c, ti);
    if (found === -1) return null;

    const gap = prevMatch === -1 ? found : found - prevMatch - 1;
    if (qi === 0) score -= found * 2; // prefer matches near the start
    else score -= gap; // total gap penalty

    if (prevMatch !== -1 && found === prevMatch + 1) score += 6; // consecutive run
    if (isBoundary(found === 0 ? "" : text[found - 1], text[found])) score += 8; // word-start
    if (found === 0) score += 4; // prefix

    prevMatch = found;
    ti = found + 1;
  }
  return score;
}

// Filter + rank rows by the fuzzy score of key(row). Empty query returns the
// rows unchanged (preserving their incoming order).
export function fuzzyFilter<T>(query: string, rows: T[], key: (r: T) => string): T[] {
  if (!query.trim()) return rows;
  const scored: { row: T; score: number }[] = [];
  for (const row of rows) {
    const s = fuzzyScore(query, key(row));
    if (s !== null) scored.push({ row, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}
