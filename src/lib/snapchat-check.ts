import { ProxyAgent, fetch as undiciFetch } from "undici";

const RATE_DELAY = 500;
// Per-request timeout and how many times we retry (rotating proxy) before
// giving up on an account. Giving up returns "error" — NEVER a false "alive".
const REQUEST_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3;

interface ProxyConfig {
  url: string;
  agent: ProxyAgent;
}

let proxies: ProxyConfig[] = [];
let proxyIndex = 0;

function parseProxy(entry: string): ProxyConfig | null {
  // Format: host:port:username:password
  // But username/password may contain colons, so we split carefully:
  // first part = host, second part = port, rest split into user:pass
  const firstColon = entry.indexOf(":");
  if (firstColon === -1) return null;

  const secondColon = entry.indexOf(":", firstColon + 1);
  if (secondColon === -1) {
    // host:port only
    const url = `http://${entry}`;
    return { url, agent: new ProxyAgent(url) };
  }

  const host = entry.substring(0, firstColon);
  const port = entry.substring(firstColon + 1, secondColon);
  const rest = entry.substring(secondColon + 1);

  // rest = username:password — find the LAST colon to split
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;

  const user = rest.substring(0, lastColon);
  const pass = rest.substring(lastColon + 1);

  const url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  console.log(`[snapchat-proxy] Parsed proxy: ${host}:${port} with user ${user.substring(0, 20)}...`);
  return { url, agent: new ProxyAgent(url) };
}

function getProxies(): ProxyConfig[] {
  if (proxies.length > 0) return proxies;

  const raw = process.env.SNAPCHAT_PROXIES || "";
  if (!raw.trim()) {
    console.log("[snapchat-proxy] No proxies configured, using direct connection");
    return [];
  }

  proxies = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseProxy)
    .filter((p): p is ProxyConfig => p !== null);

  console.log(`[snapchat-proxy] Loaded ${proxies.length} proxies`);
  return proxies;
}

function getNextProxy(): ProxyConfig | null {
  const list = getProxies();
  if (list.length === 0) return null;
  const proxy = list[proxyIndex % list.length];
  proxyIndex++;
  return proxy;
}

export interface SnapchatCheckResult {
  username: string;
  // "error" = we could not get a trustworthy answer (proxy/network/ambiguous
  // page). It must NOT be treated as alive or banned.
  status: "alive" | "banned" | "error";
  displayName: string | null;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// One raw attempt. Returns a definitive result, or null when the attempt was
// ambiguous/failed and should be retried on another proxy.
async function attemptCheck(
  username: string,
  url: string,
): Promise<SnapchatCheckResult | null> {
  const proxy = getNextProxy();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = proxy
      ? await undiciFetch(url, {
          method: "GET",
          headers: HEADERS,
          dispatcher: proxy.agent,
          signal: controller.signal,
        })
      : await fetch(url, { method: "GET", headers: HEADERS, signal: controller.signal });

    const status = response.status;
    const html = await response.text();
    console.log(`[snapchat-check] @${username} → HTTP ${status} (proxy: ${proxy ? "yes" : "no"}, len: ${html.length})`);

    // Definitive: profile removed / never existed / banned
    if (
      status === 404 ||
      html.includes('"pageType":"NOT_FOUND"') ||
      html.includes("This content was not found")
    ) {
      return { username, status: "banned", displayName: null };
    }

    // Definitive: alive requires a real profile page (200 + a positive signal).
    // This avoids misreading a block/captcha/error page as "alive".
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : "";
    const looksAlive =
      status === 200 &&
      (html.includes("Snapchat Stories") ||
        html.includes('"pageType":"PROFILE"') ||
        /\(@/.test(title));

    if (looksAlive) {
      let displayName: string | null = null;
      const nameMatch = title.match(/^(.+?)\s*\(@/);
      if (nameMatch) displayName = nameMatch[1].trim();
      return { username, status: "alive", displayName };
    }

    // 200 without profile markers, or 403/429/5xx → ambiguous, retry elsewhere
    console.warn(`[snapchat-check] @${username} ambiguous (HTTP ${status}) — will retry`);
    return null;
  } catch (err) {
    console.warn(`[snapchat-check] @${username} attempt failed:`, (err as Error)?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkSnapchatAccount(
  username: string,
): Promise<SnapchatCheckResult> {
  const url = `https://www.snapchat.com/add/${encodeURIComponent(username)}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptCheck(username, url);
    if (result) {
      console.log(`[snapchat-check] @${username} → ${result.status.toUpperCase()}${result.displayName ? ` (${result.displayName})` : ""}`);
      return result;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // All attempts ambiguous/failed — return "error", never a fake "alive"
  console.error(`[snapchat-check] @${username} → ERROR (no trustworthy result after ${MAX_ATTEMPTS} attempts)`);
  return { username, status: "error", displayName: null };
}

export async function checkMultipleAccounts(
  accounts: Array<{ id: string; username: string }>,
  onResult: (accountId: string, result: SnapchatCheckResult) => Promise<void>,
  onProgress?: (completed: number, total: number, current: string) => void,
): Promise<void> {
  for (let i = 0; i < accounts.length; i++) {
    const { id, username } = accounts[i];
    onProgress?.(i, accounts.length, username);

    const result = await checkSnapchatAccount(username);
    await onResult(id, result);

    if (i < accounts.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_DELAY));
    }
  }
  onProgress?.(accounts.length, accounts.length, "");
}
