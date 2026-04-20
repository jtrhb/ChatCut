import { EditorCore, ServerTracksSnapshotCommand } from "@opencut/core";
import type { SerializedEditorState, TimelineTrack } from "@opencut/core";
import type { Command } from "@opencut/core";

/**
 * ServerEditorCore wraps @opencut/core's EditorCore for server-side use.
 *
 * Provides:
 * - Version gating via snapshotVersion / validateVersion()
 * - Clone-for-atomicity support via clone()
 * - Agent and human command dispatch with automatic version increment
 */
export class ServerEditorCore {
  private _core: EditorCore;
  private _version: number;

  // Private constructor — use static factory methods
  private constructor(core: EditorCore, version: number) {
    this._core = core;
    this._version = version;
  }

  /**
   * Create a ServerEditorCore from a serialized snapshot.
   * @param data  Serialized editor state
   * @param version  Snapshot version to start at (default 0)
   */
  static fromSnapshot(
    data: SerializedEditorState,
    version: number = 0
  ): ServerEditorCore {
    const core = EditorCore.deserialize(data);
    return new ServerEditorCore(core, version);
  }

  /** Current snapshot version number. Increments on every command execution. */
  get snapshotVersion(): number {
    return this._version;
  }

  /** Access the underlying EditorCore instance. */
  get editorCore(): EditorCore {
    return this._core;
  }

  /**
   * Validate that the current version matches the expected version.
   * Throws "Stale snapshot version" if they don't match.
   */
  validateVersion(expectedVersion: number): void {
    if (this._version !== expectedVersion) {
      throw new Error(
        `Stale snapshot version: expected ${expectedVersion}, got ${this._version}`
      );
    }
  }

  /**
   * Execute an agent-originated command.
   * Delegates to core.executeAgentCommand() then increments snapshotVersion.
   *
   * Optional taskId tags the command so it can be rolled back as part of a
   * dispatch group via rollbackByTaskId(). The Master mints one taskId per
   * sub-agent dispatch; every command produced during that dispatch should
   * share it.
   */
  executeAgentCommand(command: Command, agentId: string, taskId?: string): void {
    this._core.executeAgentCommand(command, agentId, taskId);
    this._version++;
  }

  /**
   * Roll back every command executed under the given taskId, in reverse
   * history order. Used by the Master agent to unwind a failed sub-agent
   * dispatch. Bumps snapshotVersion once if anything was undone so callers
   * see a single post-rollback version (not one bump per undone command).
   * Returns the number of commands that were undone.
   */
  rollbackByTaskId(taskId: string): number {
    const undone = this._core.rollbackByTaskId(taskId);
    if (undone > 0) {
      this._version++;
    }
    return undone;
  }

  /**
   * Convenience: wrap a tracks-before / tracks-after snapshot as a
   * ServerTracksSnapshotCommand and execute it. Routes through
   * CommandManager so it participates in rollbackByTaskId. This is what
   * agent editor tools should call instead of mutating timeline.updateTracks
   * directly — the direct path leaves no command history and can't be
   * rolled back.
   */
  applyTracksAsCommand(
    before: TimelineTrack[],
    after: TimelineTrack[],
    agentId: string,
    taskId?: string,
  ): void {
    const cmd = new ServerTracksSnapshotCommand(this._core, before, after);
    this.executeAgentCommand(cmd, agentId, taskId);
  }

  /**
   * Execute a human-originated command.
   * Delegates to core.executeCommand() then increments snapshotVersion.
   */
  executeHumanCommand(command: Command): void {
    this._core.executeCommand(command);
    this._version++;
  }

  /**
   * Serialize the current editor state.
   */
  serialize(): SerializedEditorState {
    return this._core.serialize();
  }

  /**
   * Create a fully independent copy at the same version.
   * Serializes then deserializes to ensure no shared references.
   */
  clone(): ServerEditorCore {
    const state = this._core.serialize();
    return ServerEditorCore.fromSnapshot(state, this._version);
  }

  /**
   * Atomically swap the live runtime + version with a donor's. Used by
   * commitMutation (Phase 2.4) to land a successfully-DB-committed clone
   * on top of the live core in a single synchronous step. No await may
   * sit between the two assignments — JS is single-threaded so contiguous
   * synchronous statements are observably atomic to other code paths.
   *
   * **Consumes the donor.** After this call, the donor's `_core` is shared
   * by reference with `this`. Mutating the donor (executeAgentCommand,
   * etc.) would silently mutate the live core while leaving the donor's
   * version stale — desyncing the two version counters. Callers must drop
   * the donor reference immediately after this call. Production usage
   * (commitMutation) creates the donor as a clone, executes on it, then
   * passes it here and never touches it again.
   *
   * Self-swap (`donor === this`) throws — it would do nothing useful and
   * always indicates a coding bug in the caller (e.g. double-swap).
   */
  replaceRuntime(donor: ServerEditorCore): void {
    if (donor === this) {
      throw new Error("replaceRuntime: donor must not be the same instance as the target");
    }
    this._core = donor._core;
    this._version = donor._version;
  }
}
