// Optional platform modules. Enabled by default; set the matching env var to
// "false" for a deployment that should hide that section. Each instance builds
// with its own .env, so these flags are baked in per-instance.
//
// NEXT_PUBLIC_* so the value is inlined into client components (the sidebar)
// at build time and is also readable server-side (page guards + cron).
export const ENABLE_THREADS = process.env.NEXT_PUBLIC_ENABLE_THREADS !== "false";
export const ENABLE_TIKTOK = process.env.NEXT_PUBLIC_ENABLE_TIKTOK !== "false";
export const ENABLE_SNAPCHAT = process.env.NEXT_PUBLIC_ENABLE_SNAPCHAT !== "false";

// Server-access / login monitoring page (/security). OFF by default; enabled
// only on the instance that should expose it (set NEXT_PUBLIC_ENABLE_SECURITY=true).
export const ENABLE_SECURITY = process.env.NEXT_PUBLIC_ENABLE_SECURITY === "true";
