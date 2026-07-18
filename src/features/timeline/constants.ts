/**
 * Gemini Omni Flash video output is natively 24 FPS. Keep the editor,
 * browser-side segmentation, persistence, preview, and export on this single
 * canonical rate so frame numbers always describe the same instant.
 */
export const TIMELINE_FPS = 24;
