import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which tool a given API call belongs to, and what share of the budget it may
 * use while another tool is working.
 *
 * The limiter in rate-limit.ts holds one ceiling for the whole app, which stops
 * the app going over the plan but says nothing about who gets the budget. Two
 * tools running together simply race, and the loser is whichever one asks
 * second: a views run started while the link finder was working got answers
 * like "Profile data not found. Received 429 Too Many Requests." and filed 70
 * live accounts as confirmed bans.
 *
 * So a second tool is not stopped, it is put on a trickle. The link finder is
 * the long job — hours, sometimes a day — and is treated as the one that owns
 * the budget; anything started beside it runs at SHARED_RATE calls a minute
 * until the finder is done.
 *
 * The lane travels with the work rather than being passed as an argument.
 * Every call goes through one fetch helper several layers below the tool that
 * wanted it, and threading a parameter down to it would mean touching every
 * function in between — where one missed call site is an untagged call, which
 * is exactly the silent kind of mistake this is meant to prevent.
 */

export type Lane = "finder" | "views" | "ban" | "account" | "refresh" | "other";

const current = new AsyncLocalStorage<Lane>();

/** Lane -> how many runs of it are in flight. Counted, not a flag, so two
 *  overlapping runs of the same tool cannot clear each other's mark. */
const inFlight = new Map<Lane, number>();

/**
 * What a tool gets while the finder is working.
 *
 * Ten a minute, because that is what one worker produces on its own: the
 * provider answers in about six seconds, so a single request at a time comes
 * to roughly ten a minute without anything having to wait for a slot. Reaching
 * the share by pacing rather than by queueing is the point — see the note on
 * concurrency in ig-views-check.ts.
 */
const SHARED_PER_MIN = Math.max(
  1,
  Number(process.env.IG_SHARED_RATE_PER_MIN) || 10,
);

/** The lane that owns the budget. Everything else yields to it. */
const PRIMARY: Lane = "finder";

export function runInLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  inFlight.set(lane, (inFlight.get(lane) ?? 0) + 1);
  const done = () => {
    const left = (inFlight.get(lane) ?? 1) - 1;
    if (left > 0) inFlight.set(lane, left);
    else inFlight.delete(lane);
  };
  let out: Promise<T>;
  try {
    out = current.run(lane, fn);
  } catch (err) {
    done();
    throw err;
  }
  return out.then(
    (v) => {
      done();
      return v;
    },
    (err) => {
      done();
      throw err;
    },
  );
}

/** The lane of the work asking, or "other" for anything not run in one. */
export function currentLane(): Lane {
  return current.getStore() ?? "other";
}

export function laneBusy(lane: Lane): boolean {
  return (inFlight.get(lane) ?? 0) > 0;
}

/**
 * Calls per minute this lane may use right now, or null for the full budget.
 *
 * The primary lane is never capped below the app ceiling, and nothing is capped
 * while the primary lane is idle — so with one tool running, behaviour is
 * exactly what it was before any of this existed.
 */
export function laneCeiling(lane: Lane = currentLane()): number | null {
  if (lane === PRIMARY) return null;
  return laneBusy(PRIMARY) ? SHARED_PER_MIN : null;
}

/** For the screen: say whether a tool is on a trickle, and why. */
export function laneStatus(lane: Lane): {
  ceiling: number | null;
  heldBy: Lane | null;
} {
  const ceiling = laneCeiling(lane);
  return { ceiling, heldBy: ceiling === null ? null : PRIMARY };
}

/**
 * How many workers a lane should use, given what it would use alone.
 *
 * One, while another tool owns the budget - because the share has to be
 * reached by pacing, not by queueing. Forty workers against ten calls a minute
 * would each sit minutes waiting for a slot, and the per-account deadlines in
 * the checkers (two minutes to triage, three to confirm) would fire on
 * accounts nobody had looked at yet and file them as failures. That is the
 * same shape of bug as the one this whole change is here to stop: a result
 * that is wrong rather than slow.
 *
 * One worker against a six-second answer comes to about ten calls a minute on
 * its own, so nothing queues and no deadline is touched.
 */
export function laneWorkers(lane: Lane, full: number): number {
  return laneCeiling(lane) === null ? Math.max(1, full) : 1;
}

export const SHARED_RATE = SHARED_PER_MIN;

/** Test seam only. */
export function __resetLanesForTest(): void {
  inFlight.clear();
}
