import {
  fetchProfileRaw,
  fetchSimilarAccounts,
  fetchHighlights,
  fetchHighlightLinks,
  bioLinksFromProfile,
  isQuotaExhausted,
} from "./instagram-api";

/**
 * From a seed account, find the accounts Instagram suggests as similar, and
 * report which of them are running a link — in the bio, or on a link sticker
 * saved into a story highlight.
 *
 * What the provider actually gives, established by probing it rather than
 * assuming (each of these cost a wrong guess to find):
 *
 *   get_ig_similar_accounts.php  GET, returns a bare array of ~80 accounts.
 *   ig_get_fb_profile_v3.php     carries external_url and bio_links.
 *   get_ig_user_highlights.php   array of {node:{id,title}}, id already
 *                                prefixed "highlight:".
 *   get_highlights_stories.php   REQUIRES that prefix; the bare number is
 *                                rejected. Link stickers arrive intact, as
 *                                story_link_stickers[].story_link.url, wrapped
 *                                in l.instagram.com/?u=<destination>.
 *
 * Cost is the design constraint. A bio check is one call; a highlight check is
 * one call for the list plus one per highlight. So an account qualifies as
 * early and as cheaply as it can:
 *
 *   1. a link in the bio            -> done, one call
 *   2. a give-away phrase in the bio -> done, same one call, no highlight spend
 *   3. otherwise                     -> open highlights, stop at the first link
 *
 * Measured on @michelahan_, whose funnel sits in the first of thirteen
 * highlights: stopping there costs 3 calls where opening them all costs 15.
 */

export type LinkBucket = "bio" | "signal" | "story" | "none" | "private" | "failed";

export interface LinkFinderResult {
  username: string;
  fullName: string;
  bucket: LinkBucket;
  /** Which seed account suggested this one. */
  seed: string;
  bioLinks: string[];
  storyLinks: string[];
  /**
   * Hostnames of every link found, deduped — onlyfans.com, linktr.ee,
   * beacons.ai and so on. The whole point of the screen is usually "who funnels
   * where", and a hostname answers that in one glance where a full URL does not.
   */
  linkHosts: string[];
  /** Full bio text, so it can be filtered on without re-running the scrape. */
  biography: string;
  /** Which of the known give-away phrases the bio contains, if any. */
  bioSignals: string[];
  followers: number;
  /** Titles of the highlights that were opened — a highlight called "LINK" or
   *  "VIP" is itself a signal, and it costs nothing extra to carry. */
  highlightTitles: string[];
  isVerified: boolean;
  isPrivate: boolean;
  note?: string;
}

export type FinderPhase = "idle" | "suggesting" | "checking" | "done";

export interface LinkFinderProgress {
  total: number;
  completed: number;
  current: string | null;
  phase: FinderPhase;
  /** Seeds asked for suggestions so far, out of how many were pasted. */
  seedsDone: number;
  seedsTotal: number;
  counts: Record<LinkBucket, number>;
  abortedReason: string | null;
  running: boolean;
  results: LinkFinderResult[];
}

const CONCURRENCY = Math.max(1, Number(process.env.IG_LINK_CONCURRENCY) || 4);

// Highlights are the expensive half. An account with a dozen of them would cost
// thirteen calls on its own, so only the most recent few are opened — a link
// sticker that matters is rarely buried at the bottom.
const MAX_HIGHLIGHTS = Math.max(1, Number(process.env.IG_LINK_MAX_HIGHLIGHTS) || 4);

// Same hard ceiling the views checker needed: one account that never answers
// must not be able to hold the whole run. Highlights make this path longer than
// most, hence the generous budget.
const ACCOUNT_DEADLINE = 180_000;

/**
 * Phrases that give the funnel away in the bio itself, before a single extra
 * call is spent. An account writing "check my highlights" has told you where
 * the link is; @justnaomita's bio reads exactly that and carries no bio link at
 * all, so this catches the most valuable group — the ones hiding the link in a
 * story — for free.
 *
 * "main" needs boundaries or it matches domain, mainly, remain. The rest are
 * distinctive enough to match as written.
 */
const BIO_SIGNALS: Array<{ label: string; re: RegExp }> = [
  { label: "yes I have one", re: /yes,?\s*i\s*(have|got)\s*one/i },
  { label: "check my highlights", re: /check\s+(my|the|out my)\s+highlights?/i },
  { label: "only backup", re: /only\s+backup/i },
  { label: "main", re: /(^|[^a-z])main([^a-z]|$)/i },
  // Down arrows come in several shapes, and the pointing hand is the common
  // one: @jokesonella's bio ends "shh… don't tell anyone 👇🏼", which an
  // arrow-only pattern misses entirely.
  { label: "⬇️", re: /[⬇↓]|👇/u },
];

function bioSignalsIn(text: string): string[] {
  if (!text) return [];
  return BIO_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.label);
}

/**
 * Highlight names that announce the funnel. Same idea as the bio phrases, one
 * step later: once the highlight list is in hand (one call), a highlight called
 * "LINK" or "MY LINKS" has already answered the question.
 *
 * "here" is bounded so it does not match "where" or "there". "link" is left
 * loose on purpose, so "links", "my links" and "linkinbio" all count.
 */
const HIGHLIGHT_SIGNALS: Array<{ label: string; re: RegExp }> = [
  { label: "link", re: /link/i },
  { label: "here", re: /(^|[^a-z])here([^a-z]|$)/i },
];

function isSignalTitle(title: string): boolean {
  return HIGHLIGHT_SIGNALS.some((s) => s.re.test(title));
}

/** Bare hostnames, lowercased and stripped of "www.", deduped. */
function hostsOf(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    try {
      out.push(new URL(u).hostname.replace(/^www\./i, "").toLowerCase());
    } catch {
      /* a link we cannot parse is still shown in full elsewhere */
    }
  }
  return [...new Set(out)];
}

function emptyCounts(): Record<LinkBucket, number> {
  return { bio: 0, signal: 0, story: 0, none: 0, private: 0, failed: 0 };
}

function freshProgress(running: boolean, seedsTotal = 0): LinkFinderProgress {
  return {
    total: 0,
    completed: 0,
    current: null,
    phase: running ? "suggesting" : "idle",
    seedsDone: 0,
    seedsTotal,
    counts: emptyCounts(),
    abortedReason: null,
    running,
    results: [],
  };
}

let progress: LinkFinderProgress = freshProgress(false);
let runToken = 0;
let quotaAbort: string | null = null;

function noteIfQuotaDead(err: unknown): void {
  if (!quotaAbort && isQuotaExhausted(err)) {
    quotaAbort =
      "Monthly API quota exhausted — run stopped. Nothing will check until the plan resets or is upgraded.";
    console.error(`[ig-link-finder] ABORT: ${quotaAbort}`);
  }
}

export function getLinkFinderProgress(): LinkFinderProgress {
  return progress;
}

export function stopLinkFinder(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    progress.phase = "done";
    console.log("[ig-link-finder] Stopped by user");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withDeadline<T>(work: Promise<T>, ms: number, onExpiry: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onExpiry()), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pool<T>(
  items: T[],
  limit: number,
  isActive: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (isActive()) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface Candidate {
  username: string;
  fullName: string;
  seed: string;
  isPrivate: boolean;
  isVerified: boolean;
}

/** One candidate: bio first, highlights only if the bio came back empty. */
async function inspect(
  cand: Candidate,
  checkHighlights: boolean,
  isActive: () => boolean,
): Promise<LinkFinderResult> {
  const base = {
    username: cand.username,
    fullName: cand.fullName,
    seed: cand.seed,
    isVerified: cand.isVerified,
    isPrivate: cand.isPrivate,
    bioLinks: [] as string[],
    storyLinks: [] as string[],
    linkHosts: [] as string[],
    biography: "",
    bioSignals: [] as string[],
    followers: 0,
    highlightTitles: [] as string[],
  };

  try {
    // fetchProfileRaw, not fetchProfile. The narrowed profile carries `bio` and
    // `followerCount` and no links at all — reading external_url off it yields
    // undefined for every account, so nothing could ever qualify on its bio.
    // A live run proved it: 361 candidates, 0 in "Link in bio", 0 in "Bio says
    // so", while four accounts checked by hand all had a bio link.
    const profile = await fetchProfileRaw(cand.username);
    base.biography = typeof profile.biography === "string" ? profile.biography : "";
    base.bioSignals = bioSignalsIn(base.biography);
    base.followers = Number(profile.follower_count) || 0;

    const bioLinks = bioLinksFromProfile(profile);
    if (bioLinks.length) {
      return { ...base, bioLinks, linkHosts: hostsOf(bioLinks), bucket: "bio" };
    }

    // A bio that names its own funnel — "check my highlights", "only backup" —
    // is proof enough on its own, so the account qualifies here and the
    // highlight calls are never spent. That is 1+N calls saved on exactly the
    // group that would otherwise be the most expensive to confirm.
    if (base.bioSignals.length) {
      return {
        ...base,
        bucket: "signal",
        note: `bio says: ${base.bioSignals.join(", ")}`,
      };
    }

    // A private account will not hand over its highlights, so spending calls on
    // them is guaranteed waste. Say so rather than filing it as "no link".
    if (cand.isPrivate || profile.is_private === true) {
      return { ...base, bucket: "private", note: "private account — highlights not readable" };
    }

    if (!checkHighlights) {
      return { ...base, bucket: "none", note: "bio empty (highlights not checked)" };
    }

    const highlights = await fetchHighlights(cand.username);
    if (!highlights.length) {
      return { ...base, bucket: "none", note: "no bio link, no highlights" };
    }

    base.highlightTitles = highlights.map((h) => h.title).filter(Boolean);
    const namedHits = base.highlightTitles.filter(isSignalTitle);

    // A highlight whose name announces the link is opened FIRST — it is the one
    // most likely to hold the funnel, so trying it before the holiday albums
    // answers sooner and costs less.
    const ordered = [...highlights].sort(
      (a, b) => Number(isSignalTitle(b.title)) - Number(isSignalTitle(a.title)),
    );

    const storyLinks: string[] = [];
    let unreadable = 0;
    const opened = ordered.slice(0, MAX_HIGHLIGHTS);
    for (const h of opened) {
      if (!isActive()) break;
      try {
        const links = await fetchHighlightLinks(h.id);
        storyLinks.push(...links);
        if (storyLinks.length) break; // one is enough to qualify
      } catch {
        // One highlight the provider would not serve must not sink the account,
        // but it must also not be silently counted as "checked, nothing there".
        unreadable++;
      }
    }

    if (storyLinks.length) {
      const uniq = [...new Set(storyLinks)];
      return { ...base, storyLinks: uniq, linkHosts: hostsOf(uniq), bucket: "story" };
    }

    // The name alone qualifies the account even when no sticker could be read —
    // a highlight called "MY LINKS" is not named that by accident.
    if (namedHits.length) {
      return {
        ...base,
        bucket: "signal",
        note: `highlight named: ${namedHits.join(", ")}`,
      };
    }

    // Nothing found — but "found nothing" and "could not look" are different
    // answers, and only one of them means the account has no funnel.
    if (unreadable) {
      return {
        ...base,
        bucket: "failed",
        note: `no bio link; ${unreadable} of ${opened.length} highlight(s) could not be read — re-run this one`,
      };
    }
    return {
      ...base,
      bucket: "none",
      note: `no bio link; ${opened.length} highlight(s) checked, none carried a link`,
    };
  } catch (err) {
    noteIfQuotaDead(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Profile not found") || msg.includes("data not found")) {
      return { ...base, bucket: "failed", note: "profile not found — banned or deleted" };
    }
    console.error(`[ig-link-finder] @${cand.username}:`, msg);
    return { ...base, bucket: "failed", note: msg.slice(0, 160) };
  }
}

export async function runLinkFinder(
  seeds: string[],
  opts: { checkHighlights?: boolean; maxCandidates?: number } = {},
): Promise<void> {
  if (progress.running) return;

  const checkHighlights = opts.checkHighlights !== false;
  const maxCandidates = Math.max(1, opts.maxCandidates || 500);

  const cleanSeeds = [
    ...new Set(seeds.map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean)),
  ];
  if (!cleanSeeds.length) return;

  const myToken = ++runToken;
  quotaAbort = null;
  const isActive = () => progress.running && runToken === myToken && !quotaAbort;

  progress = freshProgress(true, cleanSeeds.length);

  const finalize = (r: LinkFinderResult) => {
    if (!isActive()) return;
    progress.results.push(r);
    progress.counts[r.bucket]++;
    progress.completed++;
  };

  try {
    // Phase 1 — collect suggestions. One call per seed, ~80 accounts each.
    const seen = new Set(cleanSeeds);
    const candidates: Candidate[] = [];

    for (const seed of cleanSeeds) {
      if (!isActive()) break;
      progress.current = seed;
      try {
        const suggested = await fetchSimilarAccounts(seed);
        for (const s of suggested) {
          const key = s.username.toLowerCase();
          if (seen.has(key)) continue; // already a seed, or suggested twice
          seen.add(key);
          candidates.push({
            username: s.username,
            fullName: s.fullName,
            seed,
            isPrivate: s.isPrivate,
            isVerified: s.isVerified,
          });
        }
        console.log(`[ig-link-finder] @${seed} -> ${suggested.length} suggestions`);
      } catch (err) {
        noteIfQuotaDead(err);
        console.error(`[ig-link-finder] seed @${seed}:`, err instanceof Error ? err.message : err);
      }
      progress.seedsDone++;
      await sleep(400);
    }

    const work = candidates.slice(0, maxCandidates);
    progress.total = work.length;
    progress.phase = "checking";
    console.log(
      `[ig-link-finder] ${work.length} candidates from ${cleanSeeds.length} seed(s); ` +
        `highlights ${checkHighlights ? "on" : "off"}`,
    );

    // Phase 2 — inspect each candidate.
    await pool(work, CONCURRENCY, isActive, async (cand) => {
      progress.current = cand.username;
      const result = await withDeadline(
        inspect(cand, checkHighlights, isActive),
        ACCOUNT_DEADLINE,
        () => {
          console.error(`[ig-link-finder] @${cand.username} exceeded ${ACCOUNT_DEADLINE / 1000}s`);
          return {
            username: cand.username,
            fullName: cand.fullName,
            seed: cand.seed,
            isVerified: cand.isVerified,
            isPrivate: cand.isPrivate,
            bioLinks: [],
            storyLinks: [],
            linkHosts: [],
            biography: "",
            bioSignals: [],
            followers: 0,
            highlightTitles: [],
            bucket: "failed" as LinkBucket,
            note: `no answer within ${ACCOUNT_DEADLINE / 1000}s`,
          };
        },
      );
      finalize(result);
    });
  } catch (err) {
    console.error("[ig-link-finder] Batch error:", err);
  } finally {
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.phase = "done";
      progress.abortedReason = quotaAbort;
      const c = progress.counts;
      console.log(
        `[ig-link-finder] Done. bio: ${c.bio}, signal: ${c.signal}, story: ${c.story}, ` +
          `none: ${c.none}, private: ${c.private}, failed: ${c.failed}`,
      );
    }
  }
}
