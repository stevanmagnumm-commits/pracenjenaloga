// Shared definitions for the Trial vs Organic section.
//
// Dependency-free on purpose, exactly like view-buckets.ts: both the server
// runner and the "use client" component import it, and pulling the runner into
// the browser bundle would drag Prisma along with it.

/**
 * How many organic reels the baseline is taken over.
 *
 * Six, matching the "Last 6" column the Views Checker already shows, so the
 * same account read on two screens is read over the same window. A trial reel
 * is days old at most; averaging it against three weeks of history would
 * compare it with a different account than the one posting now.
 */
export const ORGANIC_WINDOW = 6;

/**
 * The band, in percent either way, inside which trial and organic are called
 * the same thing.
 *
 * Twenty, and it is a presentation choice rather than a measurement: view
 * counts on a single account swing by that much between two ordinary posts, so
 * a narrower band would sort noise into "better" and "worse" piles and invite
 * conclusions the numbers do not carry. The exact percentage is always shown
 * beside the badge, so nothing is hidden by the rounding into buckets.
 */
export const TRIAL_SAME_BAND = 20;

/**
 * Three outcomes plus one reason there is no outcome.
 *
 *   worse   - the trial reels averaged clearly below the organic baseline
 *   same    - within TRIAL_SAME_BAND either way
 *   better  - clearly above
 *   failed  - one of the two sides could not be read, so there is no comparison
 *
 * "failed" is never a statement about the content. It means the provider did
 * not answer, or the account has nothing organic to compare against.
 */
export type TrialBucket = "worse" | "same" | "better" | "failed";

export const TRIAL_BUCKET_ORDER: TrialBucket[] = [
  "worse",
  "same",
  "better",
  "failed",
];

export const TRIAL_BUCKET_LABEL: Record<TrialBucket, string> = {
  worse: `Trial worse (−${TRIAL_SAME_BAND}%+)`,
  same: `About the same (±${TRIAL_SAME_BAND}%)`,
  better: `Trial better (+${TRIAL_SAME_BAND}%+)`,
  failed: "Could not compare",
};

export type TrialCounts = Record<TrialBucket, number>;

export function emptyTrialCounts(): TrialCounts {
  return { worse: 0, same: 0, better: 0, failed: 0 };
}

/**
 * The percentage the whole screen turns on: how far the trial average sits
 * from the organic one, as a share of the organic one.
 *
 * +40 means the trial reels pulled 40% more views than the account's recent
 * organic posts; −40 means 40% fewer. Null when there is nothing to divide by
 * - an organic average of zero has no percentage, and returning 0 or Infinity
 * for it would both read as a finding.
 */
export function diffPercent(
  trialAvg: number | null,
  organicAvg: number | null,
): number | null {
  if (trialAvg === null || organicAvg === null || organicAvg <= 0) return null;
  return Math.round(((trialAvg - organicAvg) / organicAvg) * 100);
}

export function bucketForDiff(diff: number | null): TrialBucket {
  if (diff === null) return "failed";
  if (diff <= -TRIAL_SAME_BAND) return "worse";
  if (diff >= TRIAL_SAME_BAND) return "better";
  return "same";
}
