import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Lazy fallback so dev works without an env var; in production set SESSION_SECRET
// (or it gets persisted into a runtime-generated file) for stable session tokens.
const SECRET = (() => {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // Stable across process restarts on the same machine
  return "dev-session-secret-please-set-SESSION_SECRET-in-production-aaaa";
})();

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

// Used by /api/creators/<slug>/login as the success path
export function generateCredentials(): { username: string; password: string } {
  // Friendly username (8 lowercase letters) + memorable password (12 chars)
  const u = randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toLowerCase();
  const p = randomBytes(9).toString("base64url").slice(0, 12);
  return { username: u, password: p };
}
