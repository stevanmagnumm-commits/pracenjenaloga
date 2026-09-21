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
 * "💙" is in the list for a reason that is not obvious from the outside: blue
 * and white are the OnlyFans colours, and the blue heart is used as a wink
 * toward it.
 *
 * The later entries were not guessed. They come from the 49,902-account run,
 * read off the one sample where the evidence is unambiguous: accounts with
 * exactly ONE highlight, so the name can only be the one that held the link.
 * Names that looked strong on the whole set but weak there were left out —
 * "highlights" (15%), "destacada" (12%), "me" (50%) are coin flips.
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
  // ---------------------------------------------------------------------
  // Names measured on the 49,902-account run, on the clean sample: accounts
  // with exactly one highlight, where the name can only be the one that held
  // the link. Share of that sample in brackets.
  // ---------------------------------------------------------------------
  { label: "vip", re: /(^|[^a-z])vip([^a-z]|$)/i }, // 81%
  { label: "text me", re: /(text|message|msg)\s*me/i }, // 89%
  { label: "exclusive", re: /exclusiv/i }, // 75%, also exclusiva/exclusivo
  { label: "telegram", re: /telegram/i }, // 91% on the clean sample
  // "snap" is Snapchat here. Bounded so it cannot take "snapshot" or
  // "snapback", which are ordinary album names.
  { label: "snap", re: /(^|[^a-z])snap(chat)?([^a-z]|$)/i },
  // Emoji matched exactly as given — no near relatives. 🤭 is deliberately not
  // here beside 🤫, and no eye but 👀.
  { label: "👀", re: /👀/u },
  { label: "🎁", re: /🎁/u },
  { label: "🤫", re: /🤫/u },
  // The OnlyFans blue, on its own rather than only beside a white heart.
  //
  // It was the pair 💙🤍 for fear that a lone blue heart would drag in every
  // "Brasil 💙". Measured instead: among accounts with a single highlight —
  // where the name is unambiguously the one holding the link — 💙 alone was 23
  // hits and 0 misses. Across all accounts it is weaker, 331 to 460, but the
  // "misses" there include accounts whose link sits in a highlight the blind
  // search never opened, so that figure is a floor rather than a rate.
  { label: "💙", re: /[💙🩵]/u },
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


/**
 * Highlight names that mark the account as Spanish- or Portuguese-speaking.
 *
 * These are an exclusion, not a signal, and that is the opposite of how "aqui"
 * first looked: it was the strongest qualifying name in the whole dataset, 184
 * hits to 46 and 17 to 0 on the clean sample. It qualifies so well precisely
 * because it is "click here" in another language — the same intent as our
 * `click` and `here`, on accounts funnelling to privacy.com.br and paylume.fans
 * rather than to an English-speaking audience. Strong evidence of a funnel, and
 * of a funnel this search does not want.
 *
 * Checked BEFORE the qualifying names, so an account whose highlight reads
 * "Link Aqui 🔥" is dropped rather than admitted on the word "link".
 */
export const FOREIGN_LANG_HIGHLIGHT = /aqu[ií]/i;

export function hasForeignLangHighlight(titles: string[]): boolean {
  return titles.some((t) => FOREIGN_LANG_HIGHLIGHT.test(t || ""));
}

export function matchSignals(text: string, signals: Signal[]): string[] {
  if (!text) return [];
  return signals.filter((s) => s.re.test(text)).map((s) => s.label);
}

/** True when a highlight's name alone marks the account as worth keeping. */
export function isFunnelHighlightTitle(title: string): boolean {
  return HIGHLIGHT_SIGNALS.some((s) => s.re.test(title));
}
