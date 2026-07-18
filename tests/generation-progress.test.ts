import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDisplayedProgress,
  generationProgressTarget,
} from "../src/features/generation/progress";

const createdAt = "2026-01-01T00:00:00.000Z";
const start = Date.parse(createdAt);

test("estimated progress advances one point every two seconds and caps at 99", () => {
  assert.equal(
    generationProgressTarget({
      status: "waiting_external",
      createdAt,
      startedAt: createdAt,
      playable: false,
      now: start,
    }),
    1
  );
  assert.equal(
    generationProgressTarget({
      status: "waiting_external",
      createdAt,
      startedAt: createdAt,
      playable: false,
      now: start + 64_000,
    }),
    33
  );
  assert.equal(
    generationProgressTarget({
      status: "waiting_external",
      createdAt,
      startedAt: createdAt,
      playable: false,
      now: start + 500_000,
    }),
    99
  );
});

test("progress reaches 100 only when completed media is playable", () => {
  assert.equal(
    generationProgressTarget({
      status: "completed",
      createdAt,
      startedAt: createdAt,
      playable: false,
    }),
    99
  );
  assert.equal(
    generationProgressTarget({
      status: "completed",
      createdAt,
      startedAt: createdAt,
      playable: true,
    }),
    100
  );
  assert.equal(advanceDisplayedProgress(33, 100), 50);
});

