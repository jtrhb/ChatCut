import { describe, it, expect } from "vitest";
import {
  SearchBgmSchema,
  AddBgmSchema,
  SetAudioVolumeSchema,
  TranscribeSchema,
  AutoSubtitleSchema,
  GenerateVoiceoverSchema,
  audioToolDefinitions,
} from "../audio-tools.js";

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Audio Tool Schemas", () => {
  describe("search_bgm", () => {
    it("accepts empty object (all fields optional)", () => {
      expect(SearchBgmSchema.safeParse({}).success).toBe(true);
    });

    it("accepts mood only", () => {
      expect(SearchBgmSchema.safeParse({ mood: "happy" }).success).toBe(true);
    });

    it("accepts full input with bpm_range", () => {
      expect(
        SearchBgmSchema.safeParse({
          mood: "energetic",
          genre: "electronic",
          bpm_range: { min: 120, max: 160 },
        }).success
      ).toBe(true);
    });

    it("rejects non-object input", () => {
      expect(SearchBgmSchema.safeParse("bad").success).toBe(false);
    });

    it("rejects bpm_range missing min", () => {
      expect(
        SearchBgmSchema.safeParse({ bpm_range: { max: 160 } }).success
      ).toBe(false);
    });
  });

  describe("add_bgm", () => {
    it("accepts bgm_id_or_url only (volume defaults to 0.5)", () => {
      const result = AddBgmSchema.safeParse({ bgm_id_or_url: "bgm-1" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.volume).toBe(0.5);
      }
    });

    it("accepts explicit volume", () => {
      expect(
        AddBgmSchema.safeParse({ bgm_id_or_url: "bgm-1", volume: 0.8 }).success
      ).toBe(true);
    });

    it("rejects missing bgm_id_or_url", () => {
      expect(AddBgmSchema.safeParse({ volume: 0.5 }).success).toBe(false);
    });

    it("rejects non-string bgm_id_or_url", () => {
      expect(AddBgmSchema.safeParse({ bgm_id_or_url: 123 }).success).toBe(false);
    });
  });

  describe("set_audio_volume", () => {
    it("accepts valid element_id and volume", () => {
      expect(
        SetAudioVolumeSchema.safeParse({ element_id: "el-1", volume: 1.0 }).success
      ).toBe(true);
    });

    it("accepts volume at min boundary (0)", () => {
      expect(
        SetAudioVolumeSchema.safeParse({ element_id: "el-1", volume: 0 }).success
      ).toBe(true);
    });

    it("accepts volume at max boundary (2)", () => {
      expect(
        SetAudioVolumeSchema.safeParse({ element_id: "el-1", volume: 2 }).success
      ).toBe(true);
    });

    it("rejects volume below 0", () => {
      expect(
        SetAudioVolumeSchema.safeParse({ element_id: "el-1", volume: -0.1 }).success
      ).toBe(false);
    });

    it("rejects volume above 2", () => {
      expect(
        SetAudioVolumeSchema.safeParse({ element_id: "el-1", volume: 2.1 }).success
      ).toBe(false);
    });

    it("rejects missing element_id", () => {
      expect(SetAudioVolumeSchema.safeParse({ volume: 1.0 }).success).toBe(false);
    });
  });

  describe("transcribe", () => {
    it("accepts media_id only", () => {
      expect(TranscribeSchema.safeParse({ media_id: "media-1" }).success).toBe(true);
    });

    it("accepts optional language", () => {
      expect(
        TranscribeSchema.safeParse({ media_id: "media-1", language: "en" }).success
      ).toBe(true);
    });

    it("rejects missing media_id", () => {
      expect(TranscribeSchema.safeParse({ language: "en" }).success).toBe(false);
    });

    it("rejects non-string media_id", () => {
      expect(TranscribeSchema.safeParse({ media_id: 42 }).success).toBe(false);
    });
  });

  describe("auto_subtitle", () => {
    it("accepts valid captions array", () => {
      expect(
        AutoSubtitleSchema.safeParse({
          captions: [{ text: "Hello", start: 0, end: 2 }],
        }).success
      ).toBe(true);
    });

    it("accepts captions with optional style", () => {
      expect(
        AutoSubtitleSchema.safeParse({
          captions: [{ text: "Hello", start: 0, end: 2 }],
          style: { fontSize: 24, color: "white" },
        }).success
      ).toBe(true);
    });

    it("rejects missing captions", () => {
      expect(AutoSubtitleSchema.safeParse({}).success).toBe(false);
    });

    it("rejects captions with missing text", () => {
      expect(
        AutoSubtitleSchema.safeParse({
          captions: [{ start: 0, end: 2 }],
        }).success
      ).toBe(false);
    });

    it("rejects non-array captions", () => {
      expect(
        AutoSubtitleSchema.safeParse({
          captions: "not-an-array",
        }).success
      ).toBe(false);
    });
  });

  describe("generate_voiceover", () => {
    it("accepts text and idempotencyKey", () => {
      expect(
        GenerateVoiceoverSchema.safeParse({
          text: "Welcome to the show",
          idempotencyKey: "idem-vo-1",
        }).success
      ).toBe(true);
    });

    it("accepts optional voice_style", () => {
      expect(
        GenerateVoiceoverSchema.safeParse({
          text: "Welcome to the show",
          voice_style: "calm",
          idempotencyKey: "idem-vo-2",
        }).success
      ).toBe(true);
    });

    it("rejects missing idempotencyKey", () => {
      expect(
        GenerateVoiceoverSchema.safeParse({ text: "Hello world" }).success
      ).toBe(false);
    });

    it("rejects missing text", () => {
      expect(
        GenerateVoiceoverSchema.safeParse({ idempotencyKey: "idem-vo-3" }).success
      ).toBe(false);
    });
  });
});

// ── Tool Definition Tests ────────────────────────────────────────────────────

describe("audioToolDefinitions", () => {
  it("contains exactly 6 tools", () => {
    expect(audioToolDefinitions).toHaveLength(6);
  });

  it("all tools have agentType 'audio'", () => {
    for (const tool of audioToolDefinitions) {
      expect(tool.agentTypes).toContain("audio");
    }
  });

  it("has unique tool names", () => {
    const names = audioToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("search_bgm is a read tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "search_bgm");
    expect(tool?.accessMode).toBe("read");
  });

  it("add_bgm is a write tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "add_bgm");
    expect(tool?.accessMode).toBe("write");
  });

  it("set_audio_volume is a write tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "set_audio_volume");
    expect(tool?.accessMode).toBe("write");
  });

  it("transcribe is a read tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "transcribe");
    expect(tool?.accessMode).toBe("read");
  });

  it("auto_subtitle is a write tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "auto_subtitle");
    expect(tool?.accessMode).toBe("write");
  });

  it("generate_voiceover is a write tool", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "generate_voiceover");
    expect(tool?.accessMode).toBe("write");
  });
});
