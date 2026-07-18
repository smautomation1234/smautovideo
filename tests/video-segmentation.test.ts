import assert from "node:assert/strict";
import test from "node:test";
import { calculateSegments } from "../src/features/video-import/segment-video";

test("uses Omni's exact four-second duration when the remainder is four seconds", () => {
  assert.deepEqual(calculateSegments(14).map((segment) => segment.omniDuration), [
    10,
    4,
  ]);
});

test("keeps a tail shorter than four seconds as raw media", () => {
  const segments = calculateSegments(13);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].durationSec, 3);
  assert.equal(segments[1].omniDuration, 0);
  assert.equal(segments[1].appendRaw, true);
});

test("rounds supported Omni output durations without losing source boundaries", () => {
  const segments = calculateSegments(25);
  assert.deepEqual(
    segments.map(({ startSec, durationSec, omniDuration }) => ({
      startSec,
      durationSec,
      omniDuration,
    })),
    [
      { startSec: 0, durationSec: 10, omniDuration: 10 },
      { startSec: 10, durationSec: 10, omniDuration: 10 },
      { startSec: 20, durationSec: 5, omniDuration: 6 },
    ]
  );
});
