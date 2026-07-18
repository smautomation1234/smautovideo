import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicateTimelineItemAfter,
  normalizeTimelineItems,
  rescaleTimelineItemsFps,
  splitTimelineItemAtFrame,
} from "../src/features/timeline/domain";
import type { TimelineItem } from "../src/lib/types";

function item(id: string, start: number, end: number, order = 0): TimelineItem {
  return {
    id,
    timeline_id: "00000000-0000-4000-8000-000000000001",
    clip_id: "00000000-0000-4000-8000-000000000002",
    take_id: "00000000-0000-4000-8000-000000000003",
    order_index: order,
    source_in_frame: start,
    source_out_frame: end,
    volume: 1,
    muted: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("normalizes timeline order without mutating inputs", () => {
  const original = [item("a", 0, 25, 8), item("b", 0, 25, 9)];
  const normalized = normalizeTimelineItems(original);
  assert.deepEqual(normalized.map((value) => value.order_index), [0, 1]);
  assert.deepEqual(original.map((value) => value.order_index), [8, 9]);
});

test("paste inserts a new independent item after the selected item", () => {
  const original = [item("a", 0, 250), item("b", 25, 100, 1)];
  const snapshot = original.map((value) => ({ ...value }));
  const result = duplicateTimelineItemAfter(original, original[0], "b", "copy");
  assert.deepEqual(result.items.map((value) => value.id), ["a", "b", "copy"]);
  assert.equal(result.duplicate.source_out_frame, 250);
  assert.notEqual(result.duplicate.id, original[0].id);
  assert.deepEqual(original, snapshot);
  assert.notEqual(result.duplicate, original[0]);
});

test("split preserves every source frame exactly once", () => {
  const original = [item("a", 10, 110)];
  const result = splitTimelineItemAtFrame(original, "a", 60, "right");
  assert.ok(result);
  assert.equal(result.left.source_in_frame, 10);
  assert.equal(result.left.source_out_frame, 60);
  assert.equal(result.right.source_in_frame, 60);
  assert.equal(result.right.source_out_frame, 110);
  assert.equal(
    result.items.reduce(
      (frames, value) => frames + value.source_out_frame - value.source_in_frame,
      0
    ),
    100
  );
});

test("split rejects a cut on either clip boundary", () => {
  const original = [item("a", 10, 110)];
  assert.equal(splitTimelineItemAtFrame(original, "a", 10), null);
  assert.equal(splitTimelineItemAtFrame(original, "a", 110), null);
});

test("legacy 25 FPS boundaries rescale to 24 FPS without changing time", () => {
  const [result] = rescaleTimelineItemsFps([item("a", 50, 250)], 25, 24);
  assert.equal(result.source_in_frame, 48);
  assert.equal(result.source_out_frame, 240);
  assert.equal(result.source_in_frame / 24, 2);
  assert.equal(result.source_out_frame / 24, 10);
});
