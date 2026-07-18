export interface EditVideoPromptInput {
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
}

export function buildEditVideoPrompt({
  aspectRatio,
  resolution,
  durationSeconds,
}: EditVideoPromptInput): string {
  return `this is a short part of my video that i recorded so keep my character consistent and do not change voice and anything at all , do not change video pacing , keep it same as of mine
also keep the lip sync as it is no matter what , i want you to keep the video exactly how mine started and exactly how mine ended same pacing , same timing , i want only edited version of my video 
although it is not the last part of my video so do not add any like follow thing in between
also do not add subtitles of each word i am saying i dont like that
TECHNICAL OUTPUT LOCK: exactly ${durationSeconds} seconds, ${aspectRatio}, ${resolution}
you have to edit the video as it is from start to end by using paper effect editing , use motion graphics , animations , color coding ,add proper sound effects also and create a video for instagram in full viral format`;
}
