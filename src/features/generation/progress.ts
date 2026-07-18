import type { JobStatus } from "@/lib/types";

const ACTIVE_STATUSES = new Set<JobStatus>([
  "processing",
  "submitting",
  "waiting_external",
  "retryable",
]);

export function generationProgressTarget(input: {
  status: JobStatus;
  startedAt: string | null | undefined;
  createdAt: string;
  playable: boolean;
  now?: number;
}) {
  if (input.playable && input.status === "completed") return 100;
  if (input.status === "completed") return 99;
  if (!ACTIVE_STATUSES.has(input.status)) return 0;

  const start = Date.parse(input.startedAt || input.createdAt);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(start)) return 1;
  return Math.min(99, Math.max(1, 1 + Math.floor((now - start) / 2000)));
}

export function advanceDisplayedProgress(current: number, target: number) {
  const safeCurrent = Math.max(0, Math.min(100, Math.round(current)));
  const safeTarget = Math.max(0, Math.min(100, Math.round(target)));
  if (safeCurrent === safeTarget) return safeCurrent;
  if (safeTarget < safeCurrent) return safeTarget;
  if (safeTarget < 100) return safeTarget;
  return Math.min(100, safeCurrent + Math.max(2, Math.ceil((100 - safeCurrent) / 4)));
}

