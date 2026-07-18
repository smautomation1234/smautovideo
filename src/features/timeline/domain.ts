import type {
  Clip,
  ClipTake,
  StudioPayload,
  TimelineItem,
} from "@/lib/types";
import { TIMELINE_FPS } from "@/features/timeline/constants";

export type StudioClip = Clip & { takes: ClipTake[] };

export interface TimelineSegment {
  item: TimelineItem;
  itemId: string;
  clip: StudioClip;
  take: ClipTake | undefined;
  assetKey: string;
  trimStart: number;
  trimEnd: number;
  duration: number;
  startInTimeline: number;
  endInTimeline: number;
}

export function createInitialTimelineItems(
  studio: StudioPayload,
  fallbackFps = TIMELINE_FPS
): TimelineItem[] {
  const fps = studio.timeline?.fps || fallbackFps;
  const timelineId = studio.timeline?.id || crypto.randomUUID();
  const now = new Date().toISOString();

  return studio.clips.map((clip, index) => {
    const take = preferredTake(clip.takes);
    const sourceInFrame = Math.max(
      0,
      Math.round(Number(take?.trim_start_seconds || 0) * fps)
    );
    const sourceOutFrame = Math.max(
      sourceInFrame + 1,
      Math.round(
        Number(take?.trim_end_seconds ?? clip.duration_seconds) * fps
      )
    );
    return {
      id: crypto.randomUUID(),
      timeline_id: timelineId,
      clip_id: clip.id,
      take_id: take?.id || null,
      order_index: index,
      source_in_frame: sourceInFrame,
      source_out_frame: sourceOutFrame,
      volume: 1,
      muted: false,
      created_at: now,
      updated_at: now,
    };
  });
}

export function rescaleTimelineItemsFps(
  items: TimelineItem[],
  sourceFps: number,
  targetFps = TIMELINE_FPS
) {
  const safeSourceFps = Math.max(1, sourceFps);
  const safeTargetFps = Math.max(1, targetFps);
  if (safeSourceFps === safeTargetFps) {
    return items.map((item) => ({ ...item }));
  }
  const ratio = safeTargetFps / safeSourceFps;
  return items.map((item) => {
    const sourceInFrame = Math.max(
      0,
      Math.round(item.source_in_frame * ratio)
    );
    return {
      ...item,
      source_in_frame: sourceInFrame,
      source_out_frame: Math.max(
        sourceInFrame + 1,
        Math.round(item.source_out_frame * ratio)
      ),
    };
  });
}

export function resolveTimelineSegments(
  items: TimelineItem[],
  clips: StudioClip[],
  fps: number
): TimelineSegment[] {
  let cumulativeTime = 0;
  const segments: TimelineSegment[] = [];

  for (const item of [...items].sort((a, b) => a.order_index - b.order_index)) {
    const clip = clips.find((candidate) => candidate.id === item.clip_id);
    if (!clip) continue;
    const take =
      clip.takes.find((candidate) => candidate.id === item.take_id) ||
      preferredTake(clip.takes);
    const trimStart = item.source_in_frame / fps;
    const trimEnd = item.source_out_frame / fps;
    const duration = Math.max(1 / fps, trimEnd - trimStart);
    const startInTimeline = cumulativeTime;
    cumulativeTime += duration;
    const assetKey =
      take?.storage_path ||
      clip.source_chunk_path ||
      `${clip.id}:${take?.id || "raw"}`;

    segments.push({
      item,
      itemId: item.id,
      clip,
      take,
      assetKey,
      trimStart,
      trimEnd,
      duration,
      startInTimeline,
      endInTimeline: cumulativeTime,
    });
  }

  return segments;
}

export function normalizeTimelineItems(items: TimelineItem[]) {
  return items.map((item, orderIndex) => ({
    ...item,
    order_index: orderIndex,
  }));
}

export function duplicateTimelineItemAfter(
  items: TimelineItem[],
  source: TimelineItem,
  selectedId: string | null,
  newId = crypto.randomUUID()
) {
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId)
  );
  const now = new Date().toISOString();
  const duplicate: TimelineItem = {
    ...source,
    id: newId,
    order_index: selectedIndex + 1,
    created_at: now,
    updated_at: now,
  };
  const next = items.map((item) => ({ ...item }));
  next.splice(selectedIndex + 1, 0, duplicate);
  return {
    duplicate,
    items: normalizeTimelineItems(next),
  };
}

export function splitTimelineItemAtFrame(
  items: TimelineItem[],
  itemId: string,
  sourceFrame: number,
  newId = crypto.randomUUID()
) {
  const index = items.findIndex((item) => item.id === itemId);
  const source = items[index];
  if (
    !source ||
    sourceFrame <= source.source_in_frame ||
    sourceFrame >= source.source_out_frame
  ) {
    return null;
  }

  const now = new Date().toISOString();
  const left = { ...source, source_out_frame: sourceFrame };
  const right: TimelineItem = {
    ...source,
    id: newId,
    source_in_frame: sourceFrame,
    created_at: now,
    updated_at: now,
  };
  const next = items.map((item) => ({ ...item }));
  next.splice(index, 1, left, right);
  return {
    left,
    right,
    items: normalizeTimelineItems(next),
  };
}

function preferredTake(takes: ClipTake[]) {
  return (
    takes.find((item) => item.selected && item.status === "completed") ||
    takes.find((item) => item.status === "completed") ||
    takes[0]
  );
}
