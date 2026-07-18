import assert from "node:assert/strict";
import test from "node:test";
import { buildEditVideoPrompt } from "../src/features/video-import/edit-prompt";

test("builds one complete edit instruction with dynamic output values", () => {
  const prompt = buildEditVideoPrompt({
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
  });

  assert.match(prompt, /exactly 8 seconds, 9:16, 720p/);
  assert.match(prompt, /do not change voice and anything at all/);
  assert.match(prompt, /keep the lip sync as it is no matter what/);
  assert.match(prompt, /do not add any like follow thing in between/);
  assert.match(prompt, /do not add subtitles of each word/);
  assert.match(prompt, /paper effect editing/);
  assert.equal(prompt.match(/TECHNICAL OUTPUT LOCK:/g)?.length, 1);
});
