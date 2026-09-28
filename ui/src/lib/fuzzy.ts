// Fuzzy match scoring for the launcher palette, ported from the frozen native
// page (host/src/launcher/ui.ts): a substring hit always beats a subsequence
// hit, and both rank by earliest position / streak length.

export function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // substring beats subsequence
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    s += 1 + streak;
    ti = found + 1;
  }
  return s;
}
