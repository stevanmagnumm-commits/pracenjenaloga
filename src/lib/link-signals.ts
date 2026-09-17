/**
 * The tells that an Instagram account is funnelling somewhere — in the bio text
 * or in a highlight's name.
 *
 * Lives in its own module because both the API layer and the finder need it:
 * instagram-api.ts uses the highlight patterns to know when it can stop
 * re-fetching a truncated highlight list, and ig-link-finder.ts uses them to
 * qualify an account. Keeping one copy means the two can never disagree.
 *
 * Everything here is matched against the CORE of the phrase, never the
 * decoration. Real highlight names look like "✨🔗 ✨", "🔒Here!🔥", "More of
 * me😝" — the emoji around the word varies endlessly and the word does not, so
 * the patterns ignore what surrounds them.
 */

export interface Signal {
  label: string;
  re: RegExp;
}

/** Phrases in the bio that say the link is elsewhere. */
export const BIO_SIGNALS: Signal[] = [
  { label: "yes I have one", re: /yes,?\s*i\s*(have|got)\s*one/i },
  { label: "check my highlights", re: /check\s+(my|the|out my)\s+highlights?/i },
  { label: "only backup", re: /only\s+backup/i },
  { label: "main", re: /(^|[^a-z])main([^a-z]|$)/i },
  // Down arrows come in several shapes, and the pointing hand is the common
  // one: @jokesonella's bio ends "shh… don't tell anyone 👇🏼", which an
  // arrow-only pattern missed entirely.
  { label: "⬇️", re: /[⬇↓]|👇/u },
  { label: "for more of me", re: /for\s*more\s*of\s*me/i },
  { label: "my other page", re: /(my\s*)?other\s*(page|acc(ount)?|profile)/i },
];

/**
 * Highlight names that carry the funnel.
 *
 * Drawn from names seen in the wild: 🔗 · spicy 🌶️ · 🌶️🌶️ · Here🫶🏻 · 🔗🤭 ·
 * ✨🔗 ✨ · HERE🔗🩵 · More ;) · 💙🔓 · Check it🔗 · LINKS 🔐💋 · 🔒Here!🔥 ·
 * Links · My link 💙 · More 😏 · my links 🔗 · More of me😝 · Check it · 🔗🔗🔗 ·
 * Find me🥰 · Find me here
 *
 * "💙🤍" is in the list for a reason that is not obvious from the outside: blue
 * and white are the OnlyFans colours, and the pair is used as a wink toward it.
 * Matched only as an adjacent pair, in either order, so a lone blue heart in
 * "Brasil 💙" does not drag a holiday album in with it.
 */
export const HIGHLIGHT_SIGNALS: Signal[] = [
  // The link emoji is unambiguous wherever it appears.
  { label: "🔗", re: /🔗/u },
  // Padlocks read as "gated content" in this context: 💙🔓, LINKS 🔐💋, 🔒Here!🔥
  { label: "🔒", re: /[🔒🔓🔐]/u },
  { label: "link", re: /link/i },
  { label: "spicy", re: /spicy|🌶/iu },
  // Bounded so "here" does not fire on "where", "there", "adhere".
  { label: "here", re: /(^|[^a-z])here([^a-z]|$)/i },
  // "more" is the same shape: More ;) · More 😏 · More of me
  { label: "more", re: /(^|[^a-z])more([^a-z]|$)/i },
  { label: "check it", re: /check\s*(it|me)?/i },
  { label: "find me", re: /find\s*me/i },
  { label: "website", re: /web\s*site/i },
  // The 18+ badge is used as the highlight's whole name on these accounts.
  { label: "🔞", re: /🔞/u },
  { label: "secret", re: /secret/i },
  // "my page" only — bare "page" would catch front page, page 2 and the like.
  { label: "my page", re: /my\s*pages?/i },
  // The badge spelled out, next to the emoji form above.
  { label: "18+", re: /18\s*\+/ },
  // One pattern covers click me · click this · click here · just "click".
  { label: "click", re: /click/i },
  { label: "all of me", re: /all\s*of\s*me/i },
  { label: "socials", re: /socials?/i },
  // Blue + white, the OnlyFans palette, used as a nod to it. Adjacent pair only.
  { label: "💙🤍", re: /💙\s*🤍|🤍\s*💙/u },
];

/**
 * Scripts that mark an account as belonging to an audience this search is not
 * for: Cyrillic, Arabic (including its supplements and presentation forms), and
 * the Indic block from Devanagari through Malayalam.
 *
 * One character anywhere in the bio is enough. These accounts are dropped
 * before any further call is spent — the point is not to judge the language but
 * to stop paying to check profiles that will never be useful.
 */
const FOREIGN_SCRIPT = new RegExp(
  "[" +
    "\\u0400-\\u052F" + // Cyrillic + Cyrillic Supplement
    "\\u2DE0-\\u2DFF\\uA640-\\uA69F" + // Cyrillic Extended-A / -B
    "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF" + // Arabic + supplements
    "\\uFB50-\\uFDFF\\uFE70-\\uFEFC" + // Arabic presentation forms
    "\\u0900-\\u0D7F" + // Devanagari … Malayalam
    "]",
);

export function hasForeignScript(text: string): boolean {
  return !!text && FOREIGN_SCRIPT.test(text);
}

export function matchSignals(text: string, signals: Signal[]): string[] {
  if (!text) return [];
  return signals.filter((s) => s.re.test(text)).map((s) => s.label);
}

/** True when a highlight's name alone marks the account as worth keeping. */
export function isFunnelHighlightTitle(title: string): boolean {
  return HIGHLIGHT_SIGNALS.some((s) => s.re.test(title));
}
