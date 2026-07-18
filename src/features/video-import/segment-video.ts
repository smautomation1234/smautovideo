import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type WrappedAudioBuffer,
} from "mediabunny";
import { TIMELINE_FPS } from "@/features/timeline/constants";

export interface SegmentPlan {
  chunkNumber: number;
  startSec: number;
  durationSec: number;
  omniDuration: 0 | 4 | 6 | 8 | 10;
  appendRaw?: boolean;
}

export interface EncodedVideoSegment {
  plan: SegmentPlan;
  blob: Blob;
}

export function calculateSegments(totalDuration: number): SegmentPlan[] {
  const chunkDuration = 10;
  const fullChunks = Math.floor(totalDuration / chunkDuration);
  const remainder = Number((totalDuration - fullChunks * chunkDuration).toFixed(3));
  const segments: SegmentPlan[] = [];

  for (let index = 0; index < fullChunks; index += 1) {
    segments.push({
      chunkNumber: index + 1,
      startSec: index * chunkDuration,
      durationSec: chunkDuration,
      omniDuration: 10,
    });
  }

  if (remainder <= 0) return segments;

  const common = {
    chunkNumber: fullChunks + 1,
    startSec: fullChunks * chunkDuration,
    durationSec: remainder,
  };
  if (remainder < 4) {
    segments.push({ ...common, omniDuration: 0, appendRaw: true });
  } else if (remainder <= 4) {
    segments.push({ ...common, omniDuration: 4 });
  } else if (remainder <= 6) {
    segments.push({ ...common, omniDuration: 6 });
  } else if (remainder <= 8) {
    segments.push({ ...common, omniDuration: 8 });
  } else {
    segments.push({ ...common, omniDuration: 10 });
  }

  return segments;
}

export async function* encodeVideoSegments(
  sourceFile: File,
  plans: SegmentPlan[],
  onProgress?: (message: string) => void
): AsyncGenerator<EncodedVideoSegment> {
  const input = new Input({
    source: new BlobSource(sourceFile),
    formats: ALL_FORMATS,
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) {
      throw new Error("This browser cannot decode the uploaded video's video track.");
    }

    const width = evenDimension(videoTrack.displayWidth || 1280);
    const height = evenDimension(videoTrack.displayHeight || 720);
    const videoSink = new CanvasSink(videoTrack, {
      width,
      height,
      fit: "contain",
      poolSize: 2,
    });

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioSink = audioTrack && await audioTrack.canDecode()
      ? new AudioBufferSink(audioTrack)
      : null;

    for (let segmentIndex = 0; segmentIndex < plans.length; segmentIndex += 1) {
      const plan = plans[segmentIndex];
      onProgress?.(`Encoding segment ${segmentIndex + 1} of ${plans.length} locally…`);

      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat(),
        target,
      });

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not initialize the browser video canvas.");

      const canvasSource = new CanvasSource(canvas, {
        codec: "avc",
        bitrate: QUALITY_HIGH,
        keyFrameInterval: 2,
      });
      output.addVideoTrack(canvasSource);

      const segmentAudio = audioSink
        ? await renderSegmentAudio(audioSink, plan.startSec, plan.durationSec)
        : null;
      let audioSource: AudioBufferSource | null = null;
      if (segmentAudio) {
        audioSource = new AudioBufferSource({
          codec: "aac",
          bitrate: QUALITY_HIGH,
        });
        output.addAudioTrack(audioSource);
      }

      await output.start();
      if (audioSource && segmentAudio) {
        await audioSource.add(segmentAudio);
        await audioSource.close();
      }

      const frameCount = Math.max(1, Math.round(plan.durationSec * TIMELINE_FPS));
      const timestamps = (function* () {
        for (let frame = 0; frame < frameCount; frame += 1) {
          yield plan.startSec + frame / TIMELINE_FPS;
        }
      })();

      let encodedFrames = 0;
      for await (const decoded of videoSink.canvasesAtTimestamps(timestamps)) {
        context.fillStyle = "black";
        context.fillRect(0, 0, width, height);
        if (decoded) context.drawImage(decoded.canvas, 0, 0, width, height);
        await canvasSource.add(encodedFrames / TIMELINE_FPS, 1 / TIMELINE_FPS);
        encodedFrames += 1;
      }

      if (encodedFrames !== frameCount) {
        throw new Error(
          `Segment ${segmentIndex + 1} decoded ${encodedFrames} of ${frameCount} expected frames.`
        );
      }

      await canvasSource.close();
      await output.finalize();
      if (!target.buffer?.byteLength) {
        throw new Error(`Segment ${segmentIndex + 1} produced an empty MP4.`);
      }

      yield {
        plan,
        blob: new Blob([target.buffer], { type: "video/mp4" }),
      };
    }
  } finally {
    input.dispose();
  }
}

async function renderSegmentAudio(
  sink: AudioBufferSink,
  startSeconds: number,
  durationSeconds: number
) {
  const endSeconds = startSeconds + durationSeconds;
  const buffers: WrappedAudioBuffer[] = [];
  for await (const wrapped of sink.buffers(
    Math.max(0, startSeconds - 1),
    endSeconds
  )) {
    const bufferEnd = wrapped.timestamp + wrapped.duration;
    if (bufferEnd > startSeconds && wrapped.timestamp < endSeconds) {
      buffers.push(wrapped);
    }
  }
  if (!buffers.length) return null;

  const sampleRate = buffers[0].buffer.sampleRate;
  const channelCount = Math.max(
    1,
    ...buffers.map((item) => item.buffer.numberOfChannels)
  );
  const context = new OfflineAudioContext(
    channelCount,
    Math.max(1, Math.ceil(durationSeconds * sampleRate)),
    sampleRate
  );

  for (const wrapped of buffers) {
    const intersectionStart = Math.max(startSeconds, wrapped.timestamp);
    const intersectionEnd = Math.min(
      endSeconds,
      wrapped.timestamp + wrapped.buffer.duration
    );
    const intersectionDuration = intersectionEnd - intersectionStart;
    if (intersectionDuration <= 0) continue;

    const source = context.createBufferSource();
    source.buffer = wrapped.buffer;
    source.connect(context.destination);
    source.start(
      intersectionStart - startSeconds,
      intersectionStart - wrapped.timestamp,
      intersectionDuration
    );
  }

  return context.startRendering();
}

function evenDimension(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}
