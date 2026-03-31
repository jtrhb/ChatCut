import { z } from "zod";
import type { ToolDefinition } from "./types.js";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const SearchBgmSchema = z.object({
  mood: z.string().optional(),
  genre: z.string().optional(),
  bpm_range: z
    .object({
      min: z.number(),
      max: z.number(),
    })
    .optional(),
});

export const AddBgmSchema = z.object({
  bgm_id_or_url: z.string(),
  volume: z.number().default(0.5),
});

export const SetAudioVolumeSchema = z.object({
  element_id: z.string(),
  volume: z.number().min(0).max(2),
});

export const TranscribeSchema = z.object({
  media_id: z.string(),
  language: z.string().optional(),
});

export const AutoSubtitleSchema = z.object({
  captions: z.array(
    z.object({
      text: z.string(),
      start: z.number(),
      end: z.number(),
    })
  ),
  style: z.record(z.string(), z.unknown()).optional(),
});

export const GenerateVoiceoverSchema = z.object({
  text: z.string(),
  voice_style: z.string().optional(),
  idempotencyKey: z.string(),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const audioToolDefinitions: ToolDefinition[] = [
  {
    name: "search_bgm",
    description: "Search background music library by mood, genre, and BPM range",
    inputSchema: SearchBgmSchema,
    agentTypes: ["audio"],
    accessMode: "read",
  },
  {
    name: "add_bgm",
    description: "Add a background music track to the timeline",
    inputSchema: AddBgmSchema,
    agentTypes: ["audio"],
    accessMode: "write",
  },
  {
    name: "set_audio_volume",
    description: "Set the volume of an audio-capable timeline element",
    inputSchema: SetAudioVolumeSchema,
    agentTypes: ["audio"],
    accessMode: "write",
  },
  {
    name: "transcribe",
    description: "Transcribe speech from a media asset to text",
    inputSchema: TranscribeSchema,
    agentTypes: ["audio"],
    accessMode: "read",
  },
  {
    name: "auto_subtitle",
    description: "Generate and place subtitle captions on the timeline from a captions array",
    inputSchema: AutoSubtitleSchema,
    agentTypes: ["audio"],
    accessMode: "write",
  },
  {
    name: "generate_voiceover",
    description: "Generate a voiceover audio clip from text using a voice style",
    inputSchema: GenerateVoiceoverSchema,
    agentTypes: ["audio"],
    accessMode: "write",
  },
];
