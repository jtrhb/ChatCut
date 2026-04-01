import { describe, it, expect } from "vitest";
import {
  DispatchVisionSchema,
  DispatchEditorSchema,
  DispatchCreatorSchema,
  DispatchAudioSchema,
  DispatchAssetSchema,
  ExploreOptionsSchema,
  ProposeChangesSchema,
  ExportVideoSchema,
  masterToolDefinitions,
} from "../master-tools.js";

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Master Tool Schemas", () => {
  describe("dispatch_vision", () => {
    it("accepts task string only", () => {
      expect(
        DispatchVisionSchema.safeParse({ task: "Analyze the timeline" }).success
      ).toBe(true);
    });

    it("accepts task with optional context and constraints", () => {
      expect(
        DispatchVisionSchema.safeParse({
          task: "Analyze the timeline",
          context: { key: "value" },
          constraints: { maxIterations: 5, timeoutMs: 30000 },
        }).success
      ).toBe(true);
    });

    it("rejects missing task", () => {
      expect(DispatchVisionSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string task", () => {
      expect(DispatchVisionSchema.safeParse({ task: 42 }).success).toBe(false);
    });
  });

  describe("dispatch_editor", () => {
    it("accepts task string only (defaults accessMode to read_write)", () => {
      const result = DispatchEditorSchema.safeParse({
        task: "Trim the clip",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.accessMode).toBe("read_write");
      }
    });

    it("accepts explicit accessMode values", () => {
      for (const mode of ["read", "write", "read_write"] as const) {
        expect(
          DispatchEditorSchema.safeParse({ task: "Do something", accessMode: mode }).success
        ).toBe(true);
      }
    });

    it("rejects invalid accessMode", () => {
      expect(
        DispatchEditorSchema.safeParse({ task: "Do something", accessMode: "execute" }).success
      ).toBe(false);
    });

    it("rejects missing task", () => {
      expect(DispatchEditorSchema.safeParse({ accessMode: "read" }).success).toBe(false);
    });

    it("accepts context and constraints", () => {
      expect(
        DispatchEditorSchema.safeParse({
          task: "Edit the timeline",
          context: { projectId: "proj-1" },
          constraints: { maxIterations: 10, timeoutMs: 60000 },
        }).success
      ).toBe(true);
    });
  });

  describe("dispatch_creator", () => {
    it("accepts task string only", () => {
      expect(
        DispatchCreatorSchema.safeParse({ task: "Generate a clip" }).success
      ).toBe(true);
    });

    it("accepts task with context and constraints", () => {
      expect(
        DispatchCreatorSchema.safeParse({
          task: "Generate a clip",
          context: { style: "cinematic" },
          constraints: { maxIterations: 3 },
        }).success
      ).toBe(true);
    });

    it("rejects missing task", () => {
      expect(DispatchCreatorSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("dispatch_audio", () => {
    it("accepts task string only", () => {
      expect(
        DispatchAudioSchema.safeParse({ task: "Mix the audio" }).success
      ).toBe(true);
    });

    it("accepts task with context", () => {
      expect(
        DispatchAudioSchema.safeParse({
          task: "Mix the audio",
          context: { targetLoudness: -14 },
        }).success
      ).toBe(true);
    });

    it("rejects missing task", () => {
      expect(DispatchAudioSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("dispatch_asset", () => {
    it("accepts task string only", () => {
      expect(
        DispatchAssetSchema.safeParse({ task: "Find stock footage" }).success
      ).toBe(true);
    });

    it("accepts task with context", () => {
      expect(
        DispatchAssetSchema.safeParse({
          task: "Find stock footage",
          context: { keywords: ["nature", "sunset"] },
        }).success
      ).toBe(true);
    });

    it("rejects missing task", () => {
      expect(DispatchAssetSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("explore_options", () => {
    const baseCandidate = {
      label: "Option A",
      summary: "A simple cut",
      candidateType: "trim",
      commands: [],
      expectedMetrics: { durationChange: "-2s", affectedElements: 1 },
    };

    const validBase = {
      intent: "Make it shorter",
      baseSnapshotVersion: 1,
      timelineSnapshot: "{}",
      candidates: [baseCandidate, baseCandidate, baseCandidate],
    };

    it("accepts exactly 3 candidates", () => {
      expect(ExploreOptionsSchema.safeParse(validBase).success).toBe(true);
    });

    it("accepts exactly 4 candidates", () => {
      expect(
        ExploreOptionsSchema.safeParse({
          ...validBase,
          candidates: [...validBase.candidates, baseCandidate],
        }).success
      ).toBe(true);
    });

    it("rejects fewer than 3 candidates (2)", () => {
      expect(
        ExploreOptionsSchema.safeParse({
          ...validBase,
          candidates: [baseCandidate, baseCandidate],
        }).success
      ).toBe(false);
    });

    it("rejects more than 4 candidates (5)", () => {
      expect(
        ExploreOptionsSchema.safeParse({
          ...validBase,
          candidates: [
            baseCandidate,
            baseCandidate,
            baseCandidate,
            baseCandidate,
            baseCandidate,
          ],
        }).success
      ).toBe(false);
    });

    it("rejects missing intent", () => {
      const { intent: _intent, ...rest } = validBase;
      expect(ExploreOptionsSchema.safeParse(rest).success).toBe(false);
    });

    it("rejects missing baseSnapshotVersion", () => {
      const { baseSnapshotVersion: _v, ...rest } = validBase;
      expect(ExploreOptionsSchema.safeParse(rest).success).toBe(false);
    });

    it("rejects non-number baseSnapshotVersion", () => {
      expect(
        ExploreOptionsSchema.safeParse({ ...validBase, baseSnapshotVersion: "v1" }).success
      ).toBe(false);
    });

    it("rejects missing timelineSnapshot", () => {
      const { timelineSnapshot: _ts, ...rest } = validBase;
      expect(ExploreOptionsSchema.safeParse(rest).success).toBe(false);
    });

    it("rejects candidate missing label", () => {
      const { label: _label, ...noLabel } = baseCandidate;
      expect(
        ExploreOptionsSchema.safeParse({
          ...validBase,
          candidates: [noLabel, baseCandidate, baseCandidate],
        }).success
      ).toBe(false);
    });
  });

  describe("propose_changes", () => {
    it("accepts summary and affectedElements", () => {
      expect(
        ProposeChangesSchema.safeParse({
          summary: "Trimmed opening clip by 2s",
          affectedElements: ["el-1", "el-2"],
        }).success
      ).toBe(true);
    });

    it("accepts empty affectedElements array", () => {
      expect(
        ProposeChangesSchema.safeParse({
          summary: "No elements changed",
          affectedElements: [],
        }).success
      ).toBe(true);
    });

    it("rejects missing summary", () => {
      expect(
        ProposeChangesSchema.safeParse({ affectedElements: ["el-1"] }).success
      ).toBe(false);
    });

    it("rejects missing affectedElements", () => {
      expect(
        ProposeChangesSchema.safeParse({ summary: "Something changed" }).success
      ).toBe(false);
    });

    it("rejects non-array affectedElements", () => {
      expect(
        ProposeChangesSchema.safeParse({
          summary: "Changed",
          affectedElements: "el-1",
        }).success
      ).toBe(false);
    });
  });

  describe("export_video", () => {
    it("defaults format to mp4 and quality to standard", () => {
      const result = ExportVideoSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.format).toBe("mp4");
        expect(result.data.quality).toBe("standard");
      }
    });

    it("accepts explicit format", () => {
      const result = ExportVideoSchema.safeParse({ format: "webm" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.format).toBe("webm");
      }
    });

    it("accepts valid quality values", () => {
      for (const quality of ["preview", "standard", "high"] as const) {
        const result = ExportVideoSchema.safeParse({ quality });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.quality).toBe(quality);
        }
      }
    });

    it("rejects invalid quality", () => {
      expect(
        ExportVideoSchema.safeParse({ quality: "ultra" }).success
      ).toBe(false);
    });
  });
});

// ── Tool Definition Tests ────────────────────────────────────────────────────

describe("masterToolDefinitions", () => {
  it("defines exactly 9 tools", () => {
    expect(masterToolDefinitions).toHaveLength(9);
  });

  it("all tools are restricted to master agent only", () => {
    for (const tool of masterToolDefinitions) {
      expect(tool.agentTypes).toEqual(["master"]);
    }
  });

  it("has unique tool names", () => {
    const names = masterToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("dispatch_vision has read accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_vision");
    expect(tool?.accessMode).toBe("read");
  });

  it("dispatch_editor has read_write accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_editor");
    expect(tool?.accessMode).toBe("read_write");
  });

  it("dispatch_creator has read_write accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_creator");
    expect(tool?.accessMode).toBe("read_write");
  });

  it("dispatch_audio has read_write accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_audio");
    expect(tool?.accessMode).toBe("read_write");
  });

  it("dispatch_asset has read accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_asset");
    expect(tool?.accessMode).toBe("read");
  });

  it("explore_options has read accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "explore_options");
    expect(tool?.accessMode).toBe("read");
  });

  it("propose_changes has write accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "propose_changes");
    expect(tool?.accessMode).toBe("write");
  });

  it("export_video has read accessMode", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "export_video");
    expect(tool?.accessMode).toBe("read");
  });

  it("all dispatch tools accept task string", () => {
    const dispatchTools = masterToolDefinitions.filter((t) =>
      t.name.startsWith("dispatch_")
    );
    expect(dispatchTools).toHaveLength(6);
    for (const tool of dispatchTools) {
      const result = tool.inputSchema.safeParse({ task: "Do something" });
      expect(result.success).toBe(true);
    }
  });

  it("all dispatch tools reject missing task", () => {
    const dispatchTools = masterToolDefinitions.filter((t) =>
      t.name.startsWith("dispatch_")
    );
    for (const tool of dispatchTools) {
      const result = tool.inputSchema.safeParse({});
      expect(result.success).toBe(false);
    }
  });

  it("explore_options rejects 2 candidates", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "explore_options")!;
    const candidate = {
      label: "A",
      summary: "s",
      candidateType: "trim",
      commands: [],
      expectedMetrics: { durationChange: "0s", affectedElements: 0 },
    };
    expect(
      tool.inputSchema.safeParse({
        intent: "shorten",
        baseSnapshotVersion: 1,
        timelineSnapshot: "{}",
        candidates: [candidate, candidate],
      }).success
    ).toBe(false);
  });

  it("explore_options rejects 5 candidates", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "explore_options")!;
    const candidate = {
      label: "A",
      summary: "s",
      candidateType: "trim",
      commands: [],
      expectedMetrics: { durationChange: "0s", affectedElements: 0 },
    };
    expect(
      tool.inputSchema.safeParse({
        intent: "shorten",
        baseSnapshotVersion: 1,
        timelineSnapshot: "{}",
        candidates: [candidate, candidate, candidate, candidate, candidate],
      }).success
    ).toBe(false);
  });

  it("dispatch_editor defaults accessMode to read_write via schema", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_editor")!;
    const result = tool.inputSchema.safeParse({ task: "Edit something" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { accessMode: string }).accessMode).toBe("read_write");
    }
  });

  it("propose_changes requires summary and affectedElements", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "propose_changes")!;
    expect(tool.inputSchema.safeParse({ summary: "ok", affectedElements: [] }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ summary: "ok" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ affectedElements: [] }).success).toBe(false);
  });

  it("export_video defaults format and quality", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "export_video")!;
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { format: string; quality: string };
      expect(data.format).toBe("mp4");
      expect(data.quality).toBe("standard");
    }
  });
});
