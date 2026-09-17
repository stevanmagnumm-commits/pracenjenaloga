import {
  fetchProfileRaw,
  fetchSimilarAccounts,
  fetchHighlights,
  fetchHighlightLinks,
  bioLinksFromProfile,
  isQuotaExhausted,
  type HighlightRef,
} from "./instagram-api";
import {
  BIO_SIGNALS,
  matchSignals,
  isFunnelHighlightTitle,
  hasForeignScript,
} from "./link-signals";

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

export type LinkBucket =
  | "bio"
  | "signal"
  | "hlname"
  | "story"
  | "outofrange"
  | "wrongscript"
  | "none"
  | "private"
  | "failed";

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

// Highlights are the expensive half — measured at 86% of a run's API calls, so
// every one opened has to earn it. Two, not four: all three accounts examined by
// hand kept the funnel in their FIRST highlight, and the ordering puts a
// link-named one ahead of the holiday albums anyway.
const MAX_HIGHLIGHTS = Math.max(1, Number(process.env.IG_LINK_MAX_HIGHLIGHTS) || 2);

// The follower range worth looking at. Outside it an account is dropped right
// after the profile call — no bio check, no highlights, and never reported as
// good. Those highlight calls were 86% of a run's budget.
const MIN_FOLLOWERS = Math.max(
  0,
  Number(process.env.IG_LINK_MIN_FOLLOWERS) || 10_000,
);


const MAX_FOLLOWERS = Math.max(
  1,
  Number(process.env.IG_LINK_MAX_FOLLOWERS) || 1_000_000,
);

// Same hard ceiling the views checker needed: one account that never answers
// must not be able to hold the whole run. Highlights make this path longer than
// most, hence the generous budget.
const ACCOUNT_DEADLINE = 180_000;

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
  return {
    bio: 0,
    signal: 0,
    hlname: 0,
    story: 0,
    outofrange: 0,
    wrongscript: 0,
    none: 0,
    private: 0,
    failed: 0,
  };
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
    base.bioSignals = matchSignals(base.biography, BIO_SIGNALS);
    base.followers = Number(profile.follower_count) || 0;

    // Cyrillic, Arabic or Indic script in the bio means this is not the
    // audience the search is for. One such character is the whole test, and it
    // is checked before anything else so the account is abandoned here — no
    // highlight calls, and never counted as good whatever else the bio holds.
    if (hasForeignScript(base.biography)) {
      return {
        ...base,
        bucket: "wrongscript",
        note: "bio is not in Latin script — skipped",
      };
    }

    // Out of range, out of the run. The follower count is only knowable after
    // the profile call, so that one is unavoidable — but nothing past it is
    // spent, and the account is never reported as good no matter what its bio
    // says. A small account and a million-follower one are both a different
    // business from the one this screen is looking for.
    if (
      base.followers < MIN_FOLLOWERS ||
      base.followers > MAX_FOLLOWERS
    ) {
      return {
        ...base,
        bucket: "outofrange",
        note:
          base.followers < MIN_FOLLOWERS
            ? `${base.followers.toLocaleString("en-US")} followers — under ${MIN_FOLLOWERS.toLocaleString("en-US")}`
            : `${base.followers.toLocaleString("en-US")} followers — over ${MAX_FOLLOWERS.toLocaleString("en-US")}`,
      };
    }

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

    const seenIds = new Set<string>();
    const storyLinks: string[] = [];
    let unreadable = 0;
    let openedCount = 0;

    /** Open up to MAX_HIGHLIGHTS of these, named ones first, stopping at the
     *  first link. Returns true the moment something is found. */
    const tryHighlights = async (list: HighlightRef[]): Promise<boolean> => {
      const ordered = [...list].sort(
        (a, b) =>
          Number(isFunnelHighlightTitle(b.title)) - Number(isFunnelHighlightTitle(a.title)),
      );
      for (const h of ordered) {
        if (!isActive()) break;
        // The budget is two highlights — but a highlight whose NAME announces
        // the funnel is always opened, even past it. Otherwise the cap could be
        // spent on two holiday albums in the first (truncated) list, leaving a
        // "da link ;)" that only appeared in the second list unopened. That is
        // the exact shape of the @natalieexking case, and the one call it costs
        // is the most valuable one on the account.
        if (openedCount >= MAX_HIGHLIGHTS && !isFunnelHighlightTitle(h.title)) break;
        if (seenIds.has(h.id)) continue;
        seenIds.add(h.id);
        openedCount++;
        try {
          const links = await fetchHighlightLinks(h.id);
          if (links.length) {
            storyLinks.push(...links);
            return true; // one is enough — never open the rest
          }
        } catch {
          // One highlight the provider would not serve must not sink the
          // account, but nor may it count as "checked, nothing there".
          unreadable++;
        }
      }
      return false;
    };

    // Names before links.
    //
    // One list call hands over EVERY highlight name at once, and reading them
    // costs nothing more. Opening a highlight to look for the sticker costs a
    // call each. So the names decide first: when one of them announces the
    // funnel the account is already qualified, and only that highlight is
    // opened — for the URL, not for the verdict. The rest are never touched.
    //
    // Before this, highlights were opened first and the names consulted
    // afterwards, so an account with a highlight called "my page" spent two
    // calls proving something its own title had already said.
    const openNamedOnly = async (list: HighlightRef[]): Promise<boolean> =>
      tryHighlights(list.filter((h) => isFunnelHighlightTitle(h.title)));

    let highlights = await fetchHighlights(cand.username);
    base.highlightTitles = highlights.map((h) => h.title).filter(Boolean);
    let namedHits = base.highlightTitles.filter(isFunnelHighlightTitle);

    let found = false;
    if (namedHits.length) {
      found = await openNamedOnly(highlights);
    } else if (highlights.length) {
      found = await tryHighlights(highlights);
    }

    // The list arrives truncated about four times in ten, and the entry it drops
    // is the one that matters — so a second look is worth it, but only when the
    // first found neither a link nor a telling name.
    if (!found && !namedHits.length && isActive()) {
      const second = await fetchHighlights(cand.username);
      const fresh = second.filter((h) => !seenIds.has(h.id));
      if (fresh.length) {
        base.highlightTitles = [
          ...new Set([...base.highlightTitles, ...fresh.map((h) => h.title).filter(Boolean)]),
        ];
        namedHits = base.highlightTitles.filter(isFunnelHighlightTitle);
        found = namedHits.length ? await openNamedOnly(fresh) : await tryHighlights(fresh);
      }
      highlights = [...highlights, ...fresh];
    }

    if (!highlights.length) {
      return { ...base, bucket: "none", note: "no bio link, no highlights" };
    }

    if (found) {
      const uniq = [...new Set(storyLinks)];
      return { ...base, storyLinks: uniq, linkHosts: hostsOf(uniq), bucket: "story" };
    }

    // The name alone qualifies the account even when no sticker could be read —
    // a highlight called "MY LINKS" is not named that by accident. Kept apart
    // from the bio phrases: both mean "good", but one was proven by what the
    // account wrote about itself and the other by what it called a highlight,
    // and collapsing them hides which check is actually earning its keep.
    if (namedHits.length) {
      return {
        ...base,
        bucket: "hlname",
        note: `highlight named: ${namedHits.join(", ")}`,
      };
    }

    // Nothing found — but "found nothing" and "could not look" are different
    // answers, and only one of them means the account has no funnel.
    if (unreadable) {
      return {
        ...base,
        bucket: "failed",
        note: `no bio link; ${unreadable} of ${openedCount} highlight(s) could not be read — re-run this one`,
      };
    }
    return {
      ...base,
      bucket: "none",
      note: `no bio link; ${openedCount} highlight(s) checked, none carried a link`,
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
  // Effectively no cap. The old default of 500 was an arbitrary number of mine,
  // and it did real damage: it took the FIRST 500 candidates in seed order, so a
  // 50-seed run collected 2,664 suggestions, paid a call for every seed, and
  // then threw away everything after roughly the seventh seed. Paying to gather
  // work and discarding it unasked is worse than being slow.
  const maxCandidates = Math.max(1, opts.maxCandidates || 1_000_000);

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
        `[ig-link-finder] Done. bio: ${c.bio}, signal: ${c.signal}, hlname: ${c.hlname}, ` +
          `story: ${c.story}, none: ${c.none}, private: ${c.private}, failed: ${c.failed}`,
      );
    }
  }
}
