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
  hasForeignLangHighlight,
  hasForeignLangBio,
} from "./link-signals";

import {
  saveJson,
  loadJson,
  readLines,
  removeFiles,
  ResultLog,
} from "./run-state";
import {
  primeSeen,
  seenBefore,
  recordSeen,
  flushSeen,
  seenCount,
  wasGood,
} from "./seen-accounts";
import {
  primeSeedHistory,
  seedAskedRecently,
  recordSeedUse,
  flushSeedHistory,
  SEED_TTL_DAYS,
} from "./seed-history";

/** Names of the two files a run leaves behind so a restart can pick it up. */
const WORK_FILE = "link-finder-work.json";
const RESULTS_FILE = "link-finder-results.jsonl";

interface SavedWork {
  seeds: string[];
  checkHighlights: boolean;
  work: Candidate[];
  startedAt: number;
  seedsTotal: number;
}

export interface ResumableRun {
  total: number;
  done: number;
  remaining: number;
  seedsTotal: number;
  startedAt: number;
  checkHighlights: boolean;
}

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
  | "wronglang"
  | "seen"
  | "known"
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
  /** Seeds passed over because they were asked within the last few days. */
  seedsSkipped: number;
  /** Epoch ms, kept on the server so reopening the page does not restart the
   *  clock. checkStartedAt is separate on purpose: the checking rate must not
   *  be diluted by however long the seeding phase took before it. */
  startedAt: number | null;
  checkStartedAt: number | null;
  finishedAt: number | null;
  counts: Record<LinkBucket, number>;
  abortedReason: string | null;
  running: boolean;
  results: LinkFinderResult[];
}

const CONCURRENCY = Math.max(1, Number(process.env.IG_LINK_CONCURRENCY) || 40);

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
    wronglang: 0,
    seen: 0,
    known: 0,
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
    seedsSkipped: 0,
    startedAt: running ? Date.now() : null,
    checkStartedAt: null,
    finishedAt: null,
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
    progress.finishedAt = Date.now();
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

  // Already answered for, in this run or any run before it — so not asked
  // again. This is checked before the profile call, which means a repeat costs
  // nothing at all rather than the 2.4 calls it used to.
  const before = seenBefore(cand.username);
  if (before) {
    const days = Math.floor((Date.now() - before.t) / 86_400_000);
    const when = days === 0 ? "today" : `${days}d ago`;
    // Two different reasons to skip, and they must not share a bucket.
    //
    // An account that already qualified stays qualified — it does not stop
    // running a funnel — so it is carried into the good pile without a single
    // call, marked as carried rather than freshly checked. Anything else is
    // only skipped while its verdict is still fresh; once that lapses the
    // account comes back as new, because an empty bio can gain a link.
    return wasGood(before.b)
      ? { ...base, bucket: "known", note: `checked before (${when}) — was: ${before.b}` }
      : { ...base, bucket: "seen", note: `already checked ${when} — was: ${before.b}` };
  }

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

    // Latin letters, but not this search's language. Placed above the bio-link
    // check on purpose: "mira mis destacadas" beside a linktr.ee is a funnel,
    // and a funnel aimed somewhere else — so the account is dropped for the
    // Spanish rather than admitted for the link, exactly as "Link Aqui 🔥" is
    // dropped in the highlights.
    if (hasForeignLangBio(base.biography)) {
      return {
        ...base,
        bucket: "wronglang",
        note: "bio in Spanish/Portuguese/Italian/French — skipped",
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

    /**
     * Open up to MAX_HIGHLIGHTS of these, stopping at the first link.
     *
     * Every highlight reaching here is plainly named: an account with a telling
     * title has already been qualified and returned, so there is nothing to
     * sort and no name worth spending an extra call on. This is the blind
     * search, and MAX_HIGHLIGHTS is a hard cap on it.
     */
    const tryHighlights = async (list: HighlightRef[]): Promise<boolean> => {
      for (const h of list) {
        if (!isActive()) break;
        if (openedCount >= MAX_HIGHLIGHTS) break;
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
    /** A name that announces the funnel IS the verdict — see below. */
    const qualifiedByName = (hits: string[]): LinkFinderResult => ({
      ...base,
      bucket: "hlname",
      note: `highlight named: ${hits.slice(0, 4).join(", ")}`,
    });

    let highlights = await fetchHighlights(cand.username);
    base.highlightTitles = highlights.map((h) => h.title).filter(Boolean);

    // Before the qualifying names, not after. "Aqui" is the strongest funnel
    // word in the data — and it is Portuguese, so the funnel it marks runs to a
    // Brazilian audience this search is not for. An account whose highlight
    // reads "Link Aqui 🔥" must be dropped for the aqui, not admitted for the
    // link. Nothing is opened either way.
    // The bio said nothing about the alphabet because there was no bio. A
    // travel account with 421,669 followers and highlights reading "China 5.0",
    // "Bali✈️", "Belarus 🇧🇾" and "Ламинирование 🥰" reached the qualifying
    // names and passed on the emoji — the script filter had only ever looked at
    // the bio, and an empty bio told it nothing. The names are the other place
    // an account writes in its own alphabet.
    const foreignTitle = base.highlightTitles.find(hasForeignScript);
    if (foreignTitle) {
      return {
        ...base,
        bucket: "wrongscript",
        note: `highlight not in Latin script: ${foreignTitle.slice(0, 40)}`,
      };
    }

    if (hasForeignLangHighlight(base.highlightTitles)) {
      return {
        ...base,
        bucket: "wronglang",
        note: `highlight in Spanish/Portuguese — skipped`,
      };
    }

    let namedHits = base.highlightTitles.filter(isFunnelHighlightTitle);

    // Stop here when a name already answered the question.
    //
    // Opening that highlight could only move the account from "highlight says
    // so" to "link in highlight", and both are kept — so the call buys a URL
    // and never a verdict. Measured across 49,902 accounts: 3,320 qualified on
    // a name and cost 3,508 opens between them, not one of which changed
    // whether the account was good.
    //
    // The price is that those accounts carry no link, only the name that earned
    // them. That is a deliberate trade: the URL is worth less here than the
    // calls it costs.
    if (namedHits.length) return qualifiedByName(namedHits);

    let found = highlights.length ? await tryHighlights(highlights) : false;

    // The list arrives truncated about four times in ten, and the entry it drops
    // is the one that matters — so a second look is worth it, but only when the
    // first found nothing. (No need to test the names again: a telling one
    // would have returned above.)
    if (!found && isActive()) {
      const second = await fetchHighlights(cand.username);
      const fresh = second.filter((h) => !seenIds.has(h.id));
      if (fresh.length) {
        base.highlightTitles = [
          ...new Set([...base.highlightTitles, ...fresh.map((h) => h.title).filter(Boolean)]),
        ];
        if (hasForeignLangHighlight(base.highlightTitles)) {
          return { ...base, bucket: "wronglang", note: `highlight in Spanish/Portuguese — skipped` };
        }
        namedHits = base.highlightTitles.filter(isFunnelHighlightTitle);
        // A telling name that only the second list revealed: same rule, and the
        // reason the second look is paid for at all.
        if (namedHits.length) return qualifiedByName(namedHits);
        found = await tryHighlights(fresh);
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

  progress = freshProgress(true, cleanSeeds.length);
  await removeFiles(WORK_FILE, RESULTS_FILE);

  const isActive = () => progress.running && runToken === myToken && !quotaAbort;

  try {
    // Phase 1 — collect suggestions. One call per seed, ~80 accounts each, and
    // one call only: a seed that answers with nothing is taken at its word.
    //
    // Seeds run through the same pool as the checking phase. Measured on the
    // same 40 seeds three times — sequential, parallel, sequential — the
    // returns were 1520, 1531 and 1461 suggestions with 18, 18 and 19 empty
    // seeds: the two sequential passes differ from each other by more than
    // either differs from parallel, so pacing buys nothing here. What it costs
    // is hours — 4,761 seeds take about eight sequentially against five minutes
    // in the pool.
    //
    // Both knobs stay as environment variables so this needs no deploy to
    // revisit.
    const SEED_CONCURRENCY = Math.max(
      1,
      Number(process.env.IG_SEED_CONCURRENCY) || CONCURRENCY,
    );
    const SEED_DELAY = Number(process.env.IG_SEED_DELAY ?? 0);

    const seen = new Set(cleanSeeds);
    const candidates: Candidate[] = [];

    const knownSeeds = await primeSeedHistory();
    console.log(
      `[ig-link-finder] ${knownSeeds} seeds asked within the last ${SEED_TTL_DAYS}d`,
    );

    await pool(cleanSeeds, SEED_CONCURRENCY, isActive, async (seed) => {
      progress.current = seed;

      // Asked recently, so not asked again. A seed's suggestion list barely
      // moves day to day: the seeds that were most productive in an early run
      // still return 78-80 suggestions today, of which 89% are accounts already
      // known, and one returned 79 with not a single new one among them. The
      // call is the whole cost of a seed, and this is how it stops being spent
      // on an answer we already have.
      const asked = seedAskedRecently(seed);
      if (asked) {
        progress.seedsSkipped++;
        progress.seedsDone++;
        return;
      }

      try {
        const suggested = await fetchSimilarAccounts(seed);
        recordSeedUse(seed);
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
      } catch (err) {
        noteIfQuotaDead(err);
        console.error(`[ig-link-finder] seed @${seed}:`, err instanceof Error ? err.message : err);
      }
      progress.seedsDone++;
      // Visible while collecting, so the screen shows the pile growing rather
      // than 0 until the whole phase ends.
      progress.total = candidates.length;
      if (SEED_DELAY > 0 && isActive()) await sleep(SEED_DELAY);
    });

    const work = candidates.slice(0, maxCandidates);
    progress.total = work.length;
    console.log(
      `[ig-link-finder] ${work.length} candidates from ${cleanSeeds.length} seed(s); ` +
        `highlights ${checkHighlights ? "on" : "off"}`,
    );

    // On disk before the first account is checked. This is the file whose
    // absence cost a 61%-complete run its remaining 17,362 targets.
    await saveJson(WORK_FILE, {
      seeds: cleanSeeds,
      checkHighlights,
      work,
      startedAt: progress.startedAt ?? Date.now(),
      seedsTotal: cleanSeeds.length,
    } satisfies SavedWork);

    await checkPhase(work, checkHighlights, myToken);
  } catch (err) {
    console.error("[ig-link-finder] Batch error:", err);
    finishRun(myToken);
  }
}

/**
 * Phase 2 — inspect each candidate. Shared by a fresh run and a resumed one, so
 * the two cannot drift apart in behaviour.
 */
async function checkPhase(
  work: Candidate[],
  checkHighlights: boolean,
  myToken: number,
): Promise<void> {
  const isActive = () => progress.running && runToken === myToken && !quotaAbort;
  const log = new ResultLog<LinkFinderResult>(RESULTS_FILE);

  const known = await primeSeen();
  console.log(`[ig-link-finder] ${known} accounts already known from earlier runs`);

  progress.phase = "checking";
  progress.checkStartedAt = Date.now();

  const finalize = (r: LinkFinderResult) => {
    if (!isActive()) return;
    progress.results.push(r);
    if (r.bucket in progress.counts) progress.counts[r.bucket]++;
    progress.completed++;
    log.add(r);
    // So no later run ever pays for this account again.
    if (r.bucket !== "seen") recordSeen(r.username, r.bucket);
  };

  try {
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
    console.error("[ig-link-finder] Check phase error:", err);
  } finally {
    await log.flush();
    await flushSeen();
    await flushSeedHistory();
    console.log(`[ig-link-finder] ${seenCount()} accounts now known`);
    const completed = finishRun(myToken);
    // Only a run that actually reached the end of its work list gives up its
    // state file. A stop, a crash or a quota abort keeps it, so it can resume.
    if (completed && progress.completed >= progress.total) {
      await removeFiles(WORK_FILE, RESULTS_FILE);
    }
  }
}

function finishRun(myToken: number): boolean {
  if (runToken !== myToken) return false;
  progress.current = null;
  progress.running = false;
  progress.phase = "done";
  progress.finishedAt = Date.now();
  progress.abortedReason = quotaAbort;
  const c = progress.counts;
  // Every bucket, in the order the UI shows them. The old line listed seven of
  // eleven, so the two that skip work entirely and the two that reject an
  // account outright were invisible in the logs — which is where you look when
  // a run's numbers do not add up.
  console.log(
    `[ig-link-finder] Done. ` +
      (Object.keys(c) as LinkBucket[]).map((b) => `${b}: ${c[b]}`).join(", "),
  );
  return true;
}

/**
 * What a restart left behind, if anything — the figures the UI needs to offer a
 * resume. Null when there is nothing to continue.
 */
export async function getResumableRun(): Promise<ResumableRun | null> {
  if (progress.running) return null;
  const saved = await loadJson<SavedWork>(WORK_FILE);
  if (!saved?.work?.length) return null;
  const done = await readLines<LinkFinderResult>(RESULTS_FILE);
  const remaining = saved.work.length - done.length;
  if (remaining <= 0) return null;
  return {
    total: saved.work.length,
    done: done.length,
    remaining,
    seedsTotal: saved.seedsTotal,
    startedAt: saved.startedAt,
    checkHighlights: saved.checkHighlights,
  };
}

/**
 * Pick an interrupted run back up. The suggestions are not fetched again — the
 * whole point — and the accounts already answered for are replayed into the
 * results so the screen and the download are whole, not just the tail.
 */
export async function resumeLinkFinder(): Promise<boolean> {
  if (progress.running) return false;

  const saved = await loadJson<SavedWork>(WORK_FILE);
  if (!saved?.work?.length) return false;

  const done = await readLines<LinkFinderResult>(RESULTS_FILE);
  const answered = new Set(done.map((r) => r.username.toLowerCase()));
  const remaining = saved.work.filter((c) => !answered.has(c.username.toLowerCase()));

  if (!remaining.length) {
    await removeFiles(WORK_FILE, RESULTS_FILE);
    return false;
  }

  const myToken = ++runToken;
  quotaAbort = null;

  progress = freshProgress(true, saved.seedsTotal);
  progress.startedAt = saved.startedAt; // the original clock, not this restart
  progress.seedsDone = saved.seedsTotal; // collecting is behind us
  progress.total = saved.work.length;

  for (const r of done) {
    progress.results.push(r);
    if (r.bucket in progress.counts) progress.counts[r.bucket]++;
  }
  progress.completed = done.length;

  console.log(
    `[ig-link-finder] Resuming: ${done.length} already answered, ${remaining.length} to go`,
  );

  void checkPhase(remaining, saved.checkHighlights, myToken);
  return true;
}
