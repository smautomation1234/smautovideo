export interface VisibleFrameRange {
  start: number;
  end: number;
}

export interface StoredFrameRange {
  sourceInFrame: number;
  sourceOutFrame: number;
}

export type FrameRangeValidation =
  | { ok: true; stored: StoredFrameRange; durationFrames: number }
  | { ok: false; message: string };

/**
 * Timeline storage uses a zero-based, half-open range: [sourceIn, sourceOut).
 * The editor displays a one-based, inclusive range because that is easier for
 * people to reason about: frame 1 through frame 240 for a ten-second,
 * 24 FPS source.
 */
export function storedToVisibleFrameRange(
  sourceInFrame: number,
  sourceOutFrame: number
): VisibleFrameRange {
  return {
    start: Math.max(1, Math.trunc(sourceInFrame) + 1),
    end: Math.max(1, Math.trunc(sourceOutFrame)),
  };
}

export function validateVisibleFrameRange(
  start: number,
  end: number,
  sourceFrameCount: number
): FrameRangeValidation {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, message: "Frame values must be whole numbers." };
  }
  if (start < 1) {
    return { ok: false, message: "The first frame is 1." };
  }
  if (end < start) {
    return { ok: false, message: "End frame must be the same as or after Start." };
  }
  const maximum = Math.max(1, Math.trunc(sourceFrameCount));
  if (start > maximum || end > maximum) {
    return {
      ok: false,
      message: `Frame values must stay between 1 and ${maximum}.`,
    };
  }
  return {
    ok: true,
    stored: {
      sourceInFrame: start - 1,
      sourceOutFrame: end,
    },
    durationFrames: end - start + 1,
  };
}

export function frameCountToSeconds(frameCount: number, fps: number) {
  return Math.max(0, frameCount) / Math.max(1, fps);
}

export function visibleFrameStartSeconds(frame: number, fps: number) {
  return Math.max(0, frame - 1) / Math.max(1, fps);
}
