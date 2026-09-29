/**
 * What is actually behind a link-in-bio page.
 *
 * "This account has a linktr.ee" turned out to mean almost nothing. Measured on
 * 213 linktree pages taken from a real run and read from linktree's own JSON:
 * 4 had a paysite (1%), 23 had a chat link (10%), and 186 — 87% — had nothing
 * but Instagram, TikTok, YouTube, Amazon Storefront, Spotify, ShopMy, LTK,
 * Depop and Vinted. Ordinary influencers with affiliate shops.
 *
 * So the destination is read, not assumed. This costs no API quota at all: it
 * is one ordinary HTTP GET of a public page.
 *
 * Three things are looked for, in descending order of certainty:
 *
 *  1. A paysite in the destinations or the button titles.
 *  2. An age gate. This is the one that rescues pages whose links are drawn by
 *     JavaScript and therefore invisible: @adoragwen and heyy.fun/ana show no
 *     destinations at all, but both say "You must be 18 or older". An Amazon
 *     storefront never does.
 *  3. An invitation to talk or to tip — t.me, snapchat, cash.app, "Want to
 *     chat?", "Direct Message me", "Spoil me with tips".
 */

const AGGREGATOR =
  /(^|\.)(linktr\.ee|link\.me|beacons\.ai|beacons\.page|hoo\.be|allmylinks\.com|getallmylinks\.com|stan\.store|bio\.link|bouncy\.ai|komi\.io|snipfeed\.co|xli\.ink|oopsie\.bio|slt\.bio|getmysocial\.com|hitmyl\.ink|linkcloud\.ai|linkylo\.co|clickylo\.co|heyy\.fun|gaml\.io|solo\.to|carrd\.co|withkoji\.com|milkshake\.app|tap\.bio|campsite\.bio)$/i;

const PAYSITE =
  /onlyfans|fansly|fanvue|privacy\.com\.br|paylume|fanfix|manyvids|loyalfans|fancentro|mym\.fans|alua\.com|okfans|slushy|fanhouse|justfor\.?fans|scrile|sextpanther|fanseven|passes\.com/i;

// Telegram and Snapchat carry private content in this niche; cash.app, Venmo
// and Throne are the tip jar beside it. WhatsApp is deliberately NOT here:
// it is an ordinary business contact, and it scored a dance school as a
// funnel.
const CHAT_HOST = /^(t\.me|telegram\.me|snapchat\.com|story\.snapchat\.com|cash\.app|venmo\.com|throne\.com|throne\.me)$/i;

/**
 * The wording that is safe to look for ANYWHERE on a page.
 *
 * The rest of FUNNEL_TITLE below - the bare words vip, exclusive, premium,
 * click here - is only safe inside a link's own button label. Searched across
 * a whole page they are ordinary e-commerce copy: of 60 non-aggregator links
 * from a live run, 21 were scored as funnels on those words alone, and they
 * were a hair salon, a treadmill shop, a gym price list and a concert.
 *
 * What is here is what a shop does not say.
 */
const STRONG_PARTS = [
  String.raw`onlyfans|only fans|fansly|fanvue`,
  String.raw`(direct )?message me\b|\bdm me\b|text me\b|want to chat|chat with me\b`,
  String.raw`spoil me\b|tip me\b|get to know me\b`,
  // Phrases, never the bare word. Measured on 69 ordinary bio links from a
  // live run: "exclusive page", "premium page", "my page" and "my link" hit
  // none of them, "vip page" hit one. The bare words hit 21 of 60.
  String.raw`\b(vip|exclusive|premium)["'“”‘’\s]*(\w+\s+)?(page|content|room|club|access|section|stuff|videos?|photos?)\b`,
  String.raw`\bmy\s*(vip|exclusive|premium|page|link)\b`,
  // Taken off 13 pages that were real funnels and had been read as ordinary.
  // Each hit 0 of 56 control pages from the same run, so they cost nothing.
  String.raw`(see\s+)?more of me\b|(come\s+)?talk to me\b`,
  String.raw`add me (here|on)\b|send (me a )?message\b`,
  String.raw`\+\s*18\b|online now\b|limited time offer\b`,
];

const STRONG_TITLE = new RegExp(STRONG_PARTS.join("|"), "i");

/**
 * Titles that say the same thing the paysite would.
 *
 * Everything STRONG_TITLE looks for - a phrase safe on a whole page is safe
 * in a button label - plus the bare words that only a button may use.
 */
const FUNNEL_TITLE = new RegExp(
  [
    ...STRONG_PARTS,
    String.raw`\bvip\b|exclusive|premium|18\s*\+`,
    String.raw`click here\b`,
  ].join("|"),
  "i",
);

/**
 * An age gate. Strong on its own, and visible even when the links are not:
 * "You must be 18 or older" · "18+ Age Check" · "May Contain Sensitive Content"
 */
const AGE_GATE =
  /must be 18|18\s*or older|are you 18|18\s*\+(?!\s*(years?|yrs?|month|day|hour|minute|location|store|color|colour|style|flavor|flavour|option|brand|shade|design|item|product|page|piece|pack|count|ct\b))|age\s*(check|verification|gate)|sensitive content|adult content|i am under 18|enter if you are 18/i;

export type DestinationVerdict = "funnel" | "nothing" | "unreadable";

export interface Destination {
  verdict: DestinationVerdict;
  /** Why — shown in the result note so a judgement is never a mystery. */
  reason: string;
  hosts: string[];
}

export function isAggregator(url: string): boolean {
  try {
    return AGGREGATOR.test(new URL(url).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

const PAGE_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.IG_PAGE_TIMEOUT_MS) || 15_000,
);

/**
 * Page fetches get their own small pool. They cost no API quota, but forty at
 * once is how you get blocked: a scan of 300 pages at fourteen in flight
 * already drew 37 refusals.
 */
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.IG_PAGE_CONCURRENCY) || 8);
let inFlight = 0;
const queue: (() => void)[] = [];

async function slot(): Promise<void> {
  if (inFlight < PAGE_CONCURRENCY) {
    inFlight++;
    return;
  }
  await new Promise<void>((r) => queue.push(r));
  inFlight++;
}
function release(): void {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

/** Same page asked for twice in a run is fetched once. */
const cache = new Map<string, Destination>();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Pages ship their links JSON-escaped inside a script payload, so a search for
 * "https://" finds nothing while "https:\/\/" is all over the page. Undoing
 * that is what makes hoo.be, stan.store and link.me readable without a browser.
 */
function unescapeUrls(html: string): string {
  return html
    .replace(new RegExp(String.raw`\\u002[fF]`, "g"), "/")
    .replace(new RegExp(String.raw`\\\\/`, "g"), "/")
    .replace(new RegExp(String.raw`\\u0026`, "g"), "&");
}

function hostsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].replace(/^www\./, "").toLowerCase());
  return [...out];
}

/**
 * Linktree writes "isOnlyfansSEOEnabled":false into EVERY page, which a naive
 * search for the word reads as a hit. That single flag is why an earlier
 * measurement reported 79% of pages carrying a paysite when the true figure
 * was 1%. It is removed before any wording is judged.
 */
/**
 * The links the OWNER of the page put there, when the platform exposes them.
 *
 * Linktree ships its whole promoted-offer inventory in the same payload, so
 * taking every URL on the page picks up Fabletics, HelloFresh and Babbel on an
 * account that links to none of them — which is how two different accounts came
 * to show an identical set of "affiliate links".
 */
function ownLinks(html: string): { titles: string[]; hosts: string[] } | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]) as Record<string, unknown>;
    const props = (data.props ?? {}) as Record<string, unknown>;
    const page = (props.pageProps ?? {}) as Record<string, unknown>;
    const account = (page.account ?? {}) as Record<string, unknown>;
    const rows = [
      ...((account.links as unknown[]) ?? []),
      ...((account.socialLinks as unknown[]) ?? []),
    ] as Record<string, unknown>[];
    if (!rows.length) return null;
    const titles: string[] = [];
    const hosts: string[] = [];
    for (const r of rows) {
      if (typeof r.title === "string" && r.title.trim()) titles.push(r.title.trim());
      const u = (r.storedUrl ?? r.url) as unknown;
      if (typeof u === "string" && u.startsWith("http")) {
        try {
          hosts.push(new URL(u).hostname.replace(/^www\./, "").toLowerCase());
        } catch {
          // an unparseable url tells us nothing; skip it
        }
      }
    }
    return { titles, hosts };
  } catch {
    return null;
  }
}

function stripSeoFlags(html: string): string {
  return html.replace(/"is[A-Za-z]*(Onlyfans|OnlyFans)[A-Za-z]*"\s*:\s*(true|false)/g, "");
}

export async function readDestination(url: string): Promise<Destination> {
  const hit = cache.get(url);
  if (hit) return hit;

  await slot();
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.ok) html = (await res.text()).slice(0, 700_000);
  } catch {
    // left empty — treated as unreadable below
  } finally {
    release();
  }

  let out: Destination;
  if (!html) {
    out = { verdict: "unreadable", reason: "page would not open", hosts: [] };
  } else {
    const structured = ownLinks(html);
    const text = unescapeUrls(html);
    // Structured when the platform gives it, the whole page only when it does
    // not. The difference is not fussiness: linktree sells ad space on every
    // page, and its own promoted copy says "be a VIP!", "exclusive rewards",
    // "not valid on premiums". Reading the page as a whole scored four ordinary
    // influencers as funnels on those words alone.
    const hosts = structured ? structured.hosts : hostsIn(text);
    const titles = structured ? structured.titles.join(" · ") : "";
    const pay = hosts.filter((h) => PAYSITE.test(h));
    const chat = hosts.filter((h) => CHAT_HOST.test(h));

    if (pay.length) {
      out = { verdict: "funnel", reason: `links to ${pay[0]}`, hosts };
    } else if (structured && PAYSITE.test(titles)) {
      out = { verdict: "funnel", reason: "a link is titled for a paysite", hosts };
    } else if (AGE_GATE.test(html)) {
      // Survives even when the links are drawn by JavaScript and invisible.
      out = { verdict: "funnel", reason: "page is age-gated", hosts };
    } else if (structured ? FUNNEL_TITLE.test(titles) : STRONG_TITLE.test(stripSeoFlags(html))) {
      out = { verdict: "funnel", reason: "funnel wording on the page", hosts };
    } else if (chat.length) {
      out = { verdict: "funnel", reason: `links to ${chat[0]}`, hosts };
    } else {
      out = { verdict: "nothing", reason: "no paysite, no age gate, no chat", hosts };
    }
  }
  cache.set(url, out);
  return out;
}

/**
 * The verdict for a set of links. Only aggregator pages are opened; a direct
 * paysite link needs no reading, and anything else is left alone.
 */
export async function judgeLinks(urls: string[]): Promise<Destination> {
  const direct = urls.find((u) => PAYSITE.test(u));
  if (direct) return { verdict: "funnel", reason: "direct paysite link", hosts: [] };

  // Every link is opened, not just the known aggregators. Restricting it to
  // those left 58% of accounts passing unexamined on one live run, and their
  // links were shopvvshair.com, influencer.fashionnova.com, a gym price list
  // and a hair boutique. Three of the clearest funnels in the sample —
  // itsjadelin.me, cowgirljolene.com, adoragwen.com — were plain domains too,
  // so there was never a reason to treat them differently.
  const pages = urls.slice(0, 4);
  if (!pages.length) {
    return { verdict: "unreadable", reason: "no link to read", hosts: [] };
  }

  let sawNothing: Destination | null = null;
  let sawUnreadable: Destination | null = null;
  for (const p of pages) {
    const d = await readDestination(p);
    if (d.verdict === "funnel") return d;
    if (d.verdict === "unreadable") sawUnreadable = d;
    else sawNothing = d;
  }
  // Unreadable outranks "nothing": a page that would not open has told us
  // nothing, and "could not look" must never be filed as "looked and it was
  // empty".
  return sawUnreadable ?? sawNothing ?? { verdict: "nothing", reason: "", hosts: [] };
}
