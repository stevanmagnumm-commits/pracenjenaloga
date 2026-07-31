import { spawn } from "node:child_process";
import { Readable } from "node:stream";

/**
 * yt-dlp backend for the TikTok downloader.
 *
 * It talks to tiktok.com directly instead of going through RapidAPI, so it costs
 * nothing and has no daily cap. It also returns better files: the provider's
 * `download/video` endpoint hands back a single re-encoded rendition, while yt-dlp
 * picks the original 1080p source. Every format TikTok exposes here is the clean
 * one — there is no watermarked variant on this path, which is why a watermarked
 * download still falls back to the RapidAPI provider.
 *
 * The trade-off is that yt-dlp has to be kept current: TikTok changes its page
 * format every few months and an outdated binary starts failing on every link.
 * `deploy/update-ytdlp.sh` (run weekly by cron) handles that.
 */

const YTDLP_BIN = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

const RESOLVE_TIMEOUT = 45_000;
const DOWNLOAD_TIMEOUT = 300_000;

/** Preferred format: best progressive mp4, so no ffmpeg merge step is needed. */
const FORMAT = "best[ext=mp4]/best";

export interface YtDlpInfo {
  videoId: string;
  author: string;
  title: string;
  coverUrl: string;
  duration: number;
}

let availability: Promise<boolean> | null = null;

/** Cached one-shot probe so a missing binary doesn't cost a spawn per request. */
export function isYtDlpAvailable(): Promise<boolean> {
  if (!availability) {
    availability = new Promise<boolean>((resolve) => {
      const child = spawn(YTDLP_BIN, ["--version"]);
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }
  return availability;
}

function assertTikTokUrl(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("Not a valid URL");
  }
  if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) {
    throw new Error("Not a TikTok link");
  }
}

/** Reads metadata only — no video bytes are transferred. Takes ~2s per link. */
export async function resolveViaYtDlp(url: string): Promise<YtDlpInfo> {
  assertTikTokUrl(url);

  const json = await runCapture([
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout",
    "15",
    "-J",
    url,
  ]);

  const data = JSON.parse(json) as {
    id?: string;
    uploader?: string;
    channel?: string;
    title?: string;
    description?: string;
    thumbnail?: string;
    duration?: number;
  };

  return {
    videoId: data.id || "",
    author: data.uploader || data.channel || "",
    title: data.title || data.description || "",
    coverUrl: data.thumbnail || "",
    duration: Math.round(data.duration || 0),
  };
}

/**
 * Pipes the mp4 straight from yt-dlp's stdout to the HTTP response, so nothing
 * is ever written to disk. The length isn't known up front, hence no
 * Content-Length on the streaming route.
 */
export async function streamViaYtDlp(url: string): Promise<ReadableStream<Uint8Array>> {
  assertTikTokUrl(url);

  const child = spawn(YTDLP_BIN, [
    "--no-warnings",
    "--no-progress",
    "--no-playlist",
    "--socket-timeout",
    "15",
    "-f",
    FORMAT,
    "-o",
    "-",
    url,
  ]);

  const timer = setTimeout(() => child.kill("SIGKILL"), DOWNLOAD_TIMEOUT);
  child.on("close", () => clearTimeout(timer));

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // Keep only the tail; a failing run can be chatty.
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.on("close", (code) => {
    if (code !== 0) console.error(`[tiktok:ytdlp] stream exited ${code}: ${stderr.trim()}`);
  });

  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

/** Runs yt-dlp and buffers stdout, rejecting on non-zero exit or timeout. */
function runCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("yt-dlp timed out"));
    }, RESOLVE_TIMEOUT);

    const finish = (err: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));

    child.on("error", () => finish(new Error("yt-dlp is not installed on this server")));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) finish(null, stdout);
      else finish(new Error(cleanError(stderr) || `yt-dlp exited with code ${code}`));
    });
  });
}

/** Turns yt-dlp's stderr into something worth showing a user. */
function cleanError(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .pop();
  if (!line) return "";

  const msg = line.replace(/^ERROR:\s*/, "").replace(/^\[\w+\]\s*[\w.-]+:\s*/, "");
  if (/private|login required/i.test(msg)) return "Video is private";
  if (/not available|removed|404/i.test(msg)) return "Video is unavailable or removed";
  return msg.slice(0, 200);
}
