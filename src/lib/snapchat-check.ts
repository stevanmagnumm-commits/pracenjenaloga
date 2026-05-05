import { ProxyAgent, fetch as undiciFetch } from "undici";

const RATE_DELAY = 500;

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
  status: "alive" | "banned";
  displayName: string | null;
}

export async function checkSnapchatAccount(
  username: string,
): Promise<SnapchatCheckResult> {
  const url = `https://www.snapchat.com/add/${encodeURIComponent(username)}`;
  const proxy = getNextProxy();

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  try {
    const response = proxy
      ? await undiciFetch(url, {
          method: "GET",
          headers,
          dispatcher: proxy.agent,
        })
      : await fetch(url, { method: "GET", headers });

    console.log(`[snapchat-check] @${username} → HTTP ${response.status} (proxy: ${proxy ? "yes" : "no"})`);

    const html = await response.text();

    const isBanned =
      response.status === 404 ||
      html.includes('"pageType":"NOT_FOUND"') ||
      html.includes("This content was not found");

    if (isBanned) {
      console.log(`[snapchat-check] @${username} → BANNED`);
      return { username, status: "banned", displayName: null };
    }

    let displayName: string | null = null;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const nameMatch = titleMatch[1].match(/^(.+?)\s*\(@/);
      if (nameMatch) {
        displayName = nameMatch[1].trim();
      }
    }

    console.log(`[snapchat-check] @${username} → ALIVE (display: ${displayName || "n/a"})`);
    return { username, status: "alive", displayName };
  } catch (err) {
    console.error(`[snapchat-check] Error checking @${username}:`, err);
    // Network error — don't mark as banned, mark as alive (safe fallback)
    return { username, status: "alive", displayName: null };
  }
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
