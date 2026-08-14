import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Lazy fallback so dev works without an env var; in production set SESSION_SECRET
// (or it gets persisted into a runtime-generated file) for stable session tokens.
const SECRET = (() => {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    // Every session token would be forgeable by anyone reading this source.
    console.error(
      "[creator-auth] SESSION_SECRET is missing/too short in production — " +
        "session cookies are signed with the public dev fallback. Set it in .env and restart.",
    );
  }
  // Stable across process restarts on the same machine
  return "dev-session-secret-please-set-SESSION_SECRET-in-production-aaaa";
})();

// Session cookies must never travel over plain HTTP in production. Both live
// sites are HTTPS-only (nginx 301s :80), so this costs nothing there, and stays
// off locally where dev runs on http://localhost.
export const COOKIE_SECURE = process.env.NODE_ENV === "production";

export const ADMIN_COOKIE = "creator_admin_session";
export const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function creatorCookieName(creatorId: string): string {
  // Sanitize: only allow safe chars (Set-Cookie's reserved chars are limited)
  const safe = creatorId.replace(/[^a-zA-Z0-9_]/g, "");
  return `creator_session_${safe}`;
}
export const CREATOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

interface SessionPayload {
  role: "admin" | "creator";
  creatorId?: string;
  issuedAt: number;
}

function sign(payload: SessionPayload): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    return decoded;
  } catch {
    return null;
  }
}

export function issueAdminToken(): string {
  return sign({ role: "admin", issuedAt: Date.now() });
}

export function issueCreatorToken(creatorId: string): string {
  return sign({ role: "creator", creatorId, issuedAt: Date.now() });
}

export async function getCurrentRole(creatorId?: string): Promise<"admin" | "creator" | null> {
  const jar = await cookies();
  const adminToken = jar.get(ADMIN_COOKIE)?.value;
  const adminPayload = verify(adminToken);
  if (adminPayload?.role === "admin") return "admin";
  if (creatorId) {
    const cToken = jar.get(creatorCookieName(creatorId))?.value;
    const cPayload = verify(cToken);
    if (cPayload?.role === "creator" && cPayload.creatorId === creatorId) {
      return "creator";
    }
  }
  return null;
}

/**
 * True only for the panel owner (admin session cookie present and valid).
 *
 * The admin cookie is issued by GET /api/creators, which sits behind nginx
 * basic auth — so holding it means the browser passed the dashboard login at
 * least once.
 */
export async function isAdmin(): Promise<boolean> {
  return (await getCurrentRole()) === "admin";
}

/**
 * Authorization gate for everything under a single creator's sheet.
 *
 *   admin           → any creator
 *   logged-in creator → only their own creatorId
 *   nobody          → false
 *
 * Pass no creatorId to ask "may this caller act across ALL creators?" — only
 * the admin may.
 */
export async function canAccessCreator(creatorId?: string | null): Promise<boolean> {
  if (!creatorId) return (await getCurrentRole()) === "admin";
  return (await getCurrentRole(creatorId)) !== null;
}

/**
 * Constant-time string comparison for secrets. A plain `!==` leaks how many
 * leading characters matched through response timing; over a network that is
 * mostly theoretical, but the credential here is short and shared, so there's
 * no reason to hand out the hint.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Used by /api/creators/<slug>/login as the success path
export function generateCredentials(): { username: string; password: string } {
  // Friendly username (8 lowercase letters) + memorable password (12 chars)
  const u = randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toLowerCase();
  const p = randomBytes(9).toString("base64url").slice(0, 12);
  return { username: u, password: p };
}
