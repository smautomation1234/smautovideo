"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { ClipTake, StudioPayload, TimelineItem } from "@/lib/types";
import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
} from "mediabunny";
import {
  clearEditorMediaCache,
  getCachedMedia,
  getEditorStorageEstimate,
} from "@/lib/editor-media-cache";
import {
  createInitialTimelineItems,
  duplicateTimelineItemAfter,
  rescaleTimelineItemsFps,
  resolveTimelineSegments,
  splitTimelineItemAtFrame,
  type TimelineSegment,
} from "@/features/timeline/domain";
import {
  frameCountToSeconds,
  storedToVisibleFrameRange,
  validateVisibleFrameRange,
} from "@/features/timeline/frame-range";
import {
  advanceDisplayedProgress,
  generationProgressTarget,
} from "@/features/generation/progress";
import {
  exportFileName,
  exportTimelineVideo,
  type ExportTimelineClip,
} from "@/features/timeline/export-video";
import { TIMELINE_FPS } from "@/features/timeline/constants";
import {
  calculateTrimPreviewRange,
  type TrimEdge,
} from "@/features/timeline/trim-preview";

interface ActiveTrimPreview {
  itemId: string;
  edge: TrimEdge;
  initialSourceInFrame: number;
  initialSourceOutFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
}

export function StudioClient({ initial }: { initial: StudioPayload }) {
  const sourceTimelineFps = initial.timeline?.fps || TIMELINE_FPS;
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<string | null>(null);

  // Editor states
  const [timelineFps] = useState(TIMELINE_FPS);
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>(
    () => {
      const sourceTimelineItems = initial.timeline?.items?.length
        ? initial.timeline.items
        : createInitialTimelineItems(initial, sourceTimelineFps);
      return (
      rescaleTimelineItemsFps(
        sourceTimelineItems,
        sourceTimelineFps,
        TIMELINE_FPS
      )
      );
    }
  );
  const timelineItemsRef = useRef<TimelineItem[]>(timelineItems);
  const timelineVersionRef = useRef(initial.timeline?.version || 1);
  const timelineAvailableRef = useRef(Boolean(initial.timeline));
  const timelineSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const legacyTimelineNeedsSaveRef = useRef(
    Boolean(initial.timeline && sourceTimelineFps !== TIMELINE_FPS)
  );
  const undoStackRef = useRef<TimelineItem[][]>([]);
  const redoStackRef = useRef<TimelineItem[][]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(
    initial.timeline?.items?.[0]?.id || null
  );
  const [playbackItemId, setPlaybackItemId] = useState<string | null>(
    initial.timeline?.items?.[0]?.id || null
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(120); // Pixels per second
  const currentTimeRef = useRef(0);
  const lastUiClockRef = useRef(0);
  const lastReactClockRef = useRef(0);

  // Filmstrip Thumbnail cache
  const [thumbnails, setThumbnails] = useState<Record<string, string[]>>({});
  const [localMediaUrls, setLocalMediaUrls] = useState<Record<string, string>>({});
  const localMediaFilesRef = useRef<Map<string, File | Blob>>(new Map());
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const mediaFrameLimitsRef = useRef<Map<string, number>>(new Map());
  const [mediaFrameCounts, setMediaFrameCounts] = useState<
    Record<string, number>
  >({});
  const [cacheStatus, setCacheStatus] = useState("Preparing local media…");
  const [cacheBytes, setCacheBytes] = useState({ usage: 0, quota: 0 });
  const [cacheProgress, setCacheProgress] = useState({
    ready: 0,
    total: 0,
    loadedBytes: 0,
    totalBytes: 0,
    failed: 0,
  });
  const [mediaCacheErrors, setMediaCacheErrors] = useState<
    Record<string, string>
  >({});
  const [cacheEpoch, setCacheEpoch] = useState(0);

  // Background Audio Integration
  const [backgroundAudioUrl, setBackgroundAudioUrl] = useState<string | null>(null);
  const [backgroundAudioName, setBackgroundAudioName] = useState<string | null>(null);
  const [originalVolume, setOriginalVolume] = useState(1.0); // 0.0 to 1.0
  const [bgAudioVolume, setBgAudioVolume] = useState(0.5); // 0.0 to 1.0

  // Refs for tracking playback and dragging
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nextVideoRef = useRef<HTMLVideoElement | null>(null);
  const visibleVideoSlotRef = useRef<0 | 1>(0);
  const playbackItemIdRef = useRef<string | null>(
    initial.timeline?.items?.[0]?.id || null
  );
  const slotLoadTokensRef = useRef<[number, number]>([0, 0]);
  const playerRequestRef = useRef(0);
  const transitionInFlightRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const currentTimeDisplayRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const bgAudioRef = useRef<HTMLAudioElement | null>(null);
  const trimAnimationFrameRef = useRef<number | null>(null);
  const pendingPointerXRef = useRef<number | null>(null);
  const timelineWheelDeltaRef = useRef(0);
  const timelineWheelFrameRef = useRef<number | null>(null);
  const trimPreviewRef = useRef<ActiveTrimPreview | null>(null);

  const dragRef = useRef<{
    type: "trimStart" | "trimEnd" | "scrub";
    clipId?: string;
    startX: number;
    initialVal: number;
    take?: ClipTake;
    duration?: number;
    initialItems?: TimelineItem[];
  } | null>(null);

  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);
  const [trimPreview, setTrimPreview] = useState<ActiveTrimPreview | null>(null);
  const clipboardItemRef = useRef<TimelineItem | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [displayedTakeProgress, setDisplayedTakeProgress] = useState<
    Record<string, number>
  >({});
  const [frameDraft, setFrameDraft] = useState({
    itemId: "",
    start: "1",
    end: "1",
  });
  const [frameRangeError, setFrameRangeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${initial.project.id}`, { cache: "no-store" });
    if (response.ok) {
      const nextData = await response.json();
      setData(nextData);
    }
  }, [initial.project.id]);

  useEffect(() => {
    const hasActiveJobs = data.jobs.some((job) =>
      ["queued", "processing", "submitting", "waiting_external", "retryable"].includes(
        job.status
      )
    );
    if (
      !["planning", "generating"].includes(data.project.state) &&
      !hasActiveJobs
    ) {
      return;
    }
    const timer = window.setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [data.jobs, data.project.state, refresh]);

  useEffect(() => {
    if (!data.timeline) return;
    timelineAvailableRef.current = true;
    if (timelineItemsRef.current.length || !data.timeline.items.length) return;
    timelineVersionRef.current = data.timeline.version;
    const canonicalItems = rescaleTimelineItemsFps(
      data.timeline.items,
      data.timeline.fps || TIMELINE_FPS,
      TIMELINE_FPS
    );
    timelineItemsRef.current = canonicalItems;
    setTimelineItems(canonicalItems);
    setActiveClipId(canonicalItems[0]?.id || null);
    playbackItemIdRef.current = canonicalItems[0]?.id || null;
    setPlaybackItemId(canonicalItems[0]?.id || null);
    if (data.timeline.fps !== TIMELINE_FPS) {
      legacyTimelineNeedsSaveRef.current = true;
    }
  }, [data.timeline]);

  const [editedPrompts, setEditedPrompts] = useState<Record<string, string>>({});
  const [livePrompts, setLivePrompts] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<"table" | "timeline">("table");

  const persistTimeline = useCallback((items: TimelineItem[]) => {
    if (!timelineAvailableRef.current) {
      setCacheStatus("Apply all Supabase migrations to enable timeline saving.");
      return Promise.resolve();
    }

    const snapshot = items.map((item, index) => ({ ...item, order_index: index }));
    const save = timelineSaveQueueRef.current.then(async () => {
      const response = await fetch(`/api/projects/${initial.project.id}/timeline`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: timelineVersionRef.current,
          fps: timelineFps,
          items: snapshot.map((item) => ({
            id: item.id,
            clip_id: item.clip_id,
            take_id: item.take_id,
            source_in_frame: item.source_in_frame,
            source_out_frame: item.source_out_frame,
            volume: Number(item.volume ?? 1),
            muted: Boolean(item.muted),
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Timeline save failed.");
      timelineVersionRef.current = Number(body.version || timelineVersionRef.current + 1);
    });
    timelineSaveQueueRef.current = save.catch(() => undefined);
    return save;
  }, [initial.project.id, timelineFps]);

  useEffect(() => {
    if (!legacyTimelineNeedsSaveRef.current || !timelineAvailableRef.current) {
      return;
    }
    legacyTimelineNeedsSaveRef.current = false;
    void persistTimeline(timelineItemsRef.current)
      .then(() => {
        setCacheStatus("Legacy timeline upgraded to native 24 FPS.");
      })
      .catch((error) => {
        legacyTimelineNeedsSaveRef.current = true;
        setCacheStatus(
          error instanceof Error
            ? error.message
            : "Could not upgrade the timeline to 24 FPS."
        );
      });
  }, [persistTimeline]);

  const applyTimeline = useCallback((
    nextItems: TimelineItem[],
    options: { history?: TimelineItem[]; persist?: boolean } = {}
  ) => {
    const normalized = nextItems.map((item, index) => ({ ...item, order_index: index }));
    if (options.history) {
      undoStackRef.current.push(options.history.map((item) => ({ ...item })));
      if (undoStackRef.current.length > 100) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
    timelineItemsRef.current = normalized;
    setTimelineItems(normalized);
    if (options.persist !== false) {
      void persistTimeline(normalized).catch((error) => {
        console.error(error);
        setCacheStatus(error instanceof Error ? error.message : "Timeline save failed.");
      });
    }
    return normalized;
  }, [persistTimeline]);

  useEffect(() => {
    timelineItemsRef.current = timelineItems;
  }, [timelineItems]);

  const handleApprove = async () => {
    setBusy("approving");
    try {
      const response = await fetch(`/api/projects/${initial.project.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts: editedPrompts }),
      });
      const resData = await response.json();
      if (!response.ok) {
        alert(resData.error || "Approval failed");
        return;
      }
      await refresh();
    } catch {
      alert("Failed to approve project");
    } finally {
      setBusy(null);
    }
  };

  const reviewClips = useMemo(() => {
    if (data.project.mode === "edit_video") {
      return data.clips.map((c) => ({
        key: c.id,
        clip_number: c.clip_number,
        duration_seconds: c.duration_seconds,
        spoken_line: c.spoken_line,
        prompt: c.prompt,
      }));
    } else {
      const planClips = data.project.prompt_plan?.clips || [];
      return planClips.map((c) => ({
        key: String(c.clip_number),
        clip_number: c.clip_number,
        duration_seconds: c.duration_seconds,
        spoken_line: c.spoken_line,
        prompt: c.prompt,
      }));
    }
  }, [data.project.mode, data.project.prompt_plan, data.clips]);

  // Handle timeline-item reordering. Duplicates have independent item IDs.
  const handleClipDragStart = (e: React.DragEvent, clipId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest(".trim-handle") || target.closest(".add-clip-btn")) {
      e.preventDefault();
      return;
    }
    setDraggedClipId(clipId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleClipDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleClipDrop = (e: React.DragEvent, targetClipId: string) => {
    e.preventDefault();
    if (!draggedClipId || draggedClipId === targetClipId) return;

    const draggedIdx = timelineItems.findIndex((item) => item.id === draggedClipId);
    const targetIdx = timelineItems.findIndex((item) => item.id === targetClipId);
    if (draggedIdx !== -1 && targetIdx !== -1) {
      const nextItems = timelineItems.map((item) => ({ ...item }));
      const [dragged] = nextItems.splice(draggedIdx, 1);
      nextItems.splice(targetIdx, 0, dragged);
      applyTimeline(nextItems, { history: timelineItems });
    }
    setDraggedClipId(null);
  };

  // Resolve timeline item instances to immutable generated media.
  const segments = useMemo(() => {
    return resolveTimelineSegments(timelineItems, data.clips, timelineFps);
  }, [data.clips, timelineItems, timelineFps]);

  const totalDuration = useMemo(() => {
    return segments.reduce((sum, seg) => sum + seg.duration, 0);
  }, [segments]);

  // Find active segment in timeline
  const activeSegment = useMemo(() => {
    return segments.find((s) => s.itemId === activeClipId) || segments[0];
  }, [segments, activeClipId]);

  const playbackSegment = useMemo(() => {
    return segments.find((s) => s.itemId === playbackItemId) || segments[0];
  }, [playbackItemId, segments]);

  const activeSourceFrameCount = activeSegment
    ? mediaFrameCounts[activeSegment.assetKey] ||
      mediaFrameLimitsRef.current.get(activeSegment.assetKey) ||
      Math.max(
        1,
        Math.round(activeSegment.clip.duration_seconds * TIMELINE_FPS)
      )
    : 1;

  useEffect(() => {
    if (!activeClipId && segments[0]) setActiveClipId(segments[0].itemId);
    if (!playbackItemId && segments[0]) {
      playbackItemIdRef.current = segments[0].itemId;
      setPlaybackItemId(segments[0].itemId);
    }
  }, [activeClipId, playbackItemId, segments]);

  const playableUrl = useCallback((segment: (typeof segments)[number] | undefined) => {
    if (!segment) return "";
    return (
      localMediaUrls[segment.assetKey] ||
      segment.take?.signed_url ||
      segment.clip.signed_source_url ||
      ""
    );
  }, [localMediaUrls]);

  const videoForSlot = useCallback((slot: 0 | 1) => {
    return slot === 0 ? videoRef.current : nextVideoRef.current;
  }, []);

  const visibleVideo = useCallback(() => {
    return videoForSlot(visibleVideoSlotRef.current);
  }, [videoForSlot]);

  const activateVideoSlot = useCallback((slot: 0 | 1) => {
    const next = videoForSlot(slot);
    const previous = videoForSlot(slot === 0 ? 1 : 0);
    if (!next) return;
    if (previous) {
      previous.classList.remove("active");
      previous.classList.add("standby");
      previous.muted = true;
    }
    next.classList.remove("standby");
    next.classList.add("active");
    next.muted = false;
    next.volume = originalVolume;
    visibleVideoSlotRef.current = slot;
  }, [originalVolume, videoForSlot]);

  const prepareVideoSlot = useCallback(async (
    slot: 0 | 1,
    segment: TimelineSegment,
    sourceTime: number
  ) => {
    const video = videoForSlot(slot);
    const url = playableUrl(segment);
    if (!video || !url) throw new Error("This clip is not available for preview yet.");

    const token = slotLoadTokensRef.current[slot] + 1;
    slotLoadTokensRef.current[slot] = token;
    const alreadyAssigned =
      video.dataset.assetKey === segment.assetKey &&
      video.dataset.sourceUrl === url &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA;
    if (!alreadyAssigned) {
      video.pause();
      video.muted = true;
      delete video.dataset.assetKey;
      delete video.dataset.itemId;
      video.src = url;
      video.dataset.sourceUrl = url;
      video.load();
      try {
        await waitForMediaEvent(video, "loadedmetadata");
      } catch (error) {
        if (slotLoadTokensRef.current[slot] === token) {
          delete video.dataset.assetKey;
          delete video.dataset.itemId;
          delete video.dataset.sourceUrl;
        }
        throw error;
      }
      video.dataset.assetKey = segment.assetKey;
    }
    if (slotLoadTokensRef.current[slot] !== token) {
      throw new Error("Preview request was replaced by a newer request.");
    }

    const safeTime = Math.max(
      segment.trimStart,
      Math.min(Math.max(segment.trimStart, segment.trimEnd - 1 / timelineFps), sourceTime)
    );
    if (Math.abs(video.currentTime - safeTime) > 1 / (timelineFps * 2)) {
      video.currentTime = safeTime;
      await waitForMediaEvent(video, "seeked");
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMediaEvent(video, "loadeddata");
    }
    await waitForPresentedFrame(video);
    if (slotLoadTokensRef.current[slot] !== token) {
      throw new Error("Preview request was replaced by a newer request.");
    }
    video.dataset.itemId = segment.itemId;
    return video;
  }, [playableUrl, timelineFps, videoForSlot]);

  const showSegmentAt = useCallback(async (
    segment: TimelineSegment,
    sourceTime: number,
    shouldPlay: boolean
  ) => {
    const request = playerRequestRef.current + 1;
    playerRequestRef.current = request;
    const currentSlot = visibleVideoSlotRef.current;
    const currentVideo = videoForSlot(currentSlot);
    const desiredUrl = playableUrl(segment);
    const currentMatches =
      currentVideo?.dataset.assetKey === segment.assetKey &&
      currentVideo.dataset.sourceUrl === desiredUrl &&
      currentVideo.readyState >= HTMLMediaElement.HAVE_METADATA;
    const targetSlot: 0 | 1 = currentMatches
      ? currentSlot
      : currentSlot === 0
      ? 1
      : 0;
    const targetVideo = await prepareVideoSlot(targetSlot, segment, sourceTime);
    if (playerRequestRef.current !== request) return;

    if (targetSlot !== currentSlot) {
      currentVideo?.pause();
      activateVideoSlot(targetSlot);
    }
    playbackItemIdRef.current = segment.itemId;
    setPlaybackItemId(segment.itemId);
    if (shouldPlay) {
      await targetVideo.play();
    } else {
      targetVideo.pause();
    }
  }, [activateVideoSlot, playableUrl, prepareVideoSlot, videoForSlot]);

  // Download each unique immutable media file once. OPFS is used when available;
  // a memory Blob is the compatibility fallback.
  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persist?.().catch(() => false);
    const allAssets = Array.from(
      new Map(
        segments
          .map((segment) => [
            segment.assetKey,
            {
              key: segment.assetKey,
              url: segment.take?.signed_url || segment.clip.signed_source_url || "",
            },
          ] as const)
      ).values()
    );
    const assets = allAssets.filter(
      (asset) => !localMediaFilesRef.current.has(asset.key)
    );
    const initiallyReady = allAssets.length - assets.length;
    setCacheProgress({
      ready: initiallyReady,
      total: allAssets.length,
      loadedBytes: 0,
      totalBytes: 0,
      failed: 0,
    });
    if (!assets.length) {
      if (segments.length) {
        setCacheStatus("All clips ready locally.");
      }
      return;
    }

    let completed = 0;
    let ready = initiallyReady;
    let failed = 0;
    let cursor = 0;
    const byteProgress = new Map<
      string,
      { loaded: number; total: number | null }
    >();
    const publishProgress = () => {
      let loadedBytes = 0;
      let totalBytes = 0;
      let hasUnknownTotal = false;
      for (const progress of byteProgress.values()) {
        loadedBytes += progress.loaded;
        if (progress.total === null) {
          hasUnknownTotal = true;
        } else {
          totalBytes += progress.total;
        }
      }
      setCacheProgress({
        ready,
        total: allAssets.length,
        loadedBytes,
        totalBytes: hasUnknownTotal ? 0 : totalBytes,
        failed,
      });
    };
    const worker = async () => {
      while (!cancelled) {
        const asset = assets[cursor];
        cursor += 1;
        if (!asset) return;
        try {
          const onProgress = (progress: {
            loaded: number;
            total: number | null;
          }) => {
            byteProgress.set(asset.key, progress);
            if (!cancelled) publishProgress();
          };
          let file: File | Blob;
          try {
            file = await getCachedMedia(asset.key, asset.url, onProgress);
          } catch (directError) {
            if (!asset.url) throw directError;
            file = await getCachedMedia(
              asset.key,
              `/api/proxy-video?url=${encodeURIComponent(asset.url)}`,
              onProgress
            );
          }
          if (cancelled) return;
          localMediaFilesRef.current.set(asset.key, file);
          const metadataInput = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
          try {
            const track = await metadataInput.getPrimaryVideoTrack();
            const stats = track ? await track.computePacketStats() : null;
            let frameCount = 0;
            if (stats?.packetCount) {
              frameCount = stats.packetCount;
            } else {
              const duration = await metadataInput.computeDuration();
              if (Number.isFinite(duration) && duration > 0) {
                frameCount = Math.max(
                  1,
                  Math.round(duration * TIMELINE_FPS)
                );
              }
            }
            if (frameCount > 0) {
              mediaFrameLimitsRef.current.set(asset.key, frameCount);
              setMediaFrameCounts((current) =>
                current[asset.key] === frameCount
                  ? current
                  : { ...current, [asset.key]: frameCount }
              );
            }
          } catch {
            mediaFrameLimitsRef.current.delete(asset.key);
          } finally {
            metadataInput.dispose();
          }
          let objectUrl = objectUrlsRef.current.get(asset.key);
          if (!objectUrl) {
            objectUrl = URL.createObjectURL(file);
            objectUrlsRef.current.set(asset.key, objectUrl);
          }
          setLocalMediaUrls((current) => ({ ...current, [asset.key]: objectUrl! }));
          setMediaCacheErrors((current) => {
            if (!current[asset.key]) return current;
            const next = { ...current };
            delete next[asset.key];
            return next;
          });
          ready += 1;
        } catch (error) {
          console.warn("Local media cache failed:", asset.key, error);
          setMediaCacheErrors((current) => ({
            ...current,
            [asset.key]:
              error instanceof Error
                ? error.message
                : "This clip could not be prepared.",
          }));
          failed += 1;
        } finally {
          completed += 1;
          if (!cancelled) {
            publishProgress();
            setCacheStatus(
              completed === assets.length
                ? failed
                  ? `${ready}/${allAssets.length} clips ready locally · ${failed} unavailable.`
                  : "All clips ready locally."
                : `Preparing clips locally · ${completed}/${assets.length}`
            );
          }
        }
      }
    };

    void Promise.all([worker(), worker()]).then(async () => {
      if (!cancelled) setCacheBytes(await getEditorStorageEstimate());
    });
    return () => {
      cancelled = true;
    };
  }, [segments, cacheEpoch]);

  useEffect(() => {
    const objectUrls = objectUrlsRef.current;
    const thumbnailUrls = thumbnailObjectUrlsRef.current;
    return () => {
      if (timelineWheelFrameRef.current !== null) {
        cancelAnimationFrame(timelineWheelFrameRef.current);
      }
      if (trimAnimationFrameRef.current !== null) {
        cancelAnimationFrame(trimAnimationFrameRef.current);
      }
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
      objectUrls.clear();
      for (const url of thumbnailUrls) URL.revokeObjectURL(url);
      thumbnailUrls.clear();
    };
  }, []);

  // Reconcile saved ranges with the media itself. Packet count is authoritative;
  // duration × 24 is used only until the file has been inspected.
  useEffect(() => {
    if (!Object.keys(mediaFrameCounts).length) return;
    const current = timelineItemsRef.current;
    const resolved = resolveTimelineSegments(current, data.clips, timelineFps);
    const segmentByItem = new Map(
      resolved.map((segment) => [segment.itemId, segment] as const)
    );
    let changed = false;
    const next = current.map((item) => {
      const segment = segmentByItem.get(item.id);
      const actualFrameCount = segment
        ? mediaFrameCounts[segment.assetKey]
        : undefined;
      if (!segment || !actualFrameCount) return item;

      const nominalFrameCount = Math.max(
        1,
        Math.round(segment.clip.duration_seconds * TIMELINE_FPS)
      );
      const sourceInFrame = Math.min(
        Math.max(0, item.source_in_frame),
        actualFrameCount - 1
      );
      const representedTheFullSource =
        item.source_in_frame === 0 &&
        item.source_out_frame === nominalFrameCount;
      const sourceOutFrame = Math.max(
        sourceInFrame + 1,
        representedTheFullSource
          ? actualFrameCount
          : Math.min(item.source_out_frame, actualFrameCount)
      );
      if (
        sourceInFrame === item.source_in_frame &&
        sourceOutFrame === item.source_out_frame
      ) {
        return item;
      }
      changed = true;
      return {
        ...item,
        source_in_frame: sourceInFrame,
        source_out_frame: sourceOutFrame,
      };
    });
    if (changed) {
      applyTimeline(next);
      setCacheStatus("Timeline ranges matched to decoded video frames.");
    }
  }, [applyTimeline, data.clips, mediaFrameCounts, timelineFps]);

  useEffect(() => {
    const updateProgress = () => {
      setDisplayedTakeProgress((current) => {
        const next = { ...current };
        let changed = false;
        for (const clip of data.clips) {
          for (const take of clip.takes) {
            const assetKey = take.storage_path || "";
            const target = generationProgressTarget({
              status: take.status,
              startedAt: take.started_at,
              createdAt: take.created_at,
              playable: Boolean(assetKey && localMediaUrls[assetKey]),
            });
            const value = advanceDisplayedProgress(
              current[take.id] ?? target,
              target
            );
            if (current[take.id] !== value) changed = true;
            next[take.id] = value;
          }
        }
        return changed ? next : current;
      });
    };
    updateProgress();
    const timer = window.setInterval(updateProgress, 100);
    return () => window.clearInterval(timer);
  }, [data.clips, localMediaUrls]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === workspaceRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!activeSegment) return;
    const visible = storedToVisibleFrameRange(
      activeSegment.item.source_in_frame,
      activeSegment.item.source_out_frame
    );
    const start = Math.min(visible.start, activeSourceFrameCount);
    const end = Math.min(
      activeSourceFrameCount,
      Math.max(start, visible.end)
    );
    setFrameDraft({
      itemId: activeSegment.itemId,
      start: String(start),
      end: String(end),
    });
    setFrameRangeError(null);
  }, [activeSegment, activeSourceFrameCount]);

  // Keep the current frame painted until the next video has decoded and
  // presented its first frame. The two players then exchange roles.
  useEffect(() => {
    if (!isPlaying) return;

    let animationFrame: number;
    const updatePlayback = () => {
      const video = visibleVideo();
      const activeSeg =
        segments.find((segment) => segment.itemId === playbackItemIdRef.current) ||
        segments[0];
      if (!video || !activeSeg) {
        animationFrame = requestAnimationFrame(updatePlayback);
        return;
      }

      const currentVideoTime = video.currentTime;
      const relativeTime = Math.max(0, currentVideoTime - activeSeg.trimStart);
      const newTimelineTime = Math.min(
        activeSeg.endInTimeline,
        activeSeg.startInTimeline + relativeTime
      );
      currentTimeRef.current = newTimelineTime;
      if (playheadRef.current) {
        playheadRef.current.style.transform =
          `translate3d(${newTimelineTime * zoomLevel}px,0,0)`;
      }
      const now = performance.now();
      if (now - lastUiClockRef.current >= 80) {
        lastUiClockRef.current = now;
        if (currentTimeDisplayRef.current) {
          currentTimeDisplayRef.current.textContent = formatTimelineTime(
            newTimelineTime,
            timelineFps
          );
        }
      }
      if (now - lastReactClockRef.current >= 1000) {
        lastReactClockRef.current = now;
        setCurrentTime(newTimelineTime);
      }

      if (
        currentVideoTime >= activeSeg.trimEnd - 1 / (timelineFps * 2) &&
        !transitionInFlightRef.current
      ) {
        const currentIndex = segments.findIndex(
          (segment) => segment.itemId === activeSeg.itemId
        );
        const nextSegment = segments[currentIndex + 1];
        transitionInFlightRef.current = true;
        video.pause();

        if (nextSegment) {
          currentTimeRef.current = nextSegment.startInTimeline;
          setCurrentTime(nextSegment.startInTimeline);
          void showSegmentAt(nextSegment, nextSegment.trimStart, true)
            .then(() => {
              setActiveClipId(nextSegment.itemId);
            })
            .catch((error) => {
              setIsPlaying(false);
              setCacheStatus(
                error instanceof Error ? error.message : "Could not prepare the next clip."
              );
            })
            .finally(() => {
              transitionInFlightRef.current = false;
            });
        } else {
          setIsPlaying(false);
          currentTimeRef.current = 0;
          setCurrentTime(0);
          if (playheadRef.current) {
            playheadRef.current.style.transform = "translate3d(0,0,0)";
          }
          const firstSegment = segments[0];
          if (firstSegment) {
            void showSegmentAt(firstSegment, firstSegment.trimStart, false)
              .then(() => setActiveClipId(firstSegment.itemId))
              .finally(() => {
                transitionInFlightRef.current = false;
              });
          } else {
            transitionInFlightRef.current = false;
          }
        }
      }

      animationFrame = requestAnimationFrame(updatePlayback);
    };

    animationFrame = requestAnimationFrame(updatePlayback);
    return () => cancelAnimationFrame(animationFrame);
  }, [
    isPlaying,
    segments,
    showSegmentAt,
    timelineFps,
    visibleVideo,
    zoomLevel,
  ]);

  // Initialize the visible slot without replacing its source when the local
  // OPFS copy becomes available halfway through playback.
  useEffect(() => {
    const segment = playbackSegment || segments[0];
    const video = visibleVideo();
    const desiredUrl = playableUrl(segment);
    if (!segment || !desiredUrl) return;
    if (
      video?.dataset.assetKey === segment.assetKey &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      (isPlaying || video.dataset.sourceUrl === desiredUrl)
    ) {
      return;
    }
    void showSegmentAt(segment, segment.trimStart, false).catch((error) => {
      setCacheStatus(
        error instanceof Error ? error.message : "Could not prepare this clip."
      );
    });
  }, [
    isPlaying,
    playableUrl,
    playbackSegment,
    segments,
    showSegmentAt,
    visibleVideo,
  ]);

  // Prime the standby slot through the first painted frame, not just metadata.
  useEffect(() => {
    const currentIndex = segments.findIndex(
      (segment) => segment.itemId === playbackItemId
    );
    const nextSegment = currentIndex >= 0 ? segments[currentIndex + 1] : undefined;
    if (!nextSegment || !playableUrl(nextSegment)) return;
    const standbySlot: 0 | 1 = visibleVideoSlotRef.current === 0 ? 1 : 0;
    const standby = videoForSlot(standbySlot);
    if (standby?.dataset.itemId === nextSegment.itemId) return;
    void prepareVideoSlot(standbySlot, nextSegment, nextSegment.trimStart).catch(
      () => undefined
    );
  }, [
    playbackItemId,
    playableUrl,
    prepareVideoSlot,
    segments,
    videoForSlot,
  ]);

  // Filmstrip thumbnails use Mediabunny's optimized monotonically-sorted decoder.
  const processingUrlsRef = useRef<Set<string>>(new Set());
  const thumbnailAttemptsRef = useRef<Map<string, number>>(new Map());
  const [thumbnailRetryEpoch, setThumbnailRetryEpoch] = useState(0);
  const [thumbnailErrors, setThumbnailErrors] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let cancelled = false;
    const retryTimers = new Set<number>();
    const generateThumbnails = async () => {
      for (const seg of segments) {
        if (cancelled) return;
        const key = seg.assetKey;
        const file = localMediaFilesRef.current.get(key);
        const existingFrames = thumbnails[key];
        const hasRealFrames = existingFrames?.some(
          (frame) => frame !== "/placeholder-avatar.svg"
        );
        if (!file || hasRealFrames || processingUrlsRef.current.has(key)) {
          continue;
        }
        processingUrlsRef.current.add(key);
        const duration = Math.max(1 / timelineFps, seg.trimEnd);
        const timestamps = Array.from(
          { length: Math.max(1, Math.ceil(duration)) },
          (_, index) => Math.min(duration - 1 / timelineFps, index)
        );
        try {
          const width = 120;
          const height = data.project.aspect_ratio === "9:16" ? 214 : 68;
          let frames: string[];
          try {
            const input = new Input({
              source: new BlobSource(file),
              formats: ALL_FORMATS,
            });
            try {
              const track = await input.getPrimaryVideoTrack();
              if (!track || !(await track.canDecode())) {
                throw new Error(
                  "WebCodecs cannot decode this track in the current browser."
                );
              }
              const sink = new CanvasSink(track, {
                width,
                height,
                fit: "cover",
                poolSize: 1,
              });
              const decodedFrames: string[] = [];
              for await (const result of sink.canvasesAtTimestamps(timestamps)) {
                if (cancelled) return;
                if (!result) {
                  throw new Error(
                    "WebCodecs returned no frame for a requested timestamp."
                  );
                }
                if (result.canvas instanceof HTMLCanvasElement) {
                  decodedFrames.push(
                    result.canvas.toDataURL("image/jpeg", 0.68)
                  );
                } else {
                  const blob = await result.canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.68,
                  });
                  const thumbnailUrl = URL.createObjectURL(blob);
                  thumbnailObjectUrlsRef.current.add(thumbnailUrl);
                  decodedFrames.push(thumbnailUrl);
                }
              }
              if (decodedFrames.length !== timestamps.length) {
                throw new Error(
                  `WebCodecs decoded ${decodedFrames.length} of ${timestamps.length} thumbnails.`
                );
              }
              frames = decodedFrames;
            } finally {
              input.dispose();
            }
          } catch (webCodecsError) {
            console.info(
              "WebCodecs thumbnail extraction unavailable; using native video fallback.",
              key,
              webCodecsError
            );
            frames = await generateNativeVideoThumbnails(
              file,
              timestamps,
              width,
              height,
              () => cancelled
            );
          }
          if (!cancelled) {
            setThumbnails((current) => ({ ...current, [key]: frames }));
            thumbnailAttemptsRef.current.delete(key);
            setThumbnailErrors((current) => {
              if (!current[key]) return current;
              const next = { ...current };
              delete next[key];
              return next;
            });
          }
        } catch (error) {
          console.warn("Could not generate timeline thumbnails:", key, error);
          const attempts = (thumbnailAttemptsRef.current.get(key) || 0) + 1;
          thumbnailAttemptsRef.current.set(key, attempts);
          if (!cancelled && attempts < 3) {
            const timer = window.setTimeout(
              () => setThumbnailRetryEpoch((value) => value + 1),
              attempts * 750
            );
            retryTimers.add(timer);
          } else if (!cancelled) {
            setThumbnailErrors((current) => ({
              ...current,
              [key]:
                error instanceof Error
                  ? error.message
                  : "Thumbnail extraction failed.",
            }));
          }
        } finally {
          processingUrlsRef.current.delete(key);
        }
      }
    };
    void generateThumbnails();
    return () => {
      cancelled = true;
      for (const timer of retryTimers) window.clearTimeout(timer);
    };
  }, [
    data.project.aspect_ratio,
    localMediaUrls,
    segments,
    thumbnailRetryEpoch,
    thumbnails,
    timelineFps,
  ]);

  // Synchronize Volumes & Playback state in real-time
  useEffect(() => {
    for (const slot of [0, 1] as const) {
      const video = videoForSlot(slot);
      if (video) video.volume = originalVolume;
    }
  }, [originalVolume, videoForSlot]);

  useEffect(() => {
    if (bgAudioRef.current) {
      bgAudioRef.current.volume = bgAudioVolume;
    }
  }, [bgAudioVolume]);

  useEffect(() => {
    if (!bgAudioRef.current) return;
    if (isPlaying) {
      bgAudioRef.current.currentTime = currentTimeRef.current;
      bgAudioRef.current.play().catch(() => {});
    } else {
      bgAudioRef.current.pause();
    }
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    const video = visibleVideo();
    if (!video) return;
    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
    } else {
      if (currentTimeRef.current >= totalDuration && segments[0]) {
        const firstSegment = segments[0];
        setActiveClipId(firstSegment.itemId);
        currentTimeRef.current = 0;
        setCurrentTime(0);
        void showSegmentAt(firstSegment, firstSegment.trimStart, true)
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
        return;
      }
      video.play().then(() => {
        setIsPlaying(true);
      }).catch(() => {});
    }
  }, [segments, showSegmentAt, totalDuration, visibleVideo]);

  const handleAudioImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setBackgroundAudioUrl(url);
    setBackgroundAudioName(file.name);
  };

  useEffect(() => {
    return () => {
      if (backgroundAudioUrl) URL.revokeObjectURL(backgroundAudioUrl);
    };
  }, [backgroundAudioUrl]);

  async function updateTake(take: ClipTake, values: Partial<ClipTake>) {
    setData((current) => ({
      ...current,
      clips: current.clips.map((clip) =>
        clip.id === take.clip_id
          ? {
              ...clip,
              takes: clip.takes.map((item) =>
                item.id === take.id
                  ? { ...item, ...values }
                  : values.selected === true
                  ? { ...item, selected: false }
                  : item
              ),
            }
          : clip
      ),
    }));
    await action(`/api/takes/${take.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  async function selectTakeForTimelineItem(itemId: string, take: ClipTake) {
    const current = timelineItemsRef.current;
    const next = current.map((item) =>
      item.id === itemId ? { ...item, take_id: take.id } : item
    );
    applyTimeline(next, { history: current });
    await updateTake(take, { selected: true });
  }

  async function selectTakeForClip(clipId: string, take: ClipTake) {
    const current = timelineItemsRef.current;
    const next = current.map((item) =>
      item.clip_id === clipId ? { ...item, take_id: take.id } : item
    );
    applyTimeline(next, { history: current });
    await updateTake(take, { selected: true });
  }

  async function regenerate(clipId: string) {
    setBusy(clipId);
    try {
      const updatedPrompt = livePrompts[clipId];
      await action(`/api/clips/${clipId}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: updatedPrompt }),
      });
      await refresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to regenerate");
    } finally {
      setBusy(null);
    }
  }

  // Pointer handlers for scrubber and two-phase trimming. During a trim drag,
  // only trimPreview changes; the committed timeline ripples on pointer release.
  const handleMouseDown = (
    e: React.PointerEvent,
    type: "trimStart" | "trimEnd" | "scrub",
    clipId?: string,
    take?: ClipTake,
    duration?: number
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (type === "scrub" && timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      const targetTime = Math.max(0, Math.min(totalDuration, x / zoomLevel));
      setCurrentTime(targetTime);
      currentTimeRef.current = targetTime;
      seekToTimelineTime(targetTime);
    }

    const timelineItem = clipId
      ? timelineItemsRef.current.find((item) => item.id === clipId)
      : undefined;
    if ((type === "trimStart" || type === "trimEnd") && !timelineItem) return;

    if (timelineItem && (type === "trimStart" || type === "trimEnd")) {
      visibleVideo()?.pause();
      setIsPlaying(false);
      const preview: ActiveTrimPreview = {
        itemId: timelineItem.id,
        edge: type === "trimStart" ? "start" : "end",
        initialSourceInFrame: timelineItem.source_in_frame,
        initialSourceOutFrame: timelineItem.source_out_frame,
        sourceInFrame: timelineItem.source_in_frame,
        sourceOutFrame: timelineItem.source_out_frame,
      };
      trimPreviewRef.current = preview;
      setTrimPreview(preview);
    }

    dragRef.current = {
      type,
      clipId,
      startX: e.clientX,
      initialVal:
        type === "trimStart"
          ? Number(timelineItem?.source_in_frame || 0)
          : type === "trimEnd"
          ? Number(timelineItem?.source_out_frame || Math.round((duration || 0) * timelineFps))
          : currentTimeRef.current,
      take,
      duration,
      initialItems:
        type === "scrub"
          ? undefined
          : timelineItemsRef.current.map((item) => ({ ...item })),
    };

    document.addEventListener("pointermove", handleMouseMove);
    document.addEventListener("pointerup", handleMouseUp);
    document.addEventListener("pointercancel", handleMouseUp);
  };

  const processPointerMove = (clientX: number) => {
    if (!dragRef.current) return;
    const deltaX = clientX - dragRef.current.startX;
    const deltaSec = deltaX / zoomLevel;

    if (dragRef.current.type === "scrub" && timelineRef.current) {
      const newTime = Math.max(
        0,
        Math.min(totalDuration, dragRef.current.initialVal + deltaSec)
      );
      setCurrentTime(newTime);
      currentTimeRef.current = newTime;
      seekToTimelineTime(newTime);
    } else if (
      (dragRef.current.type === "trimStart" || dragRef.current.type === "trimEnd") &&
      dragRef.current.clipId
    ) {
      const drag = dragRef.current;
      const itemId = drag.clipId;
      if (!itemId) return;
      const initialItem = drag.initialItems?.find(
        (candidate) => candidate.id === itemId
      );
      if (!initialItem) return;
      const deltaFrames = Math.round(deltaSec * timelineFps);
      const edge: TrimEdge = drag.type === "trimStart" ? "start" : "end";
      const range = calculateTrimPreviewRange(
        edge,
        initialItem.source_in_frame,
        initialItem.source_out_frame,
        deltaFrames
      );
      const preview: ActiveTrimPreview = {
        itemId,
        edge,
        initialSourceInFrame: initialItem.source_in_frame,
        initialSourceOutFrame: initialItem.source_out_frame,
        sourceInFrame: range.sourceInFrame,
        sourceOutFrame: range.sourceOutFrame,
      };
      trimPreviewRef.current = preview;
      setTrimPreview((current) =>
        current?.sourceInFrame === preview.sourceInFrame &&
        current.sourceOutFrame === preview.sourceOutFrame
          ? current
          : preview
      );

      const segment = segments.find((candidate) => candidate.itemId === itemId);
      const video = visibleVideo();
      if (video && segment) {
        video.currentTime =
          edge === "start"
            ? range.sourceInFrame / timelineFps
            : Math.max(0, (range.sourceOutFrame - 1) / timelineFps);
      }
    }
  };

  const handleMouseMove = (e: PointerEvent) => {
    pendingPointerXRef.current = e.clientX;
    if (trimAnimationFrameRef.current !== null) return;
    trimAnimationFrameRef.current = requestAnimationFrame(() => {
      trimAnimationFrameRef.current = null;
      const clientX = pendingPointerXRef.current;
      pendingPointerXRef.current = null;
      if (clientX !== null) processPointerMove(clientX);
    });
  };

  const handleMouseUp = async () => {
    if (trimAnimationFrameRef.current !== null) {
      cancelAnimationFrame(trimAnimationFrameRef.current);
      trimAnimationFrameRef.current = null;
    }
    if (pendingPointerXRef.current !== null) {
      processPointerMove(pendingPointerXRef.current);
      pendingPointerXRef.current = null;
    }
    const drag = dragRef.current;
    const preview = trimPreviewRef.current;
    if (drag) {
      const { type, initialItems } = drag;
      if (
        (type === "trimStart" || type === "trimEnd") &&
        initialItems &&
        preview
      ) {
        const changed =
          preview.sourceInFrame !== preview.initialSourceInFrame ||
          preview.sourceOutFrame !== preview.initialSourceOutFrame;
        if (changed) {
          const next = initialItems.map((item) =>
            item.id === preview.itemId
              ? {
                  ...item,
                  source_in_frame: preview.sourceInFrame,
                  source_out_frame: preview.sourceOutFrame,
                }
              : item
          );
          const retainedFrames =
            preview.sourceOutFrame - preview.sourceInFrame;
          applyTimeline(next, { history: initialItems });
          setCacheStatus(
            `Trim applied · ${retainedFrames} frames · ${(
              retainedFrames / timelineFps
            ).toFixed(2)}s retained.`
          );
        }
      }
    }
    trimPreviewRef.current = null;
    setTrimPreview(null);
    dragRef.current = null;
    document.removeEventListener("pointermove", handleMouseMove);
    document.removeEventListener("pointerup", handleMouseUp);
    document.removeEventListener("pointercancel", handleMouseUp);
  };

  const seekToTimelineTime = useCallback((time: number) => {
    const targetSeg = segments.find(
      (segment, index) =>
        time >= segment.startInTimeline &&
        (time < segment.endInTimeline ||
          (index === segments.length - 1 && time <= segment.endInTimeline))
    );

    if (targetSeg) {
      setActiveClipId(targetSeg.itemId);
      const relativeTime = time - targetSeg.startInTimeline;
      const targetVideoTime = targetSeg.trimStart + relativeTime;
      const wasPlaying = isPlaying;
      void showSegmentAt(targetSeg, targetVideoTime, wasPlaying).catch(
        () => undefined
      );
    }
    
    if (bgAudioRef.current) {
      bgAudioRef.current.currentTime = time;
    }
  }, [isPlaying, segments, showSegmentAt]);

  const applyVisibleFrameRange = useCallback((
    visibleStart: number,
    visibleEnd: number,
    previewBoundary: "start" | "end"
  ) => {
    const itemId = frameDraft.itemId || activeClipId;
    const selectedSegment = segments.find((segment) => segment.itemId === itemId);
    if (!itemId || !selectedSegment) return;
    const sourceFrameCount =
      mediaFrameLimitsRef.current.get(selectedSegment.assetKey) ||
      Math.max(
        1,
        Math.round(selectedSegment.clip.duration_seconds * timelineFps)
      );
    const validation = validateVisibleFrameRange(
      visibleStart,
      visibleEnd,
      sourceFrameCount
    );
    if (!validation.ok) {
      setFrameRangeError(validation.message);
      return;
    }

    const current = timelineItemsRef.current;
    const source = current.find((item) => item.id === itemId);
    if (!source) return;
    const next = current.map((item) =>
      item.id === itemId
        ? {
            ...item,
            source_in_frame: validation.stored.sourceInFrame,
            source_out_frame: validation.stored.sourceOutFrame,
          }
        : item
    );
    const changed =
      source.source_in_frame !== validation.stored.sourceInFrame ||
      source.source_out_frame !== validation.stored.sourceOutFrame;
    if (changed) applyTimeline(next, { history: current });

    const nextSegments = resolveTimelineSegments(next, data.clips, timelineFps);
    const nextSegment = nextSegments.find((segment) => segment.itemId === itemId);
    if (nextSegment) {
      const sourceFrame =
        previewBoundary === "start"
          ? validation.stored.sourceInFrame
          : validation.stored.sourceOutFrame - 1;
      const previewTimelineTime =
        nextSegment.startInTimeline +
        (sourceFrame - validation.stored.sourceInFrame) / timelineFps;
      visibleVideo()?.pause();
      setIsPlaying(false);
      currentTimeRef.current = previewTimelineTime;
      setCurrentTime(previewTimelineTime);
      void showSegmentAt(
        nextSegment,
        sourceFrame / timelineFps,
        false
      ).catch(() => undefined);
    }
    setFrameDraft({
      itemId,
      start: String(visibleStart),
      end: String(visibleEnd),
    });
    setFrameRangeError(null);
  }, [
    activeClipId,
    applyTimeline,
    data.clips,
    frameDraft.itemId,
    segments,
    showSegmentAt,
    timelineFps,
    visibleVideo,
  ]);

  const applyFrameDraft = useCallback((previewBoundary: "start" | "end") => {
    applyVisibleFrameRange(
      Number(frameDraft.start),
      Number(frameDraft.end),
      previewBoundary
    );
  }, [applyVisibleFrameRange, frameDraft.end, frameDraft.start]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (workspaceRef.current?.requestFullscreen) {
        await workspaceRef.current.requestFullscreen();
      } else {
        setCacheStatus("Fullscreen is not supported by this browser.");
      }
    } catch {
      setCacheStatus("The browser could not enter fullscreen mode.");
    }
  }, []);

  const fitTimeline = useCallback(() => {
    if (!timelineRef.current || totalDuration <= 0) return;
    const available = Math.max(320, timelineRef.current.clientWidth - 48);
    setZoomLevel(Math.max(25, Math.min(800, available / totalDuration)));
  }, [totalDuration]);

  const handleTimelineWheel = useCallback((event: React.WheelEvent) => {
    if (
      !timelineRef.current ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    ) {
      return;
    }
    event.preventDefault();
    timelineWheelDeltaRef.current += event.deltaY;
    if (timelineWheelFrameRef.current !== null) return;
    timelineWheelFrameRef.current = requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollLeft += timelineWheelDeltaRef.current;
      }
      timelineWheelDeltaRef.current = 0;
      timelineWheelFrameRef.current = null;
    });
  }, []);

  const handleTimelineClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".trim-handle") || target.closest(".add-clip-btn")) return;

    if (timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      const targetTime = Math.max(0, Math.min(totalDuration, x / zoomLevel));
      setCurrentTime(targetTime);
      currentTimeRef.current = targetTime;
      seekToTimelineTime(targetTime);
    }
  };

  const copySelectedItem = useCallback(() => {
    const selected = timelineItemsRef.current.find((item) => item.id === activeClipId);
    if (selected) {
      clipboardItemRef.current = { ...selected };
      setCacheStatus("Clip copied. Paste inserts it after the selected clip.");
    }
  }, [activeClipId]);

  const pasteAfterSelected = useCallback(() => {
    const copied = clipboardItemRef.current;
    const current = timelineItemsRef.current;
    if (!copied || !current.length) return;
    const result = duplicateTimelineItemAfter(current, copied, activeClipId);
    applyTimeline(result.items, { history: current });
    setActiveClipId(result.duplicate.id);
    const nextSegments = resolveTimelineSegments(
      result.items,
      data.clips,
      timelineFps
    );
    const duplicateSegment = nextSegments.find(
      (segment) => segment.itemId === result.duplicate.id
    );
    if (duplicateSegment) {
      currentTimeRef.current = duplicateSegment.startInTimeline;
      setCurrentTime(duplicateSegment.startInTimeline);
      void showSegmentAt(
        duplicateSegment,
        duplicateSegment.trimStart,
        false
      ).catch(() => undefined);
    }
    setCacheStatus("Pasted a new independent clip after the selection.");
    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-timeline-item="${result.duplicate.id}"]`
      );
      element?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    });
  }, [
    activeClipId,
    applyTimeline,
    data.clips,
    showSegmentAt,
    timelineFps,
  ]);

  const duplicateSelectedItem = useCallback(() => {
    const selected = timelineItemsRef.current.find((item) => item.id === activeClipId);
    if (!selected) return;
    clipboardItemRef.current = { ...selected };
    pasteAfterSelected();
  }, [activeClipId, pasteAfterSelected]);

  const deleteSelectedItem = useCallback(() => {
    const current = timelineItemsRef.current;
    const index = current.findIndex((item) => item.id === activeClipId);
    if (index < 0) return;
    const next = current.filter((item) => item.id !== activeClipId);
    applyTimeline(next, { history: current });
    setActiveClipId(next[Math.min(index, next.length - 1)]?.id || null);
  }, [activeClipId, applyTimeline]);

  const splitSelectedAtPlayhead = useCallback(() => {
    const segment = segments.find(
      (candidate) =>
        currentTimeRef.current > candidate.startInTimeline &&
        currentTimeRef.current < candidate.endInTimeline &&
        candidate.itemId === activeClipId
    );
    if (!segment) return;
    const current = timelineItemsRef.current;
    const sourceSplitFrame =
      segment.item.source_in_frame +
      Math.round((currentTimeRef.current - segment.startInTimeline) * timelineFps);
    if (
      sourceSplitFrame <= segment.item.source_in_frame ||
      sourceSplitFrame >= segment.item.source_out_frame
    ) return;
    const result = splitTimelineItemAtFrame(
      current,
      segment.itemId,
      sourceSplitFrame
    );
    if (!result) return;
    applyTimeline(result.items, { history: current });
    setActiveClipId(result.right.id);
  }, [activeClipId, applyTimeline, segments, timelineFps]);

  const undoTimeline = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    const current = timelineItemsRef.current.map((item) => ({ ...item }));
    redoStackRef.current.push(current);
    applyTimeline(previous, { persist: true });
    setActiveClipId(previous[0]?.id || null);
  }, [applyTimeline]);

  const redoTimeline = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    const current = timelineItemsRef.current.map((item) => ({ ...item }));
    undoStackRef.current.push(current);
    applyTimeline(next, { persist: true });
    setActiveClipId(next[0]?.id || null);
  }, [applyTimeline]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelectedItem();
      } else if (modifier && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteAfterSelected();
      } else if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedItem();
      } else if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        splitSelectedAtPlayhead();
      } else if (modifier && event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        redoTimeline();
      } else if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoTimeline();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedItem();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const targetTime = Math.max(
          0,
          Math.min(totalDuration, currentTimeRef.current + direction / timelineFps)
        );
        currentTimeRef.current = targetTime;
        setCurrentTime(targetTime);
        seekToTimelineTime(targetTime);
      } else if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    copySelectedItem,
    deleteSelectedItem,
    duplicateSelectedItem,
    pasteAfterSelected,
    redoTimeline,
    seekToTimelineTime,
    splitSelectedAtPlayhead,
    timelineFps,
    togglePlay,
    totalDuration,
    undoTimeline,
  ]);

  async function createScene() {
    const missingSegments = segments.filter(
      (segment) =>
        !localMediaFilesRef.current.has(segment.assetKey) &&
        !Boolean(segment.take?.signed_url || segment.clip.signed_source_url)
    );
    if (missingSegments.length) {
      setExportProgress(
        `Export failed: ${missingSegments.length} timeline clip${
          missingSegments.length === 1 ? " is" : "s are"
        } not ready yet.`
      );
      return;
    }
    const exportSegments = segments;
    if (!exportSegments.length) return;
    setExportProgress("Preparing local source files…");

    try {
      const clips: ExportTimelineClip[] = [];
      for (let index = 0; index < exportSegments.length; index += 1) {
        const segment = exportSegments[index];
        let file = localMediaFilesRef.current.get(segment.assetKey);
        if (!file) {
          const remoteUrl =
            segment.take?.signed_url || segment.clip.signed_source_url;
          if (!remoteUrl) {
            throw new Error(
              `Clip ${segment.clip.clip_number} has no media URL.`
            );
          }
          file = await getCachedMedia(segment.assetKey, remoteUrl).catch(() =>
            getCachedMedia(
              segment.assetKey,
              `/api/proxy-video?url=${encodeURIComponent(remoteUrl)}`
            )
          );
          localMediaFilesRef.current.set(segment.assetKey, file);
        }
        clips.push({
          file,
          sourceInFrame: segment.item.source_in_frame,
          sourceOutFrame: segment.item.source_out_frame,
          volume: Number(segment.item.volume ?? 1),
          muted: Boolean(segment.item.muted),
          label: `Clip ${segment.clip.clip_number}`,
        });
        setExportProgress(
          `Preparing local source files · ${index + 1}/${exportSegments.length}`
        );
      }

      const blob = await exportTimelineVideo({
        clips,
        fps: timelineFps,
        aspectRatio: data.project.aspect_ratio,
        originalVolume,
        backgroundAudioUrl,
        backgroundAudioVolume: bgAudioVolume,
        onProgress: setExportProgress,
      });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = exportFileName(data.project.title);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
      setExportProgress("Export complete.");
    } catch (error) {
      console.error("Mediabunny export failed:", error);
      setExportProgress(
        error instanceof Error
          ? `Export failed: ${error.message}`
          : "Export failed."
      );
    }
  }

  const formatTime = (seconds: number) => {
    return formatTimelineTime(seconds, timelineFps);
  };

  const projectState = data.project.state;
  const canExport =
    segments.length > 0 &&
    segments.every(
      (segment) =>
        localMediaFilesRef.current.has(segment.assetKey) ||
        Boolean(segment.take?.signed_url || segment.clip.signed_source_url)
    );
  const draftStartFrame = Number(frameDraft.start);
  const draftEndFrame = Number(frameDraft.end);
  const draftDurationFrames =
    Number.isInteger(draftStartFrame) &&
    Number.isInteger(draftEndFrame) &&
    draftEndFrame >= draftStartFrame
      ? draftEndFrame - draftStartFrame + 1
      : 0;
  const activeLocalMediaReady = Boolean(
    activeSegment && localMediaUrls[activeSegment.assetKey]
  );
  const activeMediaCacheError = activeSegment
    ? mediaCacheErrors[activeSegment.assetKey]
    : undefined;
  const cachePercent = activeLocalMediaReady
    ? 100
    : cacheProgress.totalBytes > 0
    ? Math.min(
        99,
        Math.round(
          (cacheProgress.loadedBytes / cacheProgress.totalBytes) * 100
        )
      )
    : cacheProgress.total > 0
    ? Math.min(
        99,
        Math.round((cacheProgress.ready / cacheProgress.total) * 100)
      )
    : 0;

  if (projectState === "planning") {
    return (
      <section className="state-screen planning-screen">
        <style>{`
          .state-screen {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: calc(100vh - 56px);
            background-color: #0A0A0C;
            color: #E2E2E9;
            font-family: 'Outfit', sans-serif;
            padding: 24px;
            text-align: center;
          }
          .glass-panel {
            background: rgba(18, 18, 21, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(12px);
            padding: 48px;
            border-radius: 16px;
            max-width: 520px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          }
          .pulsing-icon {
            font-size: 48px;
            margin-bottom: 24px;
            animation: pulse 2s infinite ease-in-out;
          }
          .state-title {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 12px;
            color: #fff;
          }
          .state-desc {
            font-size: 14px;
            color: #A1A1AA;
            line-height: 1.6;
            margin-bottom: 24px;
          }
          .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 0.8; }
            50% { transform: scale(1.1); opacity: 1; }
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
        <div className="glass-panel">
          <div className="pulsing-icon">🧠</div>
          <h1 className="state-title">AI Scene Architect</h1>
          <p className="state-desc">
            Gemini is reviewing your script, planning appropriate visuals, and optimizing prompts for each segment...
          </p>
          <div className="spinner" />
        </div>
      </section>
    );
  }

  if (projectState === "review") {
    return (
      <section className="state-screen review-screen">
        <style>{`
          .state-screen {
            background-color: #0A0A0C;
            color: #E2E2E9;
            font-family: 'Outfit', sans-serif;
            padding: 40px 24px;
            min-height: calc(100vh - 56px);
            display: flex;
            justify-content: center;
          }
          .review-container {
            max-width: 800px;
            width: 100%;
          }
          .review-header {
            margin-bottom: 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .review-header-left h1 {
            font-size: 28px;
            font-weight: 800;
            color: #fff;
            margin: 0 0 6px 0;
            letter-spacing: -0.02em;
          }
          .review-header-left p {
            font-size: 14px;
            color: #71717A;
            margin: 0;
          }
          .project-badge {
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.2);
            color: #60a5fa;
            font-size: 11px;
            font-weight: 700;
            padding: 4px 8px;
            border-radius: 4px;
            text-transform: uppercase;
          }
          .prompt-cards-list {
            display: flex;
            flex-direction: column;
            gap: 20px;
            margin-bottom: 40px;
          }
          .prompt-card {
            background-color: #121215;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 24px;
            transition: border-color 0.2s;
          }
          .prompt-card:focus-within {
            border-color: rgba(255, 255, 255, 0.2);
          }
          .prompt-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 14px;
          }
          .clip-label {
            font-size: 14px;
            font-weight: 700;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .clip-label span {
            color: #71717A;
            font-size: 11px;
            font-weight: 500;
          }
          .prompt-textarea {
            width: 100%;
            height: 120px;
            background-color: #0A0A0C;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 12px;
            color: #E2E2E9;
            font-family: inherit;
            font-size: 13px;
            line-height: 1.6;
            resize: vertical;
            outline: none;
            transition: border-color 0.2s;
          }
          .prompt-textarea:focus {
            border-color: #3b82f6;
          }
          .spoken-line-preview {
            background-color: rgba(255, 255, 255, 0.02);
            border-left: 3px solid #3b82f6;
            padding: 8px 12px;
            font-size: 13px;
            color: #A1A1AA;
            margin-bottom: 14px;
            border-radius: 0 6px 6px 0;
            font-style: italic;
          }
          .approve-bar {
            position: sticky;
            bottom: 24px;
            background: rgba(10, 10, 12, 0.8);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 16px 24px;
            border-radius: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          }
          .approve-btn {
            background-color: #fff;
            color: #000;
            border: none;
            padding: 12px 28px;
            border-radius: 8px;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .approve-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(255,255,255,0.25);
          }
          .approve-btn:disabled {
            background-color: #27272A;
            color: #71717A;
            cursor: not-allowed;
          }
          .spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-top-color: #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
        <div className="review-container">
          <header className="review-header">
            <div className="review-header-left">
              <h1>Review Prompts</h1>
              <p>Tailor the cinematic prompts generated for each segment before compiling</p>
            </div>
            <span className="project-badge">{data.project.mode === "edit_video" ? "Edit Mode" : "From Scratch"}</span>
          </header>

          <div className="prompt-cards-list">
            {reviewClips.map((clip) => {
              const currentPrompt = editedPrompts[clip.key] !== undefined ? editedPrompts[clip.key] : clip.prompt;
              return (
                <div key={clip.key} className="prompt-card">
                  <div className="prompt-card-header">
                    <div className="clip-label">
                      🎥 Scene {clip.clip_number}
                      <span>· {clip.duration_seconds} seconds</span>
                    </div>
                  </div>
                  {clip.spoken_line && (
                    <div className="spoken-line-preview">
                      &ldquo;{clip.spoken_line}&rdquo;
                    </div>
                  )}
                  <textarea
                    className="prompt-textarea"
                    value={currentPrompt}
                    onChange={(e) => setEditedPrompts(prev => ({ ...prev, [clip.key]: e.target.value }))}
                    placeholder="Enter visual generation prompt for Omni..."
                  />
                </div>
              );
            })}
          </div>

          <div className="approve-bar">
            <div>
              <strong style={{ display: "block", color: "#fff", fontSize: "14px" }}>Ready to render?</strong>
              <span style={{ fontSize: "12px", color: "#71717A" }}>Omni will generate takes for all {reviewClips.length} clips.</span>
            </div>
            <button
              className="approve-btn"
              onClick={handleApprove}
              disabled={busy !== null}
            >
              {busy === "approving" ? "Initializing Omni Generator..." : "Approve & Generate Takes"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (projectState === "generating" && data.clips.length === 0) {
    return (
      <section className="state-screen generating-screen">
        <style>{`
          .state-screen {
            background-color: #0A0A0C;
            color: #E2E2E9;
            font-family: 'Outfit', sans-serif;
            padding: 40px 24px;
            min-height: calc(100vh - 56px);
            display: flex;
            justify-content: center;
          }
          .generating-container {
            max-width: 900px;
            width: 100%;
          }
          .generating-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 32px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 20px;
          }
          .generating-header h1 {
            font-size: 24px;
            font-weight: 700;
            color: #fff;
            margin: 0;
          }
          .progress-bar-container {
            height: 6px;
            background-color: #16161B;
            border-radius: 3px;
            overflow: hidden;
            margin-bottom: 32px;
          }
          .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #3b82f6, #10b981);
            transition: width 0.4s ease-out;
          }
          .clips-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 16px;
            margin-bottom: 40px;
          }
          .clip-status-card {
            background-color: #121215;
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 10px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .clip-status-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .status-pill {
            font-size: 10px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
          }
          .status-queued { background: rgba(113, 113, 122, 0.1); color: #a1a1aa; border: 1px solid rgba(113, 113, 122, 0.2); }
          .status-processing { background: rgba(59, 130, 246, 0.1); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
          .status-completed { background: rgba(16, 185, 129, 0.1); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); }
          .status-failed { background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); }
          
          .logs-panel {
            background-color: #060608;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            padding: 20px;
            font-family: monospace;
            font-size: 12px;
          }
          .logs-title {
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .logs-content {
            height: 180px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            color: #71717A;
          }
          .log-line {
            line-height: 1.5;
          }
          .log-time {
            color: #3b82f6;
            margin-right: 8px;
          }
          .log-msg {
            color: #E2E2E9;
          }
          .spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-top-color: #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
        <div className="generating-container">
          <header className="generating-header">
            <div>
              <h1>Compiling Video Takes</h1>
              <p style={{ fontSize: "13px", color: "#71717A", margin: "4px 0 0 0" }}>
                Omni is processing visual scene instructions and generating clips.
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div className="spinner" />
              <span style={{ fontSize: "13px", fontWeight: 600 }}>Active</span>
            </div>
          </header>

          {/* Calculate and render progress bar */}
          {(() => {
            const totalClips = data.clips.length;
            const completedClips = data.clips.filter(c => c.takes?.some(t => t.status === "completed")).length;
            const pct = totalClips > 0 ? Math.round((completedClips / totalClips) * 100) : 0;

            return (
              <>
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "#A1A1AA", marginBottom: "32px" }}>
                  <span>Progress: {pct}%</span>
                  <span>{completedClips} of {totalClips} scenes generated</span>
                </div>
              </>
            );
          })()}

          <div className="clips-grid">
            {data.clips.map((clip) => {
              const take = clip.takes?.[0];
              const status = take?.status || "queued";

              return (
                <div key={clip.id} className="clip-status-card">
                  <div className="clip-status-header">
                    <span style={{ fontWeight: 700, fontSize: "14px" }}>Scene {clip.clip_number}</span>
                    <span className={`status-pill status-${status}`}>{status}</span>
                  </div>
                  <p style={{ fontSize: "11px", color: "#71717A", margin: 0, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", lineHeight: 1.5 }}>
                    {clip.prompt}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="logs-panel">
            <div className="logs-title">
              📟 <span>System Engine Logs</span>
            </div>
            <div className="logs-content">
              {data.events.length === 0 ? (
                <div style={{ color: "#52525B" }}>Waiting for logs to stream...</div>
              ) : (
                data.events.map((evt) => (
                  <div key={evt.id} className="log-line">
                    <span className="log-time">[{new Date(evt.created_at).toLocaleTimeString()}]</span>
                    <span className="log-msg">{evt.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section ref={workspaceRef} className="reel-editor-workspace">
      <style>{`
        .reel-editor-workspace {
          display: flex;
          flex-direction: column;
          width: 100vw;
          height: 100dvh;
          background-color: #0A0A0C;
          color: #E2E2E9;
          font-family: 'Outfit', sans-serif;
          overflow: hidden;
          position: relative;
        }
        .editor-top-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 24px;
          background-color: #121215;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .scene-title-wrap {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .scene-title {
          font-size: 15px;
          font-weight: 600;
          color: #fff;
        }
        .avatar-strip {
          display: flex;
          align-items: center;
          gap: -8px;
        }
        .avatar-strip img {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 2px solid #121215;
          margin-left: -6px;
        }
        .editor-top-actions {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .action-icon-btn {
          background: none;
          border: none;
          color: #A1A1AA;
          cursor: pointer;
          font-size: 18px;
          transition: color 0.2s;
        }
        .action-icon-btn:hover {
          color: #fff;
        }
        .done-btn {
          background-color: #ECECED;
          color: #0A0A0C;
          border: none;
          padding: 6px 16px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .done-btn:hover {
          background-color: #fff;
        }
        .done-btn:disabled {
          color: #71717a;
          background: #27272a;
          cursor: not-allowed;
        }
        .main-editor-layout {
          display: flex;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .player-canvas {
          flex: 1;
          background-color: #060608;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          position: relative;
          padding: 24px;
        }
        .aspect-ratio-badge {
          position: absolute;
          left: 24px;
          top: 50%;
          transform: translateY(-50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: #71717A;
        }
        .aspect-ratio-icon {
          width: 20px;
          height: 32px;
          border: 2px solid #71717A;
          border-radius: 4px;
        }
        .aspect-ratio-icon.horizontal {
          width: 32px;
          height: 20px;
        }
        .video-container {
          height: 70%;
          aspect-ratio: 9/16;
          background-color: #000;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .video-container.ratio-16-9 {
          aspect-ratio: 16/9;
          height: 60%;
        }
        .video-container video {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        .editor-video-slot {
          opacity: 0;
          visibility: hidden;
          z-index: 1;
          background: #000;
          transition: none;
        }
        .editor-video-slot.active {
          opacity: 1;
          visibility: visible;
          z-index: 2;
        }
        .editor-video-slot.standby {
          opacity: 0;
          visibility: visible;
          pointer-events: none;
        }
        .media-preparation-overlay {
          position: absolute;
          inset: 0;
          z-index: 5;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 24px;
          text-align: center;
          background:
            radial-gradient(circle at 50% 42%, rgba(49, 58, 91, 0.34), transparent 55%),
            #09090b;
          color: #fff;
        }
        .media-preparation-overlay strong {
          font-size: 13px;
        }
        .media-preparation-overlay span {
          color: #a1a1aa;
          font-size: 10px;
          line-height: 1.45;
        }
        .media-preparation-spinner {
          width: 28px;
          height: 28px;
          border: 3px solid rgba(255, 255, 255, 0.14);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        .media-preparation-track {
          width: min(180px, 82%);
          height: 5px;
          overflow: hidden;
          border-radius: 99px;
          background: rgba(255, 255, 255, 0.12);
        }
        .media-preparation-fill {
          height: 100%;
          border-radius: inherit;
          background: #fff;
          transition: width 0.16s linear;
        }
        .player-controls {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-top: 20px;
          background: rgba(18, 18, 21, 0.85);
          backdrop-filter: blur(12px);
          padding: 8px 24px;
          border-radius: 50px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .time-display {
          font-size: 13px;
          color: #A1A1AA;
          font-variant-numeric: tabular-nums;
        }
        .play-btn-circle {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background-color: #fff;
          color: #000;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          cursor: pointer;
          transition: transform 0.2s;
        }
        .play-btn-circle:hover {
          transform: scale(1.05);
        }
        .play-btn-circle svg {
          width: 16px;
          height: 16px;
          fill: currentColor;
        }
        .right-sidebar {
          width: 360px;
          background-color: #121215;
          border-left: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          flex-direction: column;
          padding: 24px;
          overflow-y: auto;
          transition: width 0.2s ease, padding 0.2s ease;
        }
        .right-sidebar.collapsed {
          width: 0;
          padding-left: 0;
          padding-right: 0;
          border-left: 0;
          overflow: hidden;
        }
        .sidebar-preview-card {
          width: 100%;
          aspect-ratio: 9/16;
          max-height: 240px;
          background-color: #000;
          border-radius: 12px;
          border: 2px solid #52525B;
          overflow: hidden;
          margin-bottom: 16px;
          position: relative;
        }
        .sidebar-preview-card img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .sidebar-speaker {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .sidebar-speaker img {
          width: 32px;
          height: 32px;
          border-radius: 50%;
        }
        .sidebar-script-box {
          background-color: #1A1A1E;
          border-radius: 8px;
          padding: 16px;
          font-size: 13px;
          line-height: 1.6;
          color: #E2E2E9;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.04);
        }
        .sidebar-section-title {
          font-size: 11px;
          font-weight: 700;
          color: #71717A;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 8px;
        }
        .take-selector-dropdown {
          background-color: #1A1A1E;
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.1);
          padding: 8px 12px;
          border-radius: 6px;
          width: 100%;
          font-size: 13px;
          margin-bottom: 16px;
          cursor: pointer;
        }
        .regenerate-btn {
          width: 100%;
          background-color: transparent;
          border: 1px dashed rgba(255, 255, 255, 0.2);
          color: #A1A1AA;
          padding: 10px;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .regenerate-btn:hover {
          border-color: #fff;
          color: #fff;
        }
        .bottom-timeline-panel {
          height: 292px;
          min-height: 240px;
          background-color: #0E0E11;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          flex-direction: column;
          user-select: none;
          position: relative;
        }
        .timeline-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 4px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .zoom-controls {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .zoom-slider {
          width: 80px;
          accent-color: #fff;
        }
        .timeline-scroll-container {
          flex: 1;
          overflow-x: auto;
          overflow-y: hidden;
          position: relative;
          display: flex;
          flex-direction: column;
        }
        .timeline-ruler {
          height: 24px;
          position: relative;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .ruler-tick {
          position: absolute;
          top: 0;
          height: 100%;
          border-left: 1px solid rgba(255, 255, 255, 0.1);
          padding-left: 4px;
          font-size: 10px;
          color: #71717A;
          display: flex;
          align-items: flex-end;
          padding-bottom: 2px;
        }
        .timeline-tracks {
          flex: 1;
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 12px 0;
        }
        .timeline-clip-strip {
          display: flex;
          align-items: center;
          height: 92px;
        }
        .timeline-clip {
          height: 100%;
          background-color: #1E1E24;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          position: relative;
          cursor: grab;
          overflow: hidden;
          transition: background-color 0.2s;
          display: flex;
        }
        .timeline-clip.active {
          border: 2px solid #fff;
          border-radius: 4px;
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.1);
        }
        .timeline-clip.trim-previewing {
          overflow: visible;
          z-index: 30;
          cursor: ew-resize;
          transition: none;
        }
        .timeline-clip.active.trim-previewing {
          border-color: rgba(255, 255, 255, 0.14);
          box-shadow: none;
        }
        .timeline-clip.dragging {
          opacity: 0.5;
          border: 2px dashed #fff;
        }
        .clip-thumbnails {
          position: absolute;
          inset: 0;
          display: flex;
          opacity: 0.55;
          pointer-events: none;
        }
        .clip-thumbnails img {
          height: 100%;
          object-fit: cover;
        }
        .clip-thumbnail-loading,
        .clip-thumbnail-error {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #d4d4d8;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.02em;
          background:
            linear-gradient(
              110deg,
              rgba(255,255,255,.025) 25%,
              rgba(255,255,255,.1) 42%,
              rgba(255,255,255,.025) 58%
            ),
            #1b1b21;
          background-size: 220% 100%;
          animation: thumbnail-shimmer 1.2s linear infinite;
        }
        .clip-thumbnail-error {
          color: #fca5a5;
          background: #211719;
          animation: none;
        }
        @keyframes thumbnail-shimmer {
          to { background-position: -220% 0; }
        }
        .clip-label-overlay {
          position: absolute;
          left: 8px;
          top: 8px;
          font-size: 11px;
          font-weight: 700;
          color: #fff;
          z-index: 2;
          background-color: rgba(0, 0, 0, 0.6);
          padding: 2px 6px;
          border-radius: 4px;
          pointer-events: none;
        }
        .clip-second-grid {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
        }
        .clip-second-line {
          position: absolute;
          top: 0;
          bottom: 0;
          border-left: 1px solid rgba(255, 255, 255, 0.38);
        }
        .clip-second-line:nth-child(even) {
          background: rgba(255, 255, 255, 0.055);
        }
        .clip-frame-grid {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
          opacity: 0.32;
          background-image: repeating-linear-gradient(
            to right,
            rgba(255,255,255,.28) 0,
            rgba(255,255,255,.28) 1px,
            transparent 1px,
            transparent calc(var(--frame-width, 4px))
          );
        }
        .trim-discard-overlay {
          position: absolute;
          top: 0;
          bottom: 0;
          z-index: 4;
          background: rgba(2, 2, 4, 0.72);
          pointer-events: none;
        }
        .trim-discard-start {
          left: 0;
          border-radius: 4px 0 0 4px;
        }
        .trim-discard-end {
          border-radius: 0 4px 4px 0;
        }
        .trim-retained-outline {
          position: absolute;
          top: -2px;
          bottom: -2px;
          z-index: 6;
          border: 3px solid #fff;
          border-radius: 7px;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.75);
          pointer-events: none;
        }
        .trim-retained-summary {
          position: absolute;
          left: 50%;
          bottom: 6px;
          transform: translateX(-50%);
          max-width: calc(100% - 20px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 4px 7px;
          border-radius: 5px;
          background: rgba(0, 0, 0, 0.78);
          color: #fff;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.01em;
        }
        .trim-cut-guide {
          position: absolute;
          top: -36px;
          bottom: -18px;
          width: 2px;
          z-index: 9;
          background: #fff;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
          pointer-events: none;
        }
        .trim-cut-badge {
          position: absolute;
          top: -2px;
          left: 50%;
          transform: translate(-50%, -100%);
          padding: 5px 8px;
          border: 2px solid #fff;
          border-radius: 9px;
          background: #0b0b0e;
          color: #fff;
          font-size: 11px;
          font-weight: 800;
          white-space: nowrap;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        }
        .trim-handle {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 12px;
          background-color: #fff;
          cursor: ew-resize;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: center;
          touch-action: none;
        }
        .timeline-clip.trim-previewing .trim-handle {
          transition: none;
        }
        .trim-handle::after {
          content: "";
          width: 2px;
          height: 12px;
          background-color: #000;
        }
        .trim-handle.start {
          left: 0;
        }
        .trim-handle.end {
          right: 0;
        }
        .add-clip-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background-color: #1A1A1E;
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          cursor: pointer;
          margin-left: 12px;
          margin-right: 12px;
          transition: background 0.2s;
        }
        .add-clip-btn:hover {
          background-color: #27272A;
        }
        .playhead-scrubber {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background-color: #fff;
          z-index: 20;
          pointer-events: none;
        }
        .playhead-handle {
          position: absolute;
          top: -4px;
          left: -6px;
          width: 14px;
          height: 14px;
          background-color: #fff;
          border-radius: 50%;
          cursor: pointer;
          pointer-events: auto;
          box-shadow: 0 2px 4px rgba(0,0,0,0.5);
          touch-action: none;
        }
        .timeline-ruler {
          touch-action: none;
        }
        .export-overlay {
          position: absolute;
          inset: 0;
          background-color: rgba(10, 10, 12, 0.85);
          backdrop-filter: blur(8px);
          z-index: 100;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
        }
        .export-progress-spinner {
          width: 40px;
          height: 40px;
          border: 3px solid rgba(255, 255, 255, 0.1);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        .timeline-audio-lane {
          width: 100%;
          height: 34px;
          margin-top: 10px;
          background: rgba(34, 197, 94, 0.1);
          border: 1px dashed rgba(34, 197, 94, 0.3);
          border-radius: 6px;
          display: flex;
          align-items: center;
          padding: 0 12px;
          position: relative;
          color: #22c55e;
          font-size: 11px;
          font-weight: 600;
        }
        .mixer-panel {
          padding: 16px;
          background-color: #16161B;
          border-radius: 8px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.04);
        }
        .mixer-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 12px;
        }
        .mixer-row:last-child {
          margin-bottom: 0;
        }
        .mixer-row label {
          font-size: 11px;
          font-weight: 700;
          color: #71717A;
          text-transform: uppercase;
          display: flex;
          justify-content: space-between;
        }
        .mixer-row input[type="range"] {
          accent-color: #fff;
          cursor: pointer;
        }
        .audio-import-btn {
          background-color: #27272A;
          color: #E2E2E9;
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: background-color 0.2s;
        }
        .audio-import-btn:hover {
          background-color: #3f3f46;
        }
        .trim-inspector {
          min-height: 76px;
          padding: 10px 16px;
          background: #141419;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          gap: 18px;
        }
        .trim-field {
          display: grid;
          grid-template-columns: auto 86px auto auto;
          align-items: center;
          gap: 6px;
        }
        .trim-field label {
          color: #a1a1aa;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .06em;
          text-transform: uppercase;
        }
        .trim-field input {
          width: 86px;
          padding: 7px 9px;
          color: #fff;
          background: #09090b;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 6px;
          font-variant-numeric: tabular-nums;
          outline: none;
        }
        .trim-field input:focus {
          border-color: #60a5fa;
          box-shadow: 0 0 0 2px rgba(59,130,246,.18);
        }
        .frame-step-button {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,.12);
          color: #e4e4e7;
          background: #24242a;
          cursor: pointer;
        }
        .trim-duration {
          min-width: 180px;
          font-size: 11px;
          line-height: 1.45;
          color: #a1a1aa;
          font-variant-numeric: tabular-nums;
        }
        .trim-error {
          color: #fca5a5;
          font-size: 10px;
          margin-top: 3px;
        }
        .timeline-tool-button {
          border: 1px solid rgba(255,255,255,.1);
          background: #202026;
          color: #d4d4d8;
          padding: 4px 8px;
          border-radius: 5px;
          font-size: 10px;
          cursor: pointer;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Hidden elements for Audio and Imports */}
      <input
        type="file"
        accept="audio/*"
        ref={audioInputRef}
        onChange={handleAudioImport}
        style={{ display: "none" }}
      />
      {backgroundAudioUrl && (
        <audio ref={bgAudioRef} src={backgroundAudioUrl} loop style={{ display: "none" }} />
      )}

      {/* Top Navigation Bar */}
      <header className="editor-top-bar">
        <div className="scene-title-wrap">
          <button
            className="action-icon-btn"
            onClick={() => (window.location.href = "/studio")}
          >
            ←
          </button>
          <span className="scene-title">
            {data.project.title} - Scene Editor
          </span>
          <div className="avatar-strip">
            {data.presenter?.signed_url && (
              <img src={data.presenter.signed_url} alt="Presenter" />
            )}
          </div>
        </div>

        <div className="editor-top-actions">
          {viewMode === "timeline" && (
            <>
              <button className="audio-import-btn" title="Undo (Ctrl/Cmd+Z)" onClick={undoTimeline}>↶</button>
              <button className="audio-import-btn" title="Redo (Ctrl/Cmd+Shift+Z)" onClick={redoTimeline}>↷</button>
              <button className="audio-import-btn" title="Duplicate selected clip (Ctrl/Cmd+D)" onClick={duplicateSelectedItem}>Duplicate</button>
              <button className="audio-import-btn" title="Split at playhead (Ctrl/Cmd+K)" onClick={splitSelectedAtPlayhead}>Split</button>
            </>
          )}
          <button
            className="view-toggle-btn"
            style={{ padding: "6px 12px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "6px", fontSize: "12px", color: "#fff", cursor: "pointer", marginRight: "8px" }}
            onClick={() => setViewMode(viewMode === "table" ? "timeline" : "table")}
          >
            {viewMode === "table" ? "🎞️ Timeline Editor" : "📋 Table View"}
          </button>
          {viewMode === "timeline" && (
            <button
              className="audio-import-btn"
              onClick={() => setSidebarCollapsed((current) => !current)}
            >
              {sidebarCollapsed ? "Show inspector" : "Hide inspector"}
            </button>
          )}
          <button className="audio-import-btn" onClick={toggleFullscreen}>
            {isFullscreen ? "Exit fullscreen" : "⛶ Fullscreen"}
          </button>
          <button
            className="audio-import-btn"
            onClick={() => audioInputRef.current?.click()}
          >
            🎵 Add Audio Track
          </button>
          <button
            className="done-btn"
            onClick={createScene}
            disabled={!canExport}
            title={canExport ? "Export the complete timeline" : "Wait for every timeline clip to become ready"}
          >
            {canExport ? "Export" : "Waiting for clips"}
          </button>
        </div>
      </header>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "5px 16px", background: "#0e0e11", borderBottom: "1px solid rgba(255,255,255,.05)", fontSize: "10px", color: "#a1a1aa" }}>
        <span>● {cacheStatus}</span>
        {cacheBytes.quota > 0 && (
          <span>
            {(cacheBytes.usage / 1024 / 1024).toFixed(0)} MB local cache
          </span>
        )}
        <button
          className="action-icon-btn"
          style={{ marginLeft: "auto", fontSize: "10px" }}
          onClick={async () => {
            await clearEditorMediaCache();
            for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
            objectUrlsRef.current.clear();
            for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
            thumbnailObjectUrlsRef.current.clear();
            localMediaFilesRef.current.clear();
            processingUrlsRef.current.clear();
            thumbnailAttemptsRef.current.clear();
            setLocalMediaUrls({});
            setMediaCacheErrors({});
            setThumbnailErrors({});
            setCacheProgress({
              ready: 0,
              total: segments.length,
              loadedBytes: 0,
              totalBytes: 0,
              failed: 0,
            });
            setThumbnails({});
            setCacheStatus("Local cache cleared. Clips will be prepared again.");
            setCacheEpoch((value) => value + 1);
          }}
        >
          Clear local media
        </button>
      </div>

      {viewMode === "table" ? (
        <div className="table-view-container">
          <div className="table-view-header">
            <div>
              <h2>Generated Scene Overview</h2>
              <p style={{ margin: "6px 0 0", color: "#71717a", fontSize: "12px" }}>
                Videos appear here as soon as their local preview is ready.
              </p>
            </div>
            <span className={`status status-${projectState}`}>
              {projectState}
            </span>
          </div>
          <div className="clips-table-grid">
            {data.clips.map((clip) => {
              const latestTake = [...clip.takes].sort(
                (left, right) => right.take_number - left.take_number
              )[0];
              const activeTake =
                (latestTake && latestTake.status !== "completed"
                  ? latestTake
                  : undefined) ||
                clip.takes.find((t) => t.selected && t.status === "completed") ||
                clip.takes.find((t) => t.status === "completed") ||
                latestTake;
              const assetKey = activeTake?.storage_path || clip.source_chunk_path || "";
              const localVideoUrl = assetKey ? localMediaUrls[assetKey] : "";
              const fallbackVideoUrl = activeTake?.signed_url || clip.signed_source_url;
              const progress = activeTake
                ? displayedTakeProgress[activeTake.id] ??
                  (activeTake.status === "completed" && localVideoUrl ? 100 : 0)
                : localVideoUrl
                ? 100
                : 0;
              const showVideo = activeTake
                ? activeTake.status === "completed" &&
                  progress === 100 &&
                  Boolean(localVideoUrl)
                : Boolean(localVideoUrl || fallbackVideoUrl);
              const videoUrl = localVideoUrl || fallbackVideoUrl;
              const errorDetails = activeTake?.error_details || {};
              const userError =
                typeof errorDetails.user_message === "string"
                  ? errorDetails.user_message
                  : activeTake?.last_error;
              const failed = Boolean(
                activeTake &&
                  ["failed", "uncertain"].includes(activeTake.status)
              );

              return (
                <div key={clip.id} className="table-clip-row">
                  <div className="table-clip-meta">
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <span className="clip-num-badge">Scene {clip.clip_number}</span>
                      <span className="clip-duration-badge">{clip.duration_seconds}s</span>
                    </div>
                    
                    <div className="field-group">
                      <label>Spoken Line</label>
                      <div className="spoken-line-box">&ldquo;{clip.spoken_line}&rdquo;</div>
                    </div>

                    <div className="field-group">
                      <label>Visual Prompt</label>
                      <textarea
                        className="prompt-textarea-live"
                        value={livePrompts[clip.id] !== undefined ? livePrompts[clip.id] : clip.prompt}
                        onChange={(e) => setLivePrompts(prev => ({ ...prev, [clip.id]: e.target.value }))}
                        rows={4}
                        style={{
                          width: "100%",
                          backgroundColor: "rgba(0, 0, 0, 0.3)",
                          color: "#fff",
                          border: "1px solid rgba(255, 255, 255, 0.08)",
                          borderRadius: "8px",
                          padding: "10px 14px",
                          fontSize: "14px",
                          lineHeight: "1.5",
                          resize: "vertical",
                          outline: "none"
                        }}
                      />
                    </div>
                    {userError && failed && (
                      <div
                        className={`clip-generation-error ${
                          activeTake?.error_category === "policy" ? "policy" : ""
                        }`}
                      >
                        <strong style={{ display: "block", marginBottom: "3px" }}>
                          {activeTake?.error_category === "policy"
                            ? "Prompt needs an update"
                            : "Generation needs attention"}
                        </strong>
                        {userError}
                      </div>
                    )}
                  </div>

                  <div className="table-clip-preview">
                    <div className={`video-player-wrapper ${data.project.aspect_ratio === "9:16" ? "ratio-9-16" : ""}`}>
                      {showVideo && videoUrl ? (
                        <video
                          src={videoUrl}
                          controls
                          preload="metadata"
                          className="table-video-player"
                        />
                      ) : (
                        <div className="generation-placeholder">
                          {!failed && <div className="generation-orbit" />}
                          <strong>
                            {failed
                              ? "Update the prompt to continue"
                              : activeTake?.status === "completed"
                              ? "Finalizing the local preview"
                              : "Your video is on the way"}
                          </strong>
                          {!failed && (
                            <>
                              <div className="generation-progress-track">
                                <div
                                  className="generation-progress-fill"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                              <span>
                                Estimated preparation · {progress}%
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="table-clip-actions">
                    <button
                      className="regenerate-btn-table"
                      disabled={busy === clip.id}
                      onClick={() => regenerate(clip.id)}
                    >
                      {busy === clip.id
                        ? "Generating..."
                        : failed
                        ? "Update prompt & generate"
                        : "🔄 Generate new take"}
                    </button>
                    {clip.takes.length > 1 && (
                      <div className="takes-selector-wrap">
                        <label>Select Take:</label>
                        <select
                          value={activeTake?.id}
                          onChange={async (e) => {
                            const t = clip.takes.find((x) => x.id === e.target.value);
                            if (t) {
                              setBusy(clip.id);
                              try {
                                await selectTakeForClip(clip.id, t);
                                await refresh();
                              } catch (error) {
                                alert(error instanceof Error ? error.message : "Failed to switch take");
                              } finally {
                                setBusy(null);
                              }
                            }
                          }}
                        >
                          {clip.takes.map((t) => (
                            <option key={t.id} value={t.id}>
                              Take {t.take_number} ({t.status})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <details className="table-event-log" open={projectState === "attention"}>
            <summary>
              Activity and generation logs · {data.events.length} entries
            </summary>
            <div className="table-event-list">
              {data.events.length ? (
                data.events.map((entry) => (
                  <div
                    key={entry.id}
                    className={`table-event-row event-${entry.level}`}
                  >
                    <time>{new Date(entry.created_at).toLocaleTimeString()}</time>
                    <span>{entry.message}</span>
                  </div>
                ))
              ) : (
                <div className="table-event-row">
                  <span>—</span>
                  <span>Waiting for generation activity.</span>
                </div>
              )}
            </div>
          </details>
        </div>
      ) : (
        <>
          {/* Main Editing Workspace */}
          <div className="main-editor-layout">
        {/* Centered Video Player */}
        <div className="player-canvas">
          <div className="aspect-ratio-badge">
            <div
              className={`aspect-ratio-icon ${
                data.project.aspect_ratio === "16:9" ? "horizontal" : ""
              }`}
            />
            <span>{data.project.aspect_ratio}</span>
          </div>

          <div
            className={`video-container ${
              data.project.aspect_ratio === "16:9" ? "ratio-16-9" : ""
            }`}
          >
            <video
              ref={videoRef}
              className="editor-video-slot active"
              playsInline
              preload="auto"
              crossOrigin="anonymous"
              onClick={togglePlay}
            />
            <video
              ref={nextVideoRef}
              className="editor-video-slot standby"
              playsInline
              muted
              preload="auto"
              crossOrigin="anonymous"
              aria-hidden="true"
            />
            {activeSegment && !activeLocalMediaReady ? (
              <div className="media-preparation-overlay" role="status">
                {activeMediaCacheError ? (
                  <>
                    <strong>Preview media is not available</strong>
                    <span>{activeMediaCacheError}</span>
                  </>
                ) : (
                  <>
                    <div className="media-preparation-spinner" />
                    <strong>
                      Preparing clip {activeSegment.clip.clip_number} locally
                    </strong>
                    <div className="media-preparation-track">
                      <div
                        className="media-preparation-fill"
                        style={{ width: `${cachePercent}%` }}
                      />
                    </div>
                    <span>
                      {cachePercent}% · {cacheProgress.ready}/
                      {cacheProgress.total || segments.length} clips cached
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="player-controls">
            <span ref={currentTimeDisplayRef} className="time-display">
              {formatTime(currentTime)}
            </span>
            <button className="play-btn-circle" onClick={togglePlay}>
              {isPlaying ? (
                <svg viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <span className="time-display">{formatTime(totalDuration)}</span>
          </div>
        </div>

        {/* Right Editing Panel */}
        <aside className={`right-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-section-title">Audio Mixer</div>
          <div className="mixer-panel">
            <div className="mixer-row">
              <label>
                Original Clip Volume <span>{Math.round(originalVolume * 100)}%</span>
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={originalVolume}
                onChange={(e) => setOriginalVolume(Number(e.target.value))}
              />
            </div>
            <div className="mixer-row">
              <label>
                Background Audio <span>{backgroundAudioUrl ? `${Math.round(bgAudioVolume * 100)}%` : "N/A"}</span>
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                disabled={!backgroundAudioUrl}
                value={bgAudioVolume}
                onChange={(e) => setBgAudioVolume(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="sidebar-speaker">
            {data.presenter?.signed_url && (
              <img src={data.presenter.signed_url} alt="Speaker avatar" />
            )}
            <div>
              <strong style={{ display: "block", fontSize: "13px" }}>
                Omni Presenter
              </strong>
              <span style={{ fontSize: "11px", color: "#71717A" }}>
                AI Voiceover & Video
              </span>
            </div>
          </div>

          {activeSegment?.clip?.spoken_line && (
            <>
              <div className="sidebar-section-title">Spoken script</div>
              <div className="sidebar-script-box" style={{ marginBottom: "15px", fontStyle: "italic", fontSize: "12px", opacity: 0.8 }}>
                &ldquo;{activeSegment.clip.spoken_line}&rdquo;
              </div>
            </>
          )}

          <div className="sidebar-section-title">Visual Prompt</div>
          <textarea
            className="prompt-textarea-live"
            disabled={!activeSegment}
            value={activeSegment ? (livePrompts[activeSegment.clip.id] !== undefined ? livePrompts[activeSegment.clip.id] : activeSegment.clip.prompt) : ""}
            onChange={(e) => activeSegment && setLivePrompts(prev => ({ ...prev, [activeSegment.clip.id]: e.target.value }))}
            rows={5}
            style={{
              width: "100%",
              backgroundColor: "#1A1A1E",
              color: "#E2E2E9",
              border: "1px solid rgba(255, 255, 255, 0.04)",
              borderRadius: "8px",
              padding: "12px",
              fontSize: "13px",
              lineHeight: "1.6",
              resize: "vertical",
              outline: "none",
              marginBottom: "20px"
            }}
            placeholder="Enter visual generation prompt..."
          />

          {activeSegment ? (
            <>
              {activeSegment.clip.takes.length > 0 ? (
                <>
                  <div className="sidebar-section-title">Select Active Take</div>
                  <select
                    className="take-selector-dropdown"
                    value={activeSegment.take?.id || ""}
                    onChange={(e) => {
                      const targetTake = activeSegment.clip.takes.find(
                        (t) => t.id === e.target.value
                       );
                       if (targetTake) {
                         void selectTakeForTimelineItem(activeSegment.itemId, targetTake);
                       }
                    }}
                  >
                    {activeSegment.clip.takes.map((take) => (
                      <option key={take.id} value={take.id}>
                        Take {take.take_number} ({take.status})
                      </option>
                    ))}
                  </select>

                  <button
                    className="regenerate-btn"
                    disabled={busy === activeSegment.clip.id}
                    onClick={() => regenerate(activeSegment.clip.id)}
                  >
                    {busy === activeSegment.clip.id
                      ? "Adding take..."
                      : "＋ Generate new take"}
                  </button>
                </>
              ) : (
                <div style={{ padding: "12px", border: "1px dashed var(--line)", borderRadius: "8px", fontSize: "12px", color: "var(--muted)", textAlign: "center", marginTop: "15px" }}>
                  ✂️ Raw segment (appended directly)
                </div>
              )}
            </>
          ) : null}
        </aside>
      </div>

      {/* Bottom Timeline Panel */}
      <div className="bottom-timeline-panel">
        <div className="timeline-header">
          <span style={{ fontSize: "11px", color: "#71717A", fontWeight: 700 }}>
            TIMELINE · {timelineFps} FPS · Ctrl/Cmd+C/V duplicate · Ctrl/Cmd+K split · Delete ripple
          </span>
          <div className="zoom-controls">
            <button className="timeline-tool-button" onClick={fitTimeline}>
              Fit
            </button>
            <button
              className="timeline-tool-button"
              onClick={() => setZoomLevel(120)}
            >
              Seconds
            </button>
            <button
              className="timeline-tool-button"
              onClick={() => setZoomLevel(500)}
            >
              Frames
            </button>
            <span style={{ fontSize: "11px", color: "#71717A" }}>Zoom</span>
            <input
              type="range"
              min="25"
              max="800"
              value={zoomLevel}
              onChange={(e) => setZoomLevel(Number(e.target.value))}
              className="zoom-slider"
            />
          </div>
        </div>

        <div
          className="timeline-scroll-container"
          ref={timelineRef}
          onClick={handleTimelineClick}
          onWheel={handleTimelineWheel}
        >
          {/* Time Ruler */}
          <div
            className="timeline-ruler"
            style={{ width: `${Math.max(1000, totalDuration * zoomLevel)}px` }}
            onPointerDown={(e) => handleMouseDown(e, "scrub")}
          >
            {Array.from({ length: Math.ceil(totalDuration) + 1 }).map((_, i) => (
              <div
                key={i}
                className="ruler-tick"
                style={{ left: `${i * zoomLevel}px` }}
              >
                {String(i).padStart(2, "0")}s
              </div>
            ))}
          </div>

          {/* Timeline Track with Clips */}
          <div
            className="timeline-tracks"
            style={{ width: `${Math.max(1000, totalDuration * zoomLevel)}px` }}
          >
            {/* Draggable Playhead Scrubber */}
            <div
              ref={playheadRef}
              className="playhead-scrubber"
              style={{ left: 0, transform: `translate3d(${currentTime * zoomLevel}px,0,0)` }}
            >
              <div
                className="playhead-handle"
                onPointerDown={(e) => handleMouseDown(e, "scrub")}
              />
            </div>

            <div className="timeline-clip-strip">
              {segments.map((seg) => {
                const width = seg.duration * zoomLevel;
                const isActive = seg.itemId === activeClipId;
                const activeTrimPreview =
                  trimPreview?.itemId === seg.itemId ? trimPreview : null;
                const initialFrameCount = activeTrimPreview
                  ? Math.max(
                      1,
                      activeTrimPreview.initialSourceOutFrame -
                        activeTrimPreview.initialSourceInFrame
                    )
                  : 1;
                const trimStartPercent = activeTrimPreview
                  ? ((activeTrimPreview.sourceInFrame -
                      activeTrimPreview.initialSourceInFrame) /
                      initialFrameCount) *
                    100
                  : 0;
                const trimEndPercent = activeTrimPreview
                  ? ((activeTrimPreview.sourceOutFrame -
                      activeTrimPreview.initialSourceInFrame) /
                      initialFrameCount) *
                    100
                  : 100;
                const retainedFrames = activeTrimPreview
                  ? activeTrimPreview.sourceOutFrame -
                    activeTrimPreview.sourceInFrame
                  : seg.item.source_out_frame - seg.item.source_in_frame;
                const activeCutPercent =
                  activeTrimPreview?.edge === "start"
                    ? trimStartPercent
                    : trimEndPercent;
                const activeCutFrame =
                  activeTrimPreview?.edge === "start"
                    ? activeTrimPreview.sourceInFrame + 1
                    : activeTrimPreview?.sourceOutFrame;
                const activeCutSeconds =
                  activeTrimPreview?.edge === "start"
                    ? activeTrimPreview.sourceInFrame / timelineFps
                    : (activeTrimPreview?.sourceOutFrame || 0) / timelineFps;

                return (
                  <div
                    key={seg.itemId}
                    data-timeline-item={seg.itemId}
                    className={`timeline-clip ${isActive ? "active" : ""} ${activeTrimPreview ? "trim-previewing" : ""} ${!seg.take ? "raw-segment" : ""} ${draggedClipId === seg.itemId ? "dragging" : ""}`}
                    style={{ width: `${width}px` }}
                    draggable={!activeTrimPreview}
                    onDragStart={(e) => handleClipDragStart(e, seg.itemId)}
                    onDragOver={handleClipDragOver}
                    onDrop={(e) => handleClipDrop(e, seg.itemId)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveClipId(seg.itemId);
                      currentTimeRef.current = seg.startInTimeline;
                      setCurrentTime(seg.startInTimeline);
                      seekToTimelineTime(seg.startInTimeline);
                    }}
                  >
                    {/* Repeated Filmstrip Thumbnails */}
                    <div className="clip-thumbnails">
                      {thumbnails[seg.assetKey]?.length ? (
                        thumbnails[seg.assetKey].slice(
                          Math.floor(seg.trimStart),
                          Math.max(Math.floor(seg.trimStart) + 1, Math.ceil(seg.trimEnd))
                        ).map((imgSrc, idx) => (
                          <img
                            key={idx}
                            src={imgSrc}
                            alt="Thumbnail"
                            style={{
                              width: `${zoomLevel}px`,
                              height: "100%",
                              objectFit: "cover",
                            }}
                          />
                        ))
                      ) : thumbnailErrors[seg.assetKey] ? (
                        <div className="clip-thumbnail-error">
                          Preview unavailable
                        </div>
                      ) : (
                        <div className="clip-thumbnail-loading">
                          Extracting video frames…
                        </div>
                      )}
                    </div>

                    <div className="clip-second-grid">
                      {Array.from({ length: Math.ceil(seg.duration) }).map((_, second) => (
                        <span
                          key={second}
                          className="clip-second-line"
                          style={{
                            left: `${second * zoomLevel}px`,
                            width: `${zoomLevel}px`,
                          }}
                        />
                      ))}
                    </div>
                    {zoomLevel >= 100 && (
                      <div
                        className="clip-frame-grid"
                        style={{ "--frame-width": `${zoomLevel / timelineFps}px` } as React.CSSProperties}
                      />
                    )}

                    <div className="clip-label-overlay">
                      Clip {seg.clip.clip_number} {seg.take ? `- Take ${seg.take.take_number}` : "✂️ Raw"} · {retainedFrames}f
                    </div>

                    {activeTrimPreview ? (
                      <>
                        <div
                          className="trim-discard-overlay trim-discard-start"
                          style={{ width: `${trimStartPercent}%` }}
                        />
                        <div
                          className="trim-discard-overlay trim-discard-end"
                          style={{
                            left: `${trimEndPercent}%`,
                            width: `${100 - trimEndPercent}%`,
                          }}
                        />
                        <div
                          className="trim-retained-outline"
                          style={{
                            left: `${trimStartPercent}%`,
                            width: `${trimEndPercent - trimStartPercent}%`,
                          }}
                        >
                          <span className="trim-retained-summary">
                            Keep {activeTrimPreview.sourceInFrame + 1}–
                            {activeTrimPreview.sourceOutFrame} · {retainedFrames}f ·{" "}
                            {(retainedFrames / timelineFps).toFixed(2)}s
                          </span>
                        </div>
                        <div
                          className="trim-cut-guide"
                          style={{ left: `${activeCutPercent}%` }}
                        >
                          <span className="trim-cut-badge">
                            {activeTrimPreview.edge === "start" ? "Start" : "End"}{" "}
                            F{activeCutFrame} · {activeCutSeconds.toFixed(2)}s
                          </span>
                        </div>
                      </>
                    ) : null}

                    {/* Trim Handles for Active Clip */}
                    {isActive ? (
                      <>
                        <div
                          className="trim-handle start"
                          style={
                            activeTrimPreview
                              ? { left: `${trimStartPercent}%` }
                              : undefined
                          }
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            handleMouseDown(
                              e,
                              "trimStart",
                              seg.itemId,
                              seg.take,
                              seg.clip.duration_seconds
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div
                          className="trim-handle end"
                          style={
                            activeTrimPreview
                              ? {
                                  left: `${trimEndPercent}%`,
                                  right: "auto",
                                  transform: "translateX(-100%)",
                                }
                              : undefined
                          }
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            handleMouseDown(
                              e,
                              "trimEnd",
                              seg.itemId,
                              seg.take,
                              seg.clip.duration_seconds
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </>
                    ) : null}
                  </div>
                );
              })}

              <button
                className="add-clip-btn"
                title="Add Transition or Segment"
                onClick={(e) => {
                  e.stopPropagation();
                  alert("Omni clip slots are automatically generated.");
                }}
              >
                +
              </button>
            </div>

            {/* Background Audio Lane */}
            {backgroundAudioUrl && (
              <div className="timeline-audio-lane">
                <span>
                  🎵 {backgroundAudioName || "Background Audio Track"}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setBackgroundAudioUrl(null);
                    setBackgroundAudioName(null);
                  }}
                  style={{
                    position: "absolute",
                    right: "12px",
                    background: "none",
                    border: "none",
                    color: "#ef4444",
                    cursor: "pointer",
                    fontSize: "11px",
                    fontWeight: 700
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
        {activeSegment && (
          <div className="trim-inspector">
            <div>
              <div className="trim-field">
                <label htmlFor="trim-start-frame">Start frame</label>
                <input
                  id="trim-start-frame"
                  inputMode="numeric"
                  value={frameDraft.start}
                  onChange={(event) =>
                    setFrameDraft((current) => ({
                      ...current,
                      start: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFrameDraft("start");
                  }}
                  aria-invalid={Boolean(frameRangeError)}
                />
                <button
                  className="frame-step-button"
                  title="One frame earlier"
                  onClick={() =>
                    applyVisibleFrameRange(
                      Math.max(1, draftStartFrame - 1),
                      draftEndFrame,
                      "start"
                    )
                  }
                >
                  −
                </button>
                <button
                  className="frame-step-button"
                  title="One frame later"
                  onClick={() =>
                    applyVisibleFrameRange(
                      draftStartFrame + 1,
                      draftEndFrame,
                      "start"
                    )
                  }
                >
                  +
                </button>
              </div>
              {frameRangeError && <div className="trim-error">{frameRangeError}</div>}
            </div>

            <div className="trim-field">
              <label htmlFor="trim-end-frame">End frame</label>
              <input
                id="trim-end-frame"
                inputMode="numeric"
                value={frameDraft.end}
                onChange={(event) =>
                  setFrameDraft((current) => ({
                    ...current,
                    end: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyFrameDraft("end");
                }}
                aria-invalid={Boolean(frameRangeError)}
              />
              <button
                className="frame-step-button"
                title="One frame earlier"
                onClick={() =>
                  applyVisibleFrameRange(
                    draftStartFrame,
                    draftEndFrame - 1,
                    "end"
                  )
                }
              >
                −
              </button>
              <button
                className="frame-step-button"
                title="One frame later"
                onClick={() =>
                  applyVisibleFrameRange(
                    draftStartFrame,
                    Math.min(activeSourceFrameCount, draftEndFrame + 1),
                    "end"
                  )
                }
              >
                +
              </button>
            </div>

            <div className="trim-duration">
              <strong style={{ display: "block", color: "#fff" }}>
                {draftDurationFrames} frames ·{" "}
                {frameCountToSeconds(draftDurationFrames, timelineFps).toFixed(2)}s
              </strong>
              Source range 1–{activeSourceFrameCount} · 1-based inclusive
            </div>
            <button
              className="done-btn"
              onClick={() => applyFrameDraft("end")}
            >
              Apply frames
            </button>
          </div>
        )}
      </div>
      </>
      )}

      {/* Export Loader Overlay */}
      {exportProgress && (
        <div className="export-overlay">
          {!exportProgress.includes("complete") && !exportProgress.includes("failed") && (
            <div className="export-progress-spinner" />
          )}
          <strong style={{ fontSize: "16px" }}>{exportProgress}</strong>
          {(exportProgress.includes("complete") || exportProgress.includes("failed")) && (
            <button
              className="done-btn"
              style={{ marginTop: "12px" }}
              onClick={() => setExportProgress(null)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </section>
  );
}

async function action(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked"
) {
  const alreadyReady =
    (eventName === "loadedmetadata" &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA) ||
    (eventName === "loadeddata" &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ||
    (eventName === "seeked" && !video.seeking);
  if (alreadyReady) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The browser took too long to prepare this video frame."));
    }, 8000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser could not decode this video."));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function waitForPresentedFrame(video: HTMLVideoElement) {
  if (!("requestVideoFrameCallback" in video)) {
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
  }
  return new Promise<void>((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, 300);
    video.requestVideoFrameCallback(() => finish());
  });
}

async function generateNativeVideoThumbnails(
  file: File | Blob,
  timestamps: number[],
  width: number,
  height: number,
  isCancelled: () => boolean
) {
  const sourceUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  video.style.left = "-10000px";
  document.body.appendChild(video);

  try {
    video.src = sourceUrl;
    video.load();
    await waitForMediaEvent(video, "loadedmetadata");
    await waitForMediaEvent(video, "loadeddata");
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("The native video decoder returned no display size.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not create the thumbnail canvas.");

    const targetRatio = width / height;
    const sourceRatio = video.videoWidth / video.videoHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    if (sourceRatio > targetRatio) {
      sourceWidth = sourceHeight * targetRatio;
      sourceX = (video.videoWidth - sourceWidth) / 2;
    } else if (sourceRatio < targetRatio) {
      sourceHeight = sourceWidth / targetRatio;
      sourceY = (video.videoHeight - sourceHeight) / 2;
    }

    const frames: string[] = [];
    const lastDrawableTime = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 1 / TIMELINE_FPS)
      : Number.POSITIVE_INFINITY;
    for (const timestamp of timestamps) {
      if (isCancelled()) throw new Error("Thumbnail extraction was cancelled.");
      const safeTime = Math.max(0, Math.min(lastDrawableTime, timestamp));
      if (Math.abs(video.currentTime - safeTime) > 0.0005) {
        await seekVideoForThumbnail(video, safeTime);
      }
      await waitForPresentedFrame(video);
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      context.drawImage(
        video,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        width,
        height
      );
      frames.push(canvas.toDataURL("image/jpeg", 0.68));
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(sourceUrl);
  }
}

function seekVideoForThumbnail(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The native video decoder failed while seeking."));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while seeking a timeline thumbnail."));
    }, 8000);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

function formatTimelineTime(seconds: number, fps: number) {
  const totalFrames = Math.max(0, Math.floor(seconds * fps + 0.0001));
  const frame = totalFrames % fps;
  const wholeSeconds = Math.floor(totalFrames / fps);
  const min = Math.floor(wholeSeconds / 60);
  const sec = wholeSeconds % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}:${String(frame).padStart(2, "0")}`;
}
