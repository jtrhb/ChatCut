import type { TScene, TimelineTrack, TimelineElement } from "./types/timeline";

export interface AgentTimelineView {
  scenes: Array<{
    id: string;
    name: string;
    tracks: Array<{
      id: string;
      type: string;
      muted: boolean;
      hidden: boolean;
      elements: Array<{
        id: string;
        name: string;
        type: string;
        startTime: number;
        duration: number;
        trimStart?: number;
        trimEnd?: number;
        speed?: number;
        volume?: number;
      }>;
    }>;
  }>;
  duration: number;
  currentTime: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function serializeElement(el: TimelineElement & { speed?: number; volume?: number }): AgentTimelineView["scenes"][0]["tracks"][0]["elements"][0] | null {
  const startTime = round3(el.startTime);
  const duration = round3(el.duration);

  const out: AgentTimelineView["scenes"][0]["tracks"][0]["elements"][0] = {
    id: el.id,
    name: el.name,
    type: el.type,
    startTime,
    duration,
  };

  // trimStart / trimEnd: omit if zero
  const trimStart = round3(el.trimStart ?? 0);
  const trimEnd = round3(el.trimEnd ?? 0);
  if (trimStart !== 0) out.trimStart = trimStart;
  if (trimEnd !== 0) out.trimEnd = trimEnd;

  // speed: omit if default (1) or absent
  if (el.speed !== undefined && el.speed !== 1) {
    out.speed = el.speed;
  }

  // volume: omit if default (1) or absent
  if ("volume" in el && (el as { volume?: number }).volume !== undefined && (el as { volume?: number }).volume !== 1) {
    out.volume = (el as { volume: number }).volume;
  }

  return out;
}

function serializeTrack(track: TimelineTrack): AgentTimelineView["scenes"][0]["tracks"][0] {
  const muted = "muted" in track ? (track.muted as boolean) : false;
  const hidden = "hidden" in track ? (track.hidden as boolean) : false;

  const elements = (track.elements as (TimelineElement & { speed?: number; volume?: number })[])
    .map(serializeElement)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return {
    id: track.id,
    type: track.type,
    muted,
    hidden,
    elements,
  };
}

export class StateSerializer {
  static serialize(scenes: TScene[], duration: number, currentTime = 0): string {
    const view: AgentTimelineView = {
      scenes: scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        tracks: scene.tracks.map(serializeTrack),
      })),
      duration: round3(duration),
      currentTime: round3(currentTime),
    };

    return JSON.stringify(view);
  }

  static deserialize(json: string): AgentTimelineView {
    return JSON.parse(json) as AgentTimelineView;
  }
}
