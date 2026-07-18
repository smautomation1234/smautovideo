export type TrimEdge = "start" | "end";

export interface TrimPreviewRange {
  sourceInFrame: number;
  sourceOutFrame: number;
}

/**
 * Calculates an inward trim without changing the committed timeline item.
 * The initial range remains the visual shell until pointer release, which
 * prevents neighboring clips from rippling while the user is still dragging.
 */
export function calculateTrimPreviewRange(
  edge: TrimEdge,
  initialSourceInFrame: number,
  initialSourceOutFrame: number,
  deltaFrames: number
): TrimPreviewRange {
  const sourceInFrame = Math.max(0, Math.trunc(initialSourceInFrame));
  const sourceOutFrame = Math.max(
    sourceInFrame + 1,
    Math.trunc(initialSourceOutFrame)
  );
  const delta = Math.trunc(deltaFrames);

  if (edge === "start") {
    return {
      sourceInFrame: Math.max(
        sourceInFrame,
        Math.min(sourceOutFrame - 1, sourceInFrame + delta)
      ),
      sourceOutFrame,
    };
  }

  return {
    sourceInFrame,
    sourceOutFrame: Math.max(
      sourceInFrame + 1,
      Math.min(sourceOutFrame, sourceOutFrame + delta)
    ),
  };
}
