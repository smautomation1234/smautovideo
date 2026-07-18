import assert from "node:assert/strict";
import test from "node:test";
import {
  storedToVisibleFrameRange,
  validateVisibleFrameRange,
  visibleFrameStartSeconds,
} from "../src/features/timeline/frame-range";
import { TIMELINE_FPS } from "../src/features/timeline/constants";

test("full ten-second 24 FPS range is displayed as frames 1 through 240", () => {
  assert.equal(TIMELINE_FPS, 24);
  assert.deepEqual(storedToVisibleFrameRange(0, 240), { start: 1, end: 240 });
  const result = validateVisibleFrameRange(1, 240, 240);
  assert.deepEqual(result, {
    ok: true,
    stored: { sourceInFrame: 0, sourceOutFrame: 240 },
    durationFrames: 240,
  });
});

test("visible frame ranges are inclusive", () => {
  const result = validateVisibleFrameRange(50, 75, 240);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.durationFrames, 26);
    assert.deepEqual(result.stored, {
      sourceInFrame: 49,
      sourceOutFrame: 75,
    });
  }
});

test("frames 49 through 72 are exactly one second at 24 FPS", () => {
  const result = validateVisibleFrameRange(49, 72, 240);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.durationFrames, 24);
  assert.equal(visibleFrameStartSeconds(49, TIMELINE_FPS), 2);
});

test("invalid or out-of-source ranges are rejected", () => {
  assert.equal(validateVisibleFrameRange(0, 10, 240).ok, false);
  assert.equal(validateVisibleFrameRange(20, 10, 240).ok, false);
  assert.equal(validateVisibleFrameRange(1, 241, 240).ok, false);
});
