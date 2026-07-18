import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
} from "mediabunny";
import type { AspectRatio } from "@/lib/types";

export interface ExportTimelineClip {
  file: File | Blob;
  sourceInFrame: number;
  sourceOutFrame: number;
  volume: number;
  muted: boolean;
  label: string;
}

interface ExportTimelineOptions {
  clips: ExportTimelineClip[];
  fps: number;
  aspectRatio: AspectRatio;
  originalVolume: number;
  backgroundAudioUrl: string | null;
  backgroundAudioVolume: number;
  onProgress: (message: string) => void;
}

export async function exportTimelineVideo({
  clips,
  fps,
  aspectRatio,
  originalVolume,
  backgroundAudioUrl,
  backgroundAudioVolume,
  onProgress,
}: ExportTimelineOptions) {
  const totalFrames = clips.reduce(
    (total, clip) => total + clip.sourceOutFrame - clip.sourceInFrame,
    0
  );
  if (totalFrames <= 0) throw new Error("The timeline contains no exportable frames.");
  const totalDuration = totalFrames / fps;

  onProgress("Decoding and mixing audio tracks…");
  const audioContext = new AudioContext();
  const offlineContext = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(totalDuration * 48000)),
    48000
  );
  const decodedAudio = new Map<File | Blob, AudioBuffer>();
  let audioStartFrame = 0;

  for (const clip of clips) {
    const durationFrames = clip.sourceOutFrame - clip.sourceInFrame;
    try {
      let decoded = decodedAudio.get(clip.file);
      if (!decoded) {
        decoded = await audioContext.decodeAudioData(await clip.file.arrayBuffer());
        decodedAudio.set(clip.file, decoded);
      }
      const source = offlineContext.createBufferSource();
      source.buffer = decoded;
      const gain = offlineContext.createGain();
      gain.gain.value = clip.muted ? 0 : originalVolume * clip.volume;
      source.connect(gain);
      gain.connect(offlineContext.destination);
      source.start(
        audioStartFrame / fps,
        clip.sourceInFrame / fps,
        durationFrames / fps
      );
    } catch (error) {
      console.warn(`Could not decode audio for ${clip.label}:`, error);
    }
    audioStartFrame += durationFrames;
  }

  if (backgroundAudioUrl) {
    try {
      const response = await fetch(backgroundAudioUrl);
      if (!response.ok) {
        throw new Error(`Background audio request failed (${response.status}).`);
      }
      const decoded = await audioContext.decodeAudioData(
        await response.arrayBuffer()
      );
      const source = offlineContext.createBufferSource();
      source.buffer = decoded;
      source.loop = true;
      const gain = offlineContext.createGain();
      gain.gain.value = backgroundAudioVolume;
      source.connect(gain);
      gain.connect(offlineContext.destination);
      source.start(0, 0, totalDuration);
    } catch (error) {
      console.warn("Could not decode the background audio track:", error);
    }
  }

  const mixedAudio = await offlineContext.startRendering();
  await audioContext.close();

  onProgress(`Initializing ${fps} FPS export stream…`);
  const destination = await createOutputTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: destination.target,
  });

  const width = aspectRatio === "9:16" ? 720 : 1280;
  const height = aspectRatio === "9:16" ? 1280 : 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not initialize the export canvas.");

  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: QUALITY_HIGH,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource);

  const audioSource = new AudioBufferSource({
    codec: "aac",
    bitrate: QUALITY_HIGH,
  });
  output.addAudioTrack(audioSource);

  await output.start();
  await audioSource.add(mixedAudio);
  await audioSource.close();

  let outputFrame = 0;
  for (const clip of clips) {
    const input = new Input({
      source: new BlobSource(clip.file),
      formats: ALL_FORMATS,
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) {
        throw new Error(`${clip.label} cannot be decoded in this browser.`);
      }
      const sink = new CanvasSink(track, {
        width,
        height,
        fit: "contain",
        poolSize: 2,
      });
      const frameCount = clip.sourceOutFrame - clip.sourceInFrame;
      const timestamps = (function* () {
        for (let frame = 0; frame < frameCount; frame += 1) {
          yield (clip.sourceInFrame + frame) / fps;
        }
      })();

      let clipFrames = 0;
      for await (const decoded of sink.canvasesAtTimestamps(timestamps)) {
        if (!decoded) {
          throw new Error(
            `${clip.label} could not decode source frame ${
              clip.sourceInFrame + clipFrames + 1
            }.`
          );
        }
        context.fillStyle = "black";
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.canvas, 0, 0, width, height);
        await videoSource.add(outputFrame / fps, 1 / fps);
        outputFrame += 1;
        clipFrames += 1;
        if (outputFrame % 5 === 0 || outputFrame === totalFrames) {
          onProgress(
            `Compiling frames · ${Math.round((outputFrame / totalFrames) * 100)}%`
          );
        }
      }
      if (clipFrames !== frameCount) {
        throw new Error(
          `${clip.label} decoded ${clipFrames} of ${frameCount} expected frames.`
        );
      }
    } finally {
      input.dispose();
    }
  }

  if (outputFrame !== totalFrames) {
    throw new Error(
      `Export decoded ${outputFrame} of ${totalFrames} expected frames.`
    );
  }

  await videoSource.close();
  await output.finalize();

  if (destination.fileHandle) return destination.fileHandle.getFile();
  const buffer = (destination.target as BufferTarget).buffer;
  if (!buffer?.byteLength) throw new Error("The export engine produced an empty MP4.");
  return new Blob([buffer], { type: "video/mp4" });
}

export function exportFileName(title: string) {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${safe || "reelforge-video"}-final.mp4`;
}

async function createOutputTarget(): Promise<{
  target: StreamTarget | BufferTarget;
  fileHandle: FileSystemFileHandle | null;
}> {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("reelforge-exports-v1", {
      create: true,
    });
    const fileHandle = await directory.getFileHandle("latest-export.mp4", {
      create: true,
    });
    return {
      target: new StreamTarget(await fileHandle.createWritable()),
      fileHandle,
    };
  } catch {
    return {
      target: new BufferTarget(),
      fileHandle: null,
    };
  }
}
