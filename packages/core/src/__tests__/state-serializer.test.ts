import { describe, it, expect } from "vitest";
import { StateSerializer } from "../state-serializer";
import type { TScene, VideoTrack, AudioTrack, TextTrack } from "../types/timeline";

// --- Mock data helpers ---

function makeVideoElement(overrides: Record<string, unknown> = {}) {
  return {
    id: "vel-1",
    name: "Clip 1",
    type: "video" as const,
    mediaId: "media-1",
    startTime: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: 0,
    sourceDuration: 10,
    muted: false,
    hidden: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    // non-essential fields that should be stripped
    renderNode: { canvas: {}, ctx: {} },
    waveformData: new Float32Array([0.1, 0.2]),
    ...overrides,
  };
}

function makeAudioElement(overrides: Record<string, unknown> = {}) {
  return {
    id: "ael-1",
    name: "Audio 1",
    type: "audio" as const,
    sourceType: "upload" as const,
    mediaId: "media-2",
    startTime: 1,
    duration: 4,
    trimStart: 0,
    trimEnd: 0,
    volume: 1,
    muted: false,
    buffer: { arrayBuffer: [] },
  };
}

function makeScene(overrides: Partial<TScene> = {}): TScene {
  const videoTrack: VideoTrack = {
    id: "track-1",
    name: "Video 1",
    type: "video",
    isMain: true,
    muted: false,
    hidden: false,
    elements: [makeVideoElement() as any],
  };

  const audioTrack: AudioTrack = {
    id: "track-2",
    name: "Audio 1",
    type: "audio",
    muted: false,
    elements: [makeAudioElement() as any],
  };

  return {
    id: "scene-1",
    name: "Main Scene",
    isMain: true,
    tracks: [videoTrack, audioTrack],
    bookmarks: [],
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

// --- Tests ---

describe("StateSerializer", () => {
  it("strips non-essential fields (renderNode, waveformData, buffer, transform, etc.)", () => {
    const scene = makeScene();
    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);

    const el = parsed.scenes[0].tracks[0].elements[0];
    expect(el).not.toHaveProperty("renderNode");
    expect(el).not.toHaveProperty("waveformData");
    expect(el).not.toHaveProperty("transform");
    expect(el).not.toHaveProperty("opacity");
    expect(el).not.toHaveProperty("mediaId");
    expect(el).not.toHaveProperty("sourceType");
    expect(el).not.toHaveProperty("muted");
    expect(el).not.toHaveProperty("hidden");
    expect(el).not.toHaveProperty("sourceDuration");
    expect(el).not.toHaveProperty("blendMode");
    expect(el).not.toHaveProperty("effects");
    expect(el).not.toHaveProperty("animations");
  });

  it("only includes essential fields (id, name, type, startTime, duration)", () => {
    const scene = makeScene();
    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);

    const el = parsed.scenes[0].tracks[0].elements[0];
    expect(el).toHaveProperty("id");
    expect(el).toHaveProperty("name");
    expect(el).toHaveProperty("type");
    expect(el).toHaveProperty("startTime");
    expect(el).toHaveProperty("duration");
  });

  it("omits default speed=1 and volume=1", () => {
    const audioEl = {
      ...makeAudioElement(),
      volume: 1,
    };
    const audioTrack: AudioTrack = {
      id: "track-2",
      name: "Audio",
      type: "audio",
      muted: false,
      elements: [audioEl as any],
    };
    const scene: TScene = {
      id: "scene-1",
      name: "Scene",
      isMain: true,
      tracks: [audioTrack],
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);
    const el = parsed.scenes[0].tracks[0].elements[0];

    expect(el).not.toHaveProperty("volume");
    expect(el).not.toHaveProperty("speed");
  });

  it("omits trimStart=0 and trimEnd=0", () => {
    const scene = makeScene();
    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);

    const el = parsed.scenes[0].tracks[0].elements[0];
    expect(el).not.toHaveProperty("trimStart");
    expect(el).not.toHaveProperty("trimEnd");
  });

  it("includes non-default speed and volume", () => {
    const audioEl = {
      ...makeAudioElement(),
      volume: 0.5,
      speed: 1.5,
    };
    const audioTrack: AudioTrack = {
      id: "track-2",
      name: "Audio",
      type: "audio",
      muted: false,
      elements: [audioEl as any],
    };
    const scene: TScene = {
      id: "scene-1",
      name: "Scene",
      isMain: true,
      tracks: [audioTrack],
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);
    const el = parsed.scenes[0].tracks[0].elements[0];

    expect(el.volume).toBe(0.5);
    expect(el.speed).toBe(1.5);
  });

  it("includes non-zero trimStart and trimEnd", () => {
    const videoEl = makeVideoElement({ trimStart: 0.5, trimEnd: 1.25 });
    const videoTrack: VideoTrack = {
      id: "track-1",
      name: "Video",
      type: "video",
      isMain: true,
      muted: false,
      hidden: false,
      elements: [videoEl as any],
    };
    const scene: TScene = {
      id: "scene-1",
      name: "Scene",
      isMain: true,
      tracks: [videoTrack],
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const json = StateSerializer.serialize([scene], 10);
    const parsed = JSON.parse(json);
    const el = parsed.scenes[0].tracks[0].elements[0];

    expect(el.trimStart).toBe(0.5);
    expect(el.trimEnd).toBe(1.25);
  });

  it("rounds times to 3 decimal places", () => {
    const videoEl = makeVideoElement({
      startTime: 1.123456789,
      duration: 2.987654321,
      trimStart: 0.000499,
      trimEnd: 0.000501,
    });
    const videoTrack: VideoTrack = {
      id: "track-1",
      name: "Video",
      type: "video",
      isMain: true,
      muted: false,
      hidden: false,
      elements: [videoEl as any],
    };
    const scene: TScene = {
      id: "scene-1",
      name: "Scene",
      isMain: true,
      tracks: [videoTrack],
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const json = StateSerializer.serialize([scene], 10.123456);
    const parsed = JSON.parse(json);

    expect(parsed.duration).toBe(10.123);
    const el = parsed.scenes[0].tracks[0].elements[0];
    expect(el.startTime).toBe(1.123);
    expect(el.duration).toBe(2.988);
    // trimStart=0.000499 rounds to 0 → omitted entirely
    expect(el.trimStart).toBeUndefined();
    // trimEnd=0.000501 rounds to 0.001 → included
    expect(el.trimEnd).toBe(0.001);
  });

  it("produces compact JSON under 2000 tokens for typical 5-track 10-element timeline", () => {
    // Build 5 tracks x 10 elements each
    const tracks: VideoTrack[] = Array.from({ length: 5 }, (_, ti) => ({
      id: `track-${ti}`,
      name: `Track ${ti}`,
      type: "video" as const,
      isMain: ti === 0,
      muted: false,
      hidden: false,
      elements: Array.from({ length: 10 }, (_, ei) =>
        makeVideoElement({
          id: `el-${ti}-${ei}`,
          name: `Clip ${ti}-${ei}`,
          startTime: ei * 3,
          duration: 2.5,
        }) as any
      ),
    }));

    const scene: TScene = {
      id: "scene-big",
      name: "Big Scene",
      isMain: true,
      tracks,
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const json = StateSerializer.serialize([scene], 150);
    // Approximate token count: 1 token ≈ 4 chars for JSON
    const approxTokens = json.length / 4;
    expect(approxTokens).toBeLessThan(2000);
  });

  it("roundtrips essential fields via serialize→deserialize", () => {
    const scene = makeScene();
    const json = StateSerializer.serialize([scene], 10, 3.5);
    const view = StateSerializer.deserialize(json);

    expect(view.duration).toBe(10);
    expect(view.currentTime).toBe(3.5);
    expect(view.scenes).toHaveLength(1);
    expect(view.scenes[0].id).toBe("scene-1");
    expect(view.scenes[0].name).toBe("Main Scene");
    expect(view.scenes[0].tracks).toHaveLength(2);

    const firstTrack = view.scenes[0].tracks[0];
    expect(firstTrack.id).toBe("track-1");
    expect(firstTrack.type).toBe("video");
    expect(firstTrack.elements).toHaveLength(1);

    const el = firstTrack.elements[0];
    expect(el.id).toBe("vel-1");
    expect(el.name).toBe("Clip 1");
    expect(el.type).toBe("video");
    expect(el.startTime).toBe(0);
    expect(el.duration).toBe(5);
  });
});
