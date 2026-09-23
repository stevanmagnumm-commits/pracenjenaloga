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
  // The pointing hand 👇 used to be here beside the arrows and has been taken
  // out. Measured on 2,152 accounts where it was the only signal: 1,329 of
  // them already had a bio link, so the hand was pointing at something we
  // check first and it added nothing; 538 were out of range; and the 223 it
  // actually qualified on its own were fitness coaches, a video production
  // company and a lifestyle account. An arrow in a bio points at the link
  // field — when that field is empty it is pointing at nothing.
  { label: "⬇️", re: /[⬇↓]/u },
  // "for" is not required — the bare phrase is 37:7 on its own.
  { label: "more of me", re: /more\s*of\s*me/i },
  { label: "my other page", re: /(my\s*)?other\s*(page|acc(ount)?|profile)/i },
  // ---------------------------------------------------------------------
  // Measured on the 49,902-account run, against accounts that qualified only
  // later through their highlights — so every one of these was a bio we read
  // and walked past. Hits : misses.
  // ---------------------------------------------------------------------
  // 700:52. By far the largest, and every one of them was missed, because the
  // pattern above it demands "check MY highlights" and almost nobody writes it
  // that way: "It's in my highlights" · "see highlights" · "Go to the
  // highlights" · "Look at my Highlight" · "Tap the highlights" · "Did you
  // notice my highlight?" — 684 distinct phrasings across 700 accounts. The
  // word itself is the signal; the sentence around it never repeats.
  { label: "highlight", re: /highlight/i },
  { label: "link in", re: /link\s*(is\s*)?in\b/i }, // 30:0
  { label: "below", re: /\b(below|scroll|down\s*(here|below))\b/i }, // 62:13
  { label: "🔗", re: /🔗/u }, // 199:46
  // An arrow drawn with letters: "all my links below! v v v v v v". Three or
  // more, so a pair of initials cannot trip it.
  { label: "v v v", re: /\bv(\s+v){2,}\b/i },
];

/**
 * Bio text that marks the account as writing for a Spanish, Portuguese,
 * Italian or French audience.
 *
 * Deliberately narrower than the highlight list: a bio is a paragraph, not a
 * label, so short bounded words like "mes" or "amor" fire far too easily in
 * it. Only phrases that cannot be anything else.
 */
export const FOREIGN_LANG_BIO =
  /destacad|destaque|mira\s+mis?\b|lo\s+que\s+buscas|in\s+evidenza|\b[àa]?\s*la\s+une\b|historias?\s+destacad/i;

export function hasForeignLangBio(text: string): boolean {
  return !!text && FOREIGN_LANG_BIO.test(text);
}

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
  // The same word with a letter missing, which is what folding leaves of
  // "llnk": repeated letters collapse to one, so link survives but llnk
  // becomes lnk. Bounded, since lnk is not a fragment of anything else.
  { label: "lnk", re: /(^|[^a-z])li?nks?([^a-z]|$)/i },
  { label: "spicy", re: /spicy|🌶/iu },
  // Bounded so "here" does not fire on "where", "there", "adhere".
  { label: "here", re: /(^|[^a-z])here([^a-z]|$)/i },
  // "more" is the same shape: More ;) · More 😏 · More of me
  { label: "more", re: /(^|[^a-z])more([^a-z]|$)/i },
  // "check" must be checking SOMETHING. With `(it|me)?` optional the whole
  // pattern collapsed to /check/, and qualified "Fit checks", "mirror check",
  // "closet check", "check ins" and "fake check" — 45 occurrences on one run,
  // roughly a third of them nothing to do with a funnel.
  { label: "check it", re: /check\s*(it|this|that|me|out|my|the|highlight)/i },
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
  // The eyes qualify only as the WHOLE name. Measured both ways, the precision
  // where 👀 is the only signal on the account is the same 67% either way —
  // 91:44 anywhere, 37:18 alone — so narrowing it does not clean it up, it
  // halves the volume. Narrow by choice rather than by evidence. Names like
  // "Here 👀" and "🔗👀" are unaffected: they qualify on the other half.
  { label: "👀", re: /^(\s*👀)+\s*$/u },
  { label: "🎁", re: /🎁/u },
  { label: "🤫", re: /🤫/u },
  // ---------------------------------------------------------------------
  // Second pass over the same clean sample: every name at 80% or better with
  // at least two hits. Counts in brackets are hits : misses.
  // ---------------------------------------------------------------------
  { label: "chat with me", re: /chat\s*w(ith)?\/?\s*me/i }, // 4:0
  { label: "about me", re: /about\s*me/i }, // 5:0
  { label: "all me", re: /(^|[^a-z])all\s*me([^a-z]|$)/i }, // 2:0
  { label: "what u want", re: /what\s*(u|you)\s*want/i }, // 2:0
  { label: "my content", re: /my\s*content/i }, // 2:0
  { label: "the goods", re: /the\s*good/i }, // 4:0 — the goods, the good stuff
  { label: "free", re: /(^|[^a-z])free([^a-z]|$)/i }, // 2:0
  { label: "klick", re: /klick/i }, // 2:0 — click, spelled the German way
  { label: "youtube", re: /youtube/i }, // 2:0
  // Telegram with the paper plane swapped for a television: 📺gram.
  { label: "gram", re: /[📺✈🛩]\s*gram/iu }, // 2:0
  // "me" on its own is a coin flip (21:21), but "me" wearing a heart or a
  // smiley is not: me 💕 · me <3 · me :) all hit without a miss.
  { label: "me +", re: /(^|[^a-z])me\s*([💕💖💗💘💞❤🥰😈]|<3|[:;]-?[)3d])/iu }, // 7:0
  // Emoji, exact, no near relatives.
  { label: "⛓️‍💥", re: /⛓/u }, // 6:0
  { label: "🖇️", re: /🖇/u }, // 5:0
  { label: "🔥🔥", re: /🔥\s*🔥/u }, // 4:0 — the pair only; a single 🔥 is 4:3
  { label: "💜", re: /💜/u }, // 4:1
  { label: "😈", re: /😈/u }, // 5:0
  { label: "🥰", re: /🥰/u }, // 3:0
  { label: "🤭", re: /🤭/u }, // 2:0
  { label: "💬", re: /💬/u }, // 2:0
  { label: "💓💓", re: /💓\s*💓/u }, // 2:0
  { label: "👋", re: /👋/u }, // 2:0
  { label: ";)", re: /[:;]-?\)/ }, // 6:0
  // Whole title only — "of" inside a word is everywhere, "OF" as the entire
  // name of a highlight is OnlyFans. Same for a highlight called just "L".
  { label: "of", re: /^\s*(of|l)\s*$/i }, // 4:0
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
export const FOREIGN_LANG_HIGHLIGHT = new RegExp(
  [
    // "aqui" however it is spaced or hyphenated: aqui · aquí · A-Q-U-I · a q u i
    String.raw`a\W*q\W*u\W*[ií]`,
    // The funnel words themselves, in Portuguese.
    String.raw`clique|euzinha|vem\s*me\s*ver|receitas|conte[uú]do`,
    // "Destaques" / "Destacadas" is what Instagram itself calls highlights in
    // Portuguese and Spanish, so it appears on accounts that never chose a name
    // at all — 561 of them here, the single commonest marker in the data.
    String.raw`destac|destaq`,
    // Ordinary album names, but only in those languages. Bounded, so "family"
    // is not taken for "família" nor "Nola" for "hola".
    String.raw`(^|\W)(praia|playa)(\W|$)`,
    String.raw`(^|\W)fam[ií]lia(\W|$)`,
    String.raw`(^|\W)amig[ao]s?(\W|$)`,
    String.raw`(^|\W)traba(lho|jo)(\W|$)`,
    String.raw`(^|\W)via(jes|gem|jem)(\W|$)`,
    String.raw`(^|\W)comidas?(\W|$)`,
    String.raw`(^|\W)(meus?|minhas?|mis)(\W|$)`,
    String.raw`(^|\W)amor(\W|$)`,
    // The -o/-a ending only: English "exclusive" stays a qualifying signal.
    String.raw`exclusiv[ao](\W|$)`,
    // French. Small — 121 accounts — but the same case: "liens ici" is "links
    // here", as strong a funnel word as anything on the qualifying list, and
    // pointing at an audience this search is not for.
    String.raw`(^|\W)liens?(\W|$)`,
    String.raw`(^|\W)ici(\W|$)`,
    String.raw`(^|\W)(mes|mon)(\W|$)`,
    String.raw`(^|\W)moi(\W|$)`,
    String.raw`(^|\W)amis(\W|$)`,
    String.raw`(^|\W)plages?(\W|$)`,
    String.raw`(^|\W)voyages?(\W|$)`,
    String.raw`(^|\W)famille(\W|$)`,
    String.raw`(^|\W)travail(\W|$)`,
    String.raw`bisous|coucou|abonn[ée]|gratuit|cliquez`,
  ].join("|"),
  "i",
);

export function hasForeignLangHighlight(titles: string[]): boolean {
  return titles.some((t) => FOREIGN_LANG_HIGHLIGHT.test(t || ""));
}

export function matchSignals(text: string, signals: Signal[]): string[] {
  if (!text) return [];
  return signals.filter((s) => s.re.test(text)).map((s) => s.label);
}


/**
 * The same name, written to be read by a human and not by a filter.
 *
 * Seen in the data: 𝓵𝓲𝓷𝓴 · l i n k · l!nk · llnk · l1nks · moreee · moree :)
 * Every one of them is a word already in the list above, and every one of them
 * slipped past it. They are not new signals; they are the old ones in costume.
 *
 * Two folds, because one cannot do both jobs. `fold` keeps word spacing, so
 * phrases still read as phrases. `tight` removes it, which is what turns
 * "l i n k" back into "link" — and only ever makes a pattern match less of the
 * string, never more, so it cannot invent a hit.
 */
function fold(title: string): string {
  return title
    .normalize("NFKD") // 𝓵𝓲𝓷𝓴 -> link
    .toLowerCase()
    .replace(/[1!|]/g, "i") // l1nk, l!nk -> link
    .replace(/0/g, "o")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // punctuation and emoji out of the way
    .replace(/(\p{L})\1{1,}/gu, "$1") // moreee -> more, llnk -> lnk
    .replace(/\s+/g, " ")
    .trim();
}

/** True when a highlight's name alone marks the account as worth keeping. */
export function isFunnelHighlightTitle(title: string): boolean {
  if (!title) return false;
  const folded = fold(title);
  const tight = folded.replace(/\s+/g, "");
  return HIGHLIGHT_SIGNALS.some(
    (s) => s.re.test(title) || s.re.test(folded) || s.re.test(tight),
  );
}
