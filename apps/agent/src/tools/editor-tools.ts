import { z } from "zod";
import type { ToolDefinition, ToolCallResult, AgentType } from "./types.js";
import { ToolExecutor } from "./executor.js";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import {
  StateSerializer,
  generateUUID,
  buildEmptyTrack,
  clampAnimationsToDuration,
  splitAnimationsAtTime,
  isVisualElement,
} from "@opencut/core";
import type {
  TimelineElement,
  TimelineTrack,
  TrackType,
  VideoElement,
  AudioElement,
  TextElement,
  StickerElement,
  EffectElement,
  VisualElement,
  Effect,
} from "@opencut/core";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const GetTimelineStateSchema = z.object({});

export const GetElementInfoSchema = z.object({
  element_id: z.string(),
});

export const PreviewFrameSchema = z.object({
  time: z.number().min(0),
});

export const TrimElementSchema = z.object({
  element_id: z.string(),
  trim_start: z.number().optional(),
  trim_end: z.number().optional(),
});

export const SplitElementSchema = z.object({
  element_id: z.string(),
  split_time: z.number(),
});

export const DeleteElementSchema = z.object({
  element_ids: z.array(z.string()),
});

export const MoveElementSchema = z.object({
  element_id: z.string(),
  track_id: z.string().optional(),
  new_start_time: z.number().optional(),
});

export const AddElementSchema = z.object({
  track_id: z.string(),
  type: z.enum(["video", "audio", "text", "sticker", "effect"]),
  start_time: z.number(),
  duration: z.number(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

export const SetSpeedSchema = z.object({
  element_id: z.string(),
  speed: z.number().min(0.1).max(10),
});

export const SetVolumeSchema = z.object({
  element_id: z.string(),
  volume: z.number().min(0).max(2),
});

export const AddTransitionSchema = z.object({
  element_id: z.string(),
  transition_type: z.string(),
  duration: z.number().default(0.5),
});

export const AddEffectSchema = z.object({
  element_id: z.string(),
  effect_type: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateTextSchema = z.object({
  element_id: z.string(),
  text: z.string().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});

export const AddKeyframeSchema = z.object({
  element_id: z.string(),
  property: z.string(),
  time: z.number(),
  value: z.unknown(),
  easing: z.string().optional(),
});

export const ReorderElementsSchema = z.object({
  track_id: z.string(),
  element_ids: z.array(z.string()),
});

export const BatchEditSchema = z.object({
  operations: z.array(
    z.object({
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
  ),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

const READ_AGENTS: AgentType[] = ["editor", "master"];
const WRITE_AGENTS: AgentType[] = ["editor"];

export const EDITOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  // Read tools
  {
    name: "get_timeline_state",
    description: "Returns compressed timeline JSON",
    inputSchema: GetTimelineStateSchema,
    agentTypes: READ_AGENTS,
    accessMode: "read",
  },
  {
    name: "get_element_info",
    description: "Returns element details by ID",
    inputSchema: GetElementInfoSchema,
    agentTypes: READ_AGENTS,
    accessMode: "read",
  },
  {
    name: "preview_frame",
    description: "Returns frame data at a given time",
    inputSchema: PreviewFrameSchema,
    agentTypes: READ_AGENTS,
    accessMode: "read",
  },

  // Write tools
  {
    name: "trim_element",
    description: "Trim an element's start and/or end",
    inputSchema: TrimElementSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "split_element",
    description: "Split an element at a given time",
    inputSchema: SplitElementSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "delete_element",
    description: "Delete one or more elements by ID",
    inputSchema: DeleteElementSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "move_element",
    description: "Move an element to a different track or time position",
    inputSchema: MoveElementSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "add_element",
    description: "Add a new element to a track",
    inputSchema: AddElementSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "set_speed",
    description: "Set playback speed for an element",
    inputSchema: SetSpeedSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "set_volume",
    description: "Set volume for an audio-capable element",
    inputSchema: SetVolumeSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "add_transition",
    description: "Add a transition to an element",
    inputSchema: AddTransitionSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "add_effect",
    description: "Add a visual effect to an element",
    inputSchema: AddEffectSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "update_text",
    description: "Update text content and/or style of a text element",
    inputSchema: UpdateTextSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "add_keyframe",
    description: "Add an animation keyframe to an element property",
    inputSchema: AddKeyframeSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "reorder_elements",
    description: "Reorder elements within a track",
    inputSchema: ReorderElementsSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
  {
    name: "batch_edit",
    description: "Execute multiple edit operations atomically",
    inputSchema: BatchEditSchema,
    agentTypes: WRITE_AGENTS,
    accessMode: "write",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find an element across all tracks, returning both element and its track. */
function findElement(
  tracks: TimelineTrack[],
  elementId: string
): { track: TimelineTrack; element: TimelineElement } | null {
  for (const track of tracks) {
    const element = track.elements.find((el) => el.id === elementId);
    if (element) return { track, element };
  }
  return null;
}

/** Immutably update one element across tracks by ID. */
function updateElementInTracks(
  tracks: TimelineTrack[],
  elementId: string,
  updater: (el: TimelineElement) => TimelineElement
): TimelineTrack[] {
  return tracks.map((track) => {
    const idx = track.elements.findIndex((el) => el.id === elementId);
    if (idx === -1) return track;
    const newElements = [...track.elements];
    newElements[idx] = updater(newElements[idx]);
    return { ...track, elements: newElements } as TimelineTrack;
  });
}

/** Build a minimal element for the given track type. */
function buildElement(
  type: "video" | "audio" | "text" | "sticker" | "effect",
  startTime: number,
  duration: number,
  properties?: Record<string, unknown>
): TimelineElement {
  const id = generateUUID();
  const base = {
    id,
    name: `${type} element`,
    startTime,
    duration,
    trimStart: 0,
    trimEnd: 0,
  };

  switch (type) {
    case "video":
      return {
        ...base,
        type: "video",
        mediaId: (properties?.mediaId as string) ?? "",
        transform: (properties?.transform as VideoElement["transform"]) ?? {
          scale: 1,
          position: { x: 0, y: 0 },
          rotate: 0,
        },
        opacity: (properties?.opacity as number) ?? 1,
      } as VideoElement;
    case "audio":
      return {
        ...base,
        type: "audio",
        sourceType: "upload",
        mediaId: (properties?.mediaId as string) ?? "",
        volume: (properties?.volume as number) ?? 1,
      } as AudioElement;
    case "text":
      return {
        ...base,
        type: "text",
        content: (properties?.content as string) ?? "",
        fontSize: (properties?.fontSize as number) ?? 48,
        fontFamily: (properties?.fontFamily as string) ?? "Inter",
        color: (properties?.color as string) ?? "#ffffff",
        background: {
          enabled: false,
          color: "#000000",
        },
        textAlign: "center",
        fontWeight: "normal",
        fontStyle: "normal",
        textDecoration: "none",
        transform: (properties?.transform as TextElement["transform"]) ?? {
          scale: 1,
          position: { x: 0, y: 0 },
          rotate: 0,
        },
        opacity: 1,
      } as TextElement;
    case "sticker":
      return {
        ...base,
        type: "sticker",
        stickerId: (properties?.stickerId as string) ?? "",
        transform: (properties?.transform as StickerElement["transform"]) ?? {
          scale: 1,
          position: { x: 0, y: 0 },
          rotate: 0,
        },
        opacity: 1,
      } as StickerElement;
    case "effect":
      return {
        ...base,
        type: "effect",
        effectType: (properties?.effectType as string) ?? "",
        params: (properties?.params as Record<string, number>) ?? {},
      } as EffectElement;
  }
}

// ── EditorToolExecutor ───────────────────────────────────────────────────────

/**
 * Executes editor tools by directly computing new track state and applying it
 * via the EditorCore's timeline manager. This avoids the singleton dependency
 * that Command subclasses have, making it safe for server-side use where
 * EditorCore instances are not the global singleton.
 */
export class EditorToolExecutor extends ToolExecutor {
  constructor(private serverCore: ServerEditorCore) {
    super();
    for (const def of EDITOR_TOOL_DEFINITIONS) {
      this.register(def);
    }
  }

  protected async executeImpl(
    toolName: string,
    input: unknown,
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult> {
    try {
      switch (toolName) {
        case "get_timeline_state":
          return this._getTimelineState();
        case "get_element_info":
          return this._getElementInfo(input as z.infer<typeof GetElementInfoSchema>);
        case "preview_frame":
          return this._previewFrame(input as z.infer<typeof PreviewFrameSchema>);
        case "trim_element":
          return this._trimElement(input as z.infer<typeof TrimElementSchema>);
        case "split_element":
          return this._splitElement(input as z.infer<typeof SplitElementSchema>);
        case "delete_element":
          return this._deleteElement(input as z.infer<typeof DeleteElementSchema>);
        case "move_element":
          return this._moveElement(input as z.infer<typeof MoveElementSchema>);
        case "add_element":
          return this._addElement(input as z.infer<typeof AddElementSchema>);
        case "set_speed":
          return this._setSpeed(input as z.infer<typeof SetSpeedSchema>);
        case "set_volume":
          return this._setVolume(input as z.infer<typeof SetVolumeSchema>);
        case "add_transition":
          return this._addTransition(input as z.infer<typeof AddTransitionSchema>);
        case "add_effect":
          return this._addEffect(input as z.infer<typeof AddEffectSchema>);
        case "update_text":
          return this._updateText(input as z.infer<typeof UpdateTextSchema>);
        case "add_keyframe":
          return this._addKeyframe(input as z.infer<typeof AddKeyframeSchema>);
        case "reorder_elements":
          return this._reorderElements(input as z.infer<typeof ReorderElementsSchema>);
        case "batch_edit":
          return this._batchEdit(
            input as z.infer<typeof BatchEditSchema>,
            context
          );
        default:
          return { success: false, error: `Unhandled tool: "${toolName}"` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Get current tracks from the wrapped EditorCore. */
  private _getTracks(): TimelineTrack[] {
    return this.serverCore.editorCore.timeline.getTracks();
  }

  /**
   * Apply a new tracks state. This directly updates the scene's tracks
   * via the TimelineManager, which does not use the EditorCore singleton.
   * Also bumps the ServerEditorCore snapshot version to track mutations.
   */
  private _applyTracks(newTracks: TimelineTrack[]): void {
    this.serverCore.editorCore.timeline.updateTracks(newTracks);
    // Manually increment version since we bypass executeAgentCommand
    (this.serverCore as unknown as { _version: number })._version++;
  }

  // ── Read tools ───────────────────────────────────────────────────────────

  private _getTimelineState(): ToolCallResult {
    const core = this.serverCore.editorCore;
    const scenes = core.scenes.getScenes();
    const duration = core.timeline.getTotalDuration();
    const json = StateSerializer.serialize(scenes, duration);
    return { success: true, data: json };
  }

  private _getElementInfo(input: { element_id: string }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }
    return {
      success: true,
      data: {
        element: found.element,
        trackId: found.track.id,
        trackType: found.track.type,
      },
    };
  }

  private _previewFrame(input: { time: number }): ToolCallResult {
    const tracks = this._getTracks();
    const elementsAtTime: Array<{
      elementId: string;
      trackId: string;
      type: string;
    }> = [];

    for (const track of tracks) {
      for (const el of track.elements) {
        if (
          input.time >= el.startTime &&
          input.time < el.startTime + el.duration
        ) {
          elementsAtTime.push({
            elementId: el.id,
            trackId: track.id,
            type: el.type,
          });
        }
      }
    }

    return {
      success: true,
      data: { time: input.time, elements: elementsAtTime },
    };
  }

  // ── Write tools ──────────────────────────────────────────────────────────

  private _trimElement(input: {
    element_id: string;
    trim_start?: number;
    trim_end?: number;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const trimStart = input.trim_start ?? found.element.trimStart;
    const trimEnd = input.trim_end ?? found.element.trimEnd;

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => ({
      ...el,
      trimStart,
      trimEnd,
      animations: clampAnimationsToDuration({
        animations: el.animations,
        duration: el.duration,
      }),
    }));

    this._applyTracks(newTracks);
    return { success: true, data: { element_id: input.element_id, trimStart, trimEnd } };
  }

  private _splitElement(input: {
    element_id: string;
    split_time: number;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const el = found.element;
    const effectiveStart = el.startTime;
    const effectiveEnd = el.startTime + el.duration;

    if (input.split_time <= effectiveStart || input.split_time >= effectiveEnd) {
      return {
        success: false,
        error: `Split time ${input.split_time} is outside element bounds [${effectiveStart}, ${effectiveEnd})`,
      };
    }

    const relativeTime = input.split_time - el.startTime;
    const leftDuration = relativeTime;
    const rightDuration = el.duration - relativeTime;

    const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
      animations: el.animations,
      splitTime: relativeTime,
      shouldIncludeSplitBoundary: true,
    });

    const rightId = generateUUID();

    const leftElement = {
      ...el,
      duration: leftDuration,
      trimEnd: el.trimEnd + rightDuration,
      name: `${el.name} (left)`,
      animations: leftAnimations,
    };

    const rightElement = {
      ...el,
      id: rightId,
      startTime: input.split_time,
      duration: rightDuration,
      trimStart: el.trimStart + leftDuration,
      name: `${el.name} (right)`,
      animations: rightAnimations,
    };

    const newTracks = tracks.map((track) => {
      if (track.id !== found.track.id) return track;
      const newElements = track.elements.flatMap((e) =>
        e.id === input.element_id ? [leftElement, rightElement] : [e]
      );
      return { ...track, elements: newElements } as TimelineTrack;
    });

    this._applyTracks(newTracks);

    return {
      success: true,
      data: {
        original_id: input.element_id,
        created_element_ids: [rightId],
      },
    };
  }

  private _deleteElement(input: { element_ids: string[] }): ToolCallResult {
    const tracks = this._getTracks();

    // Validate all exist
    for (const id of input.element_ids) {
      if (!findElement(tracks, id)) {
        return { success: false, error: `Element not found: "${id}"` };
      }
    }

    const idsToDelete = new Set(input.element_ids);
    const newTracks = tracks.map((track) => {
      const filtered = track.elements.filter((el) => !idsToDelete.has(el.id));
      return { ...track, elements: filtered } as TimelineTrack;
    });

    this._applyTracks(newTracks);
    return { success: true, data: { deleted: input.element_ids } };
  }

  private _moveElement(input: {
    element_id: string;
    track_id?: string;
    new_start_time?: number;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const targetTrackId = input.track_id ?? found.track.id;
    const newStartTime = input.new_start_time ?? found.element.startTime;
    const isSameTrack = targetTrackId === found.track.id;

    const movedElement = { ...found.element, startTime: newStartTime };

    let newTracks: TimelineTrack[];
    if (isSameTrack) {
      newTracks = updateElementInTracks(tracks, input.element_id, () => movedElement);
    } else {
      // Remove from source, add to target
      newTracks = tracks.map((track) => {
        if (track.id === found.track.id) {
          return {
            ...track,
            elements: track.elements.filter((el) => el.id !== input.element_id),
          } as TimelineTrack;
        }
        if (track.id === targetTrackId) {
          return {
            ...track,
            elements: [...track.elements, movedElement],
          } as TimelineTrack;
        }
        return track;
      });
    }

    this._applyTracks(newTracks);
    return {
      success: true,
      data: { element_id: input.element_id, track_id: targetTrackId, start_time: newStartTime },
    };
  }

  private _addElement(input: {
    track_id: string;
    type: "video" | "audio" | "text" | "sticker" | "effect";
    start_time: number;
    duration: number;
    properties?: Record<string, unknown>;
  }): ToolCallResult {
    const tracks = this._getTracks();

    const element = buildElement(
      input.type,
      input.start_time,
      input.duration,
      input.properties
    );

    const existingTrack = tracks.find((t) => t.id === input.track_id);
    let newTracks: TimelineTrack[];
    if (existingTrack) {
      newTracks = tracks.map((t) => {
        if (t.id !== input.track_id) return t;
        return { ...t, elements: [...t.elements, element] } as TimelineTrack;
      });
    } else {
      const newTrack = buildEmptyTrack({
        id: input.track_id,
        type: input.type as TrackType,
      });
      newTracks = [...tracks, { ...newTrack, elements: [element] } as TimelineTrack];
    }

    this._applyTracks(newTracks);

    return {
      success: true,
      data: { element_id: element.id, track_id: input.track_id },
    };
  }

  private _setSpeed(input: { element_id: string; speed: number }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => ({
      ...el,
      speed: input.speed,
    } as unknown as TimelineElement));

    this._applyTracks(newTracks);
    return { success: true, data: { element_id: input.element_id, speed: input.speed } };
  }

  private _setVolume(input: {
    element_id: string;
    volume: number;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => ({
      ...el,
      volume: input.volume,
    } as unknown as TimelineElement));

    this._applyTracks(newTracks);
    return { success: true, data: { element_id: input.element_id, volume: input.volume } };
  }

  private _addTransition(input: {
    element_id: string;
    transition_type: string;
    duration: number;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => ({
      ...el,
      transition: {
        type: input.transition_type,
        duration: input.duration,
      },
    } as unknown as TimelineElement));

    this._applyTracks(newTracks);
    return {
      success: true,
      data: {
        element_id: input.element_id,
        transition_type: input.transition_type,
        duration: input.duration,
      },
    };
  }

  private _addEffect(input: {
    element_id: string;
    effect_type: string;
    params?: Record<string, unknown>;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    if (!isVisualElement(found.element)) {
      return { success: false, error: `Element "${input.element_id}" does not support effects` };
    }

    const effect: Effect = {
      id: generateUUID(),
      type: input.effect_type,
      params: (input.params ?? {}) as Effect["params"],
      enabled: true,
    };

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => {
      const visual = el as VisualElement;
      return {
        ...visual,
        effects: [...(visual.effects ?? []), effect],
      } as unknown as TimelineElement;
    });

    this._applyTracks(newTracks);
    return {
      success: true,
      data: { element_id: input.element_id, effect_type: input.effect_type },
    };
  }

  private _updateText(input: {
    element_id: string;
    text?: string;
    style?: Record<string, unknown>;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    const updates: Record<string, unknown> = {};
    if (input.text !== undefined) updates.content = input.text;
    if (input.style) Object.assign(updates, input.style);

    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => ({
      ...el,
      ...updates,
    } as TimelineElement));

    this._applyTracks(newTracks);
    return { success: true, data: { element_id: input.element_id, ...updates } };
  }

  private _addKeyframe(input: {
    element_id: string;
    property: string;
    time: number;
    value?: unknown;
    easing?: string;
  }): ToolCallResult {
    const tracks = this._getTracks();
    const found = findElement(tracks, input.element_id);
    if (!found) {
      return { success: false, error: `Element not found: "${input.element_id}"` };
    }

    // Store keyframe metadata on the element as a lightweight approach
    // that avoids the singleton-dependent UpsertKeyframeCommand
    const newTracks = updateElementInTracks(tracks, input.element_id, (el) => {
      const keyframes = ((el as unknown as Record<string, unknown>).agentKeyframes as Array<Record<string, unknown>>) ?? [];
      return {
        ...el,
        agentKeyframes: [
          ...keyframes,
          {
            property: input.property,
            time: input.time,
            value: input.value,
            easing: input.easing,
          },
        ],
      } as unknown as TimelineElement;
    });

    this._applyTracks(newTracks);
    return {
      success: true,
      data: {
        element_id: input.element_id,
        property: input.property,
        time: input.time,
      },
    };
  }

  private _reorderElements(input: {
    track_id: string;
    element_ids: string[];
  }): ToolCallResult {
    const tracks = this._getTracks();
    const track = tracks.find((t) => t.id === input.track_id);
    if (!track) {
      return { success: false, error: `Track not found: "${input.track_id}"` };
    }

    const reordered = input.element_ids
      .map((id) => track.elements.find((el) => el.id === id))
      .filter((el): el is TimelineElement => el != null);

    const remaining = track.elements.filter(
      (el) => !input.element_ids.includes(el.id)
    );
    const newElements = [...reordered, ...remaining];
    const newTracks = tracks.map((t) => {
      if (t.id !== input.track_id) return t;
      return { ...t, elements: newElements } as TimelineTrack;
    });

    this._applyTracks(newTracks);
    return { success: true, data: { track_id: input.track_id, order: input.element_ids } };
  }

  private async _batchEdit(
    input: { operations: Array<{ tool: string; input: Record<string, unknown> }> },
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult> {
    const results: ToolCallResult[] = [];

    for (const op of input.operations) {
      const tool = this.tools.get(op.tool);
      if (!tool) {
        return { success: false, error: `Unknown tool in batch: "${op.tool}"` };
      }
      if (op.tool === "batch_edit") {
        return { success: false, error: "Nested batch_edit is not allowed" };
      }

      const parsed = tool.inputSchema.safeParse(op.input);
      if (!parsed.success) {
        return {
          success: false,
          error: `Validation failed for "${op.tool}": ${parsed.error.message}`,
        };
      }

      const result = await this.executeImpl(op.tool, parsed.data, context);
      if (!result.success) {
        return {
          success: false,
          error: `Batch operation "${op.tool}" failed: ${result.error}`,
        };
      }
      results.push(result);
    }

    return { success: true, data: { results } };
  }
}
