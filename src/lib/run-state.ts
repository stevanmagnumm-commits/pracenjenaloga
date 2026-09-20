import { promises as fs } from "fs";
import path from "path";

/**
 * Run state that survives a restart.
 *
 * Until now every checker kept its whole run in memory and nothing else. That
 * is fine for a run measured in minutes and ruinous for one measured in days:
 * a Link Finder run 61% through 44,777 accounts had its remaining 17,362
 * targets existing nowhere but the process heap, so deploying any change at all
 * meant throwing them away. The results were recoverable — the API exposes them
 * — but the list of what was still *to do* was not exposed anywhere, and code
 * to save it could not help, because shipping that code required the restart
 * that destroyed it.
 *
 * So: the work list is written once, when it is built, and results are appended
 * as they land. Two files rather than one snapshot, because a snapshot of a
 * 44,777-entry run is ~12MB and rewriting it every few seconds is a lot of disk
 * for nothing, while an append is cheap and loses at most one flush.
 *
 * The directory lives outside the repo by default so a deploy that resets the
 * working tree cannot take the state with it.
 */

const STATE_DIR =
  process.env.IG_STATE_DIR || path.join(process.cwd(), "..", "tracker-run-state");

async function ensureDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

const filePath = (name: string) => path.join(STATE_DIR, name);

/** Replace a file atomically, so a crash mid-write cannot leave a torn file. */
export async function saveJson(name: string, data: unknown): Promise<void> {
  try {
    await ensureDir();
    const tmp = filePath(`${name}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, filePath(name));
  } catch (err) {
    console.error(`[run-state] could not save ${name}:`, err);
  }
}

export async function loadJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath(name), "utf8")) as T;
  } catch {
    return null;
  }
}

export async function appendLines(name: string, rows: unknown[]): Promise<void> {
  if (!rows.length) return;
  try {
    await ensureDir();
    await fs.appendFile(
      filePath(name),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
  } catch (err) {
    console.error(`[run-state] could not append to ${name}:`, err);
  }
}

/** Reads a JSONL file, skipping any trailing partial line from a hard kill. */
export async function readLines<T>(name: string): Promise<T[]> {
  try {
    const text = await fs.readFile(filePath(name), "utf8");
    const out: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A process killed mid-append leaves one unparseable line. Drop it.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeFiles(...names: string[]): Promise<void> {
  await Promise.all(
    names.map((n) => fs.rm(filePath(n), { force: true }).catch(() => {})),
  );
}

/**
 * Buffers appends so a fast run does not turn into one disk write per account,
 * while never holding more than `flushMs` of work that a crash could lose.
 */
export class ResultLog<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly name: string,
    private readonly flushMs = 3_000,
    private readonly maxBuffer = 200,
  ) {}

  add(row: T): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxBuffer) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const rows = this.buffer;
    this.buffer = [];
    await appendLines(this.name, rows);
  }
}

export function stateDir(): string {
  return STATE_DIR;
}
