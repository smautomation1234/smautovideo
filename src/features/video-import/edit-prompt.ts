export interface EditVideoPromptInput {
  aspectRatio: string;
  resolution: string;
  clipNumber: number;
  totalClips: number;
  durationSeconds: number;
}

export function buildEditVideoPrompt({
  aspectRatio,
  resolution,
  clipNumber,
  totalClips,
  durationSeconds,
}: EditVideoPromptInput): string {
  return `This is a short part of my video that I recorded, so keep my character consistent and do not change my voice or anything about me. Do not change the video pacing; keep it the same as my original video.

Keep the lip sync exactly as it is no matter what. I want you to keep the video exactly how mine started and exactly how mine ended, with the same pacing and timing. I want only an edited version of my video.

This is segment ${clipNumber} of ${totalClips} from a longer video, so keep it continuous with the surrounding parts. This is not the last part of my video, so do not add any ending, outro, or "like", "follow", or "subscribe" message in between.

Also, do not add subtitles for every word I am saying. I do not want word-by-word captions, karaoke text, or transcription.

TECHNICAL OUTPUT LOCK: exactly ${durationSeconds} seconds, ${aspectRatio}, ${resolution}. Keep the original synchronized audio and timing.

Edit the video as it is from start to end using paper-effect editing, motion graphics, animations, and color coding, and create an engaging Instagram-style video. Apply these visual edits without changing my character, voice, lip sync, pacing, timing, original start, or original end.`;
}
