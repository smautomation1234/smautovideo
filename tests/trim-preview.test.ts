import assert from "node:assert/strict";
import test from "node:test";
import { calculateTrimPreviewRange } from "../src/features/timeline/trim-preview";

test("start trim previews retained frames without changing the original end", () => {
  assert.deepEqual(calculateTrimPreviewRange("start", 0, 240, 48), {
    sourceInFrame: 48,
    sourceOutFrame: 240,
  });
});

test("end trim previews retained frames without changing the original start", () => {
  assert.deepEqual(calculateTrimPreviewRange("end", 0, 240, -72), {
    sourceInFrame: 0,
    sourceOutFrame: 168,
  });
});

test("pointer trimming cannot remove the final retained frame", () => {
  assert.deepEqual(calculateTrimPreviewRange("start", 24, 48, 1000), {
    sourceInFrame: 47,
    sourceOutFrame: 48,
  });
  assert.deepEqual(calculateTrimPreviewRange("end", 24, 48, -1000), {
    sourceInFrame: 24,
    sourceOutFrame: 25,
  });
});

test("dragging outward restores the unchanged initial boundary", () => {
  assert.deepEqual(calculateTrimPreviewRange("start", 24, 120, -20), {
    sourceInFrame: 24,
    sourceOutFrame: 120,
  });
  assert.deepEqual(calculateTrimPreviewRange("end", 24, 120, 20), {
    sourceInFrame: 24,
    sourceOutFrame: 120,
  });
});
