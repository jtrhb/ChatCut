import type {
  AgentType,
  ToolCallRecord,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";

export abstract class ToolExecutor {
  protected tools = new Map<string, ToolDefinition>();
  private callLog: ToolCallRecord[] = [];

  /** Add a tool to the registry. */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Validate that the given agent type is permitted to use the named tool.
   * Throws if the tool is unknown or if the agent is not in the tool's agentTypes list.
   */
  validatePermission(toolName: string, agentType: AgentType): void {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: "${toolName}"`);
    }
    if (!tool.agentTypes.includes(agentType)) {
      throw new Error(
        `Agent type "${agentType}" is not authorized to use tool "${toolName}"`
      );
    }
  }

  /**
   * Returns true when the tool's accessMode is "write" or "read_write".
   */
  isWriteOperation(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    return tool.accessMode === "write" || tool.accessMode === "read_write";
  }

  /**
   * Execute a tool by name:
   * 1. Look up the tool definition (return error result if unknown)
   * 2. Validate agent permission
   * 3. Validate input with the tool's Zod schema
   * 4. Delegate to the abstract executeImpl()
   * 5. Log the call record
   * 6. Return the result
   */
  async execute(
    toolName: string,
    input: unknown,
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: "${toolName}"` };
    }

    // Permission check — return error rather than throw so callers get a clean result
    try {
      this.validatePermission(toolName, context.agentType);
    } catch (err) {
      const result: ToolCallResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this._log(toolName, input, result, context);
      return result;
    }

    // Zod schema validation
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const result: ToolCallResult = {
        success: false,
        error: parsed.error.message,
      };
      this._log(toolName, input, result, context);
      return result;
    }

    // Execute the concrete implementation
    const result = await this.executeImpl(toolName, parsed.data, context);
    this._log(toolName, parsed.data, result, context);
    return result;
  }

  /** Concrete subclasses provide the actual tool execution logic. */
  protected abstract executeImpl(
    toolName: string,
    input: unknown,
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult>;

  /** Return all tools available to the given agent type. */
  getToolDefinitions(agentType: AgentType): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) =>
      t.agentTypes.includes(agentType)
    );
  }

  /** Return the immutable call log. */
  getCallLog(): readonly ToolCallRecord[] {
    return this.callLog;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _log(
    toolName: string,
    input: unknown,
    output: ToolCallResult,
    context: { agentType: AgentType; taskId: string }
  ): void {
    this.callLog.push({
      toolName,
      input,
      output,
      agentType: context.agentType,
      taskId: context.taskId,
      timestamp: Date.now(),
      isWriteOp: this.isWriteOperation(toolName),
    });
  }
}
