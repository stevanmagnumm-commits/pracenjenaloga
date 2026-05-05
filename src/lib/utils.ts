import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function parseInstagramUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");

  const urlPatterns = [
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)\/?/,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reel\/([a-zA-Z0-9_-]+)\/?/,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/p\/([a-zA-Z0-9_-]+)\/?/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  if (/^[a-zA-Z0-9._]+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function parseThreadsUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "").replace(/^@/, "");

  const urlPatterns = [
    /(?:https?:\/\/)?(?:www\.)?threads\.net\/@?([a-zA-Z0-9._]+)\/?/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  if (/^[a-zA-Z0-9._]+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

export function formatEngagementRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
