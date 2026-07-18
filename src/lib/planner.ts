import { z } from "zod";
import { TEXT_MODEL } from "@/lib/env";
import { ProviderHttpError } from "@/lib/provider-error";
import type { Project, ReelPlan } from "@/lib/types";

const clip = z.object({
  clip_number: z.number().int().positive(),
  duration_seconds: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]),
  spoken_line: z.string().min(1),
  prompt: z.string().min(80)
});

export const plan = z.object({
  fact_check_notes: z.string(),
  source_urls: z.array(z.object({ title: z.string(), url: z.string().url() })).max(12),
  dense_fraction: z.number().min(0).max(1),
  word_ceiling: z.number().int().positive(),
  actual_word_count: z.number().int().positive(),
  full_script: z.string().min(1),
  clips: z.array(clip).min(1).max(75)
});

export async function createReelPlan(project: Project): Promise<ReelPlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${apiKey}`;
  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: plannerPrompt(project) }
        ]
      }
    ],
    tools: [
      { googleSearch: {} }
    ]
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    throw new ProviderHttpError(
      503,
      `Could not connect to Gemini: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderHttpError(
      res.status,
      `Gemini API error (HTTP ${res.status}): ${errText.slice(0, 1000)}`
    );
  }

  const body = await res.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  const parsed = plan.parse(extractJson(text));
  const expected = parsed.clips.map((c) => c.clip_number);
  if (expected.some((value, index) => value !== index + 1)) throw new Error("Gemini returned non-sequential clip numbers.");
  const sum = parsed.clips.reduce((total, item) => total + item.duration_seconds, 0);
  if (Math.abs(sum - project.target_duration_seconds) > 4) throw new Error(`Gemini clip map totals ${sum}s, outside the allowed target tolerance.`);

  return parsed;
}

export function cleanJsonText(json: string): string {
  let cleaned = json;
  // 1. Remove single-line and multi-line comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
  // 2. Remove trailing commas before closing braces/brackets
  cleaned = cleaned.replace(/,(\s*[\]}])/g, '$1');
  // 3. Fix common punctuation errors like "...,." or "...]." or "...}."
  cleaned = cleaned.replace(/([\]}"\d])\s*[\.,]+\s*(?=")/g, '$1,');
  return cleaned.trim();
}

function extractJson(text: string) {
  const matches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/ig)];
  let candidate = "";
  if (matches.length > 0) {
    candidate = matches[matches.length - 1][1];
  } else {
    candidate = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  }
  const repaired = cleanJsonText(candidate);
  try {
    return JSON.parse(repaired);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gemini did not return valid plan JSON. ${reason}. Response length: ${candidate.length}.`
    );
  }
}

function plannerPrompt(project: Project) {
  return `You are a fact-checking script editor and Google Gemini Omni Flash prompt writer. Complete the entire task in one response. Use web search before writing. Verify current numbers, specifications, comparisons, product names and dates with official sources first and independent reliable sources when useful.

INPUT
RAW POST:
${project.raw_post}

TARGET TOTAL DURATION: ${project.target_duration_seconds} seconds
OUTPUT: ${project.aspect_ratio}, ${project.resolution}
ONLY STYLE AVAILABLE: Paper Effect + Motion Graphics

SCRIPT RULES
- Rewrite into natural spoken social-video language without losing the post's essential claims.
- Never invent a fact. Correct unsupported claims and explain corrections in fact_check_notes.
- Expand every number, symbol, abbreviation and unit into its natural spoken form before counting: 614 GB/s → six hundred fourteen gigabytes per second; M5 → M five; 83.3% → eighty-three point three percent.
- Do not miss, repeat, or cut off a required spoken word. Avoid tongue-twisting constructions.
- PLAIN pacing = 4.3 spoken words/second. DENSE pacing = 3.3 spoken words/second. A dense line has two or more of: number, unit, model name, comparison.
- Estimate dense_fraction. Effective wps = 1 / ((dense_fraction/3.3)+((1-dense_fraction)/4.3)). Word ceiling = target seconds × 0.85 × effective wps.
- Split only into 4, 6, 8, or 10 second clips. Clip-duration sum must be within 4 seconds of the target.
- Keep each spoken_line conservatively short enough for a natural pace. Do not cram.

OMNI PROMPT RULES
- Every generation is a disconnected session but receives the exact same presenter photo as Image1.
- Repeat the complete full script inside EVERY clip prompt for context.
- Preserve the literal supplied face, skin, hair, body, clothing and facial structure. Do not redesign the person.
- The prompt must clearly state the selected ${project.aspect_ratio} aspect ratio, ${project.resolution}, exact clip duration, static eye-level camera and consistent voice.
- Use premium paper-cut editing: restrained torn-paper reveals, matte tape, halftone texture, brand-aware color coding, useful B-roll/motion graphics and phrase-level static subtitles synchronized exactly to speech. Avoid generic talking-head output.
- Never ask Omni to say compressed symbols. spoken_line is already pronunciation-safe.
- End naturally and do not continue to the next line.

MANDATORY PROMPT TEMPLATE FOR EVERY CLIP (fill it, do not shorten it):
this is full script and i am giving you my image also so keep the character consistent and do not change face structure

{{FULL FINAL SCRIPT}}

{{For clip 2 onward: "till line N-1 video is already done, so start from line N and no need to say anything extra"}}

only speak this line, nothing else, do not continue to any other line even though it's part of the script above:

"{{EXACT SPOKEN LINE}}"

be at natural pace, do not miss any word and do not fumble. Keep it naturally paced. Do not stutter or say any word two times. After finishing, stop naturally. Do not add anything extra.

Create exactly a {{DURATION}}-second ${project.aspect_ratio} ${project.resolution} video.

use paper effect editing, use motion graphics, animations, color coding, and create a video for instagram in full viral format

Return JSON only with exactly this shape:
{
  "fact_check_notes":"plain prose",
  "source_urls":[{"title":"source title","url":"https://..."}],
  "dense_fraction":0.0,
  "word_ceiling":100,
  "actual_word_count":95,
  "full_script":"the complete pronunciation-safe script",
  "clips":[{"clip_number":1,"duration_seconds":10,"spoken_line":"...","prompt":"complete mandatory prompt"}]
}`;
}
