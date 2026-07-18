"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  calculateSegments,
  encodeVideoSegments,
} from "@/features/video-import/segment-video";

export function EditVideoForm() {
  const router = useRouter();
  const videoInput = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "16:9">("9:16");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleVideoSelect = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) {
      setError("Please select a video file (MP4, WebM, or MOV).");
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setError("Video must be under 500 MB.");
      return;
    }
    setVideoFile(file);
    setError(null);

    // Get duration from the video
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      setVideoDuration(video.duration);
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      setError("Could not read video metadata. Try a different format.");
      URL.revokeObjectURL(url);
    };
    video.src = url;
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleVideoSelect(file);
    },
    [handleVideoSelect]
  );

  const segmentPlan = videoDuration ? calculateSegments(videoDuration) : [];
  const omniSegments = segmentPlan.filter((s) => s.omniDuration > 0);
  const rawAppendSegment = segmentPlan.find((s) => s.appendRaw);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!videoFile) return setError("Drop or select a video to edit.");
    if (!videoDuration || videoDuration < 4) return setError("Video must be at least 4 seconds long.");
    if (!title.trim()) return setError("Enter a project title.");

    setBusy(true);
    setError(null);

    let projectId: string | null = null;
    try {
      setProgress("Creating project…");
      const targetDuration = segmentPlan.reduce(
        (sum, segment) =>
          sum + (segment.omniDuration || segment.durationSec),
        0
      );
      const created = await jsonFetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          raw_post: "Edit mode — video segments uploaded directly for Omni editing.",
          target_duration_seconds: Math.max(4, Math.round(targetDuration)),
          aspect_ratio: aspectRatio,
          resolution: "720p",
          style: "paper_motion",
          mode: "edit_video",
        }),
      });
      projectId = created.project.id;

      const uploadedSegments: Array<{
        chunk_number: number;
        storage_path: string;
        duration_seconds: number;
        omni_duration: number;
        append_raw: boolean;
      }> = [];

      let segmentIndex = 0;
      for await (const encoded of encodeVideoSegments(
        videoFile,
        segmentPlan,
        setProgress
      )) {
        segmentIndex += 1;
        setProgress(`Uploading segment ${segmentIndex} of ${segmentPlan.length}…`);

        const chunkSigned = await jsonFetch(`/api/projects/${projectId}/assets/sign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `segment-${segmentIndex}.mp4`,
            type: "video/mp4",
            size: encoded.blob.size,
          }),
        });

        const { error: chunkUploadError } = await createClient()
          .storage.from("project-assets")
          .uploadToSignedUrl(chunkSigned.path, chunkSigned.token, encoded.blob, { contentType: "video/mp4" });
        if (chunkUploadError) throw new Error(`Segment ${segmentIndex} upload failed: ${chunkUploadError.message}`);

        await jsonFetch(`/api/projects/${projectId}/assets/confirm-chunk`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: chunkSigned.path, content_type: "video/mp4" }),
        });

        uploadedSegments.push({
          chunk_number: encoded.plan.chunkNumber,
          storage_path: chunkSigned.path,
          duration_seconds: encoded.plan.durationSec,
          omni_duration: encoded.plan.omniDuration,
          append_raw: encoded.plan.appendRaw || false,
        });
      }

      setProgress("Starting Omni video editing pipeline…");
      await jsonFetch(`/api/projects/${projectId}/edit-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: uploadedSegments }),
      });

      router.push(`/studio/${projectId}`);
    } catch (caught) {
      if (projectId) {
        await fetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
      }
      setError(caught instanceof Error ? caught.message : "Processing failed.");
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <form className="panel project-form" onSubmit={submit}>
      <div className="section-title">
        <h2>Edit a video</h2>
        <span>Omni Editing</span>
      </div>

      <label>
        Project title
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="My raw footage → edited Reel"
        />
      </label>

      {/* Video Drop Zone */}
      <div
        ref={dropZoneRef}
        className={`video-drop-zone ${isDragging ? "dragging" : ""} ${videoFile ? "has-file" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => videoInput.current?.click()}
      >
        {videoFile ? (
          <div className="video-file-info">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
            <div>
              <strong>{videoFile.name}</strong>
              <span>
                {(videoFile.size / 1024 / 1024).toFixed(1)} MB
                {videoDuration ? ` · ${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="remove-video-btn"
              onClick={(e) => {
                e.stopPropagation();
                setVideoFile(null);
                setVideoDuration(null);
                if (videoInput.current) videoInput.current.value = "";
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="drop-zone-placeholder">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" opacity="0.3">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
            </svg>
            <span>Drop your raw video here</span>
            <span className="drop-zone-hint">MP4, WebM, or MOV · up to 500 MB</span>
          </div>
        )}
        <input
          ref={videoInput}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleVideoSelect(file);
          }}
        />
      </div>

      {/* Segment preview */}
      {videoDuration && segmentPlan.length > 0 && (
        <div className="segment-preview">
          <div className="segment-preview-header">
            <span>{omniSegments.length} segment{omniSegments.length !== 1 ? "s" : ""} → Omni</span>
            {rawAppendSegment && (
              <span className="segment-raw-note">+{rawAppendSegment.durationSec.toFixed(1)}s raw tail appended</span>
            )}
          </div>
          <div className="segment-bar">
            {segmentPlan.map((seg) => (
              <div
                key={seg.chunkNumber}
                className={`segment-block ${seg.appendRaw ? "raw" : ""}`}
                style={{
                  width: `${(seg.durationSec / videoDuration) * 100}%`,
                }}
                title={
                  seg.appendRaw
                    ? `${seg.durationSec.toFixed(1)}s raw (appended without editing)`
                    : `${seg.durationSec.toFixed(1)}s → Omni ${seg.omniDuration}s`
                }
              >
                <span>{seg.appendRaw ? "raw" : `${seg.omniDuration}s`}</span>
              </div>
            ))}
          </div>

          {/* Segment Details Table */}
          <div className="segment-details-container" style={{ marginTop: '16px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'rgba(255, 255, 255, 0.05)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <th style={{ padding: '10px 12px', fontWeight: '600', color: '#a1a1aa' }}>Segment</th>
                  <th style={{ padding: '10px 12px', fontWeight: '600', color: '#a1a1aa' }}>Timestamp Range</th>
                  <th style={{ padding: '10px 12px', fontWeight: '600', color: '#a1a1aa' }}>Crop Duration</th>
                  <th style={{ padding: '10px 12px', fontWeight: '600', color: '#a1a1aa' }}>Target Mode</th>
                </tr>
              </thead>
              <tbody>
                {segmentPlan.map((seg) => {
                  const formatTime = (secs: number) => {
                    const m = Math.floor(secs / 60);
                    const s = Math.floor(secs % 60);
                    const ms = Math.round((secs % 1) * 10);
                    return `${m}:${String(s).padStart(2, "0")}.${ms}`;
                  };
                  const startStr = formatTime(seg.startSec);
                  const endStr = formatTime(seg.startSec + seg.durationSec);
                  return (
                    <tr key={seg.chunkNumber} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)', color: '#e4e4e7' }}>
                      <td style={{ padding: '10px 12px', fontWeight: '600' }}>Segment {seg.chunkNumber}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#38bdf8' }}>{startStr} – {endStr}</td>
                      <td style={{ padding: '10px 12px', fontWeight: '500' }}>{seg.durationSec.toFixed(2)}s</td>
                      <td style={{ padding: '10px 12px' }}>
                        {seg.appendRaw ? (
                          <span style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>
                            Raw Append (No Editing)
                          </span>
                        ) : (
                          <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>
                            Omni Flash ({seg.omniDuration}s output)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="two-columns">
        <label>
          Aspect ratio
          <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as "9:16" | "16:9")}>
            <option value="9:16">9:16 · Instagram Reel</option>
            <option value="16:9">16:9 · Landscape</option>
          </select>
        </label>
        <label>
          Visual style
          <select value="paper_motion" disabled>
            <option>Paper Effect + Motion Graphics</option>
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      {progress && <p className="edit-progress">{progress}</p>}

      <button className="button button-primary" disabled={busy}>
        {busy ? progress || "Processing…" : "Split & send to Omni"}
      </button>
    </form>
  );
}

async function jsonFetch(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Server returned non-JSON response (${response.status}): ${text.substring(0, 150)}`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}
