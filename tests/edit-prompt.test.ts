import assert from "node:assert/strict";
import test from "node:test";
import { buildEditVideoPrompt } from "../src/features/video-import/edit-prompt";

test("builds one complete edit instruction with dynamic output values", () => {
  const prompt = buildEditVideoPrompt({
    aspectRatio: "9:16",
    resolution: "720p",
    clipNumber: 2,
    totalClips: 4,
    durationSeconds: 8,
  });

  assert.match(prompt, /segment 2 of 4/);
  assert.match(prompt, /exactly 8 seconds, 9:16, 720p/);
  assert.match(prompt, /do not change my voice/);
  assert.match(prompt, /Keep the lip sync exactly as it is/);
  assert.match(prompt, /do not add any ending, outro/);
  assert.match(prompt, /do not add subtitles for every word/);
  assert.equal(prompt.match(/TECHNICAL OUTPUT LOCK:/g)?.length, 1);
});
