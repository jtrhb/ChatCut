import { nanoid } from "nanoid";
import type { AgentRuntime } from "./runtime.js";
import type {
	AgentConfig,
	AgentType,
	DispatchInput,
	DispatchOutput,
} from "./types.js";
import type {
	ProjectContext,
	ProjectContextManager,
} from "../context/project-context.js";
import type { ProjectWriteLock } from "../context/write-lock.js";
import {
	ExploreOptionsSchema,
	masterToolDefinitions,
} from "../tools/master-tools.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import type { PromptContext } from "../prompt/types.js";
import { delegationContractSection } from "../prompt/delegation-contract.js";
import { ToolPipeline } from "../tools/tool-pipeline.js";
import type { ToolHook } from "../tools/hooks.js";
import { SkillRuntime } from "../skills/skill-runtime.js";
import type { SkillContract } from "../skills/types.js";
import type { ToolDefinition, ToolFormatContext } from "../tools/types.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import type { ChangesetManager } from "../changeset/changeset-manager.js";
import type { ExplorationEngine } from "../exploration/exploration-engine.js";
import type { TaskRegistry } from "../tasks/task-registry.js";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { MemoryLoader } from "../memory/memory-loader.js";
import type { ParsedMemory, TaskContext, ConflictMarker } from "../memory/types.js";
import type { Annotations, AnnotatedFrame } from "../routes/chat.js";
import type { ContextSynchronizer } from "../context/context-sync.js";
import { DeferredRegistry } from "../tools/deferred-registry.js";
import { createResolveToolsTool } from "../tools/resolve-tools-tool.js";
import { OverflowStore } from "../tools/overflow-store.js";
import {
	createReadOverflowTool,
	executeReadOverflow,
} from "../tools/read-overflow-tool.js";

// ---------------------------------------------------------------------------
// Tool-name → sub-agent mapping
// ---------------------------------------------------------------------------

/** Maps a dispatch_* tool name to its sub-agent key and default access mode. */
const DISPATCH_ROUTES: Record<
	string,
	{ agentKey: string; defaultAccessMode: DispatchInput["accessMode"] }
> = {
	dispatch_editor: { agentKey: "editor", defaultAccessMode: "read_write" },
	dispatch_vision: { agentKey: "vision", defaultAccessMode: "read" },
	dispatch_creator: { agentKey: "creator", defaultAccessMode: "read_write" },
	dispatch_audio: { agentKey: "audio", defaultAccessMode: "read_write" },
	dispatch_asset: { agentKey: "asset", defaultAccessMode: "read" },
	dispatch_verification: {
		agentKey: "verification",
		defaultAccessMode: "read",
	},
};

// ---------------------------------------------------------------------------
// MasterAgent
// ---------------------------------------------------------------------------

export class MasterAgent {
	private runtime: AgentRuntime;
	private contextManager: ProjectContextManager;
	private writeLock: ProjectWriteLock;
	private subAgentDispatchers: Map<
		string,
		(input: DispatchInput) => Promise<DispatchOutput>
	>;
	private pipeline: ToolPipeline;
	private skillContracts: SkillContract[];
	private changesetManager?: ChangesetManager;
	private explorationEngine?: ExplorationEngine;
	private taskRegistry?: TaskRegistry;
	/**
	 * Optional server editor core. When provided, handleDispatch mints a
	 * fresh taskId per dispatch and rolls back all commands tagged with
	 * that taskId if the dispatcher throws. Optional so legacy code paths
	 * and tests that don't need rollback can construct MasterAgent without it.
	 */
	private serverCore?: ServerEditorCore;
	/**
	 * Optional memory store + writer token. Per spec §9.4 MasterAgent is
	 * the sole memory writer. We claim the token at construction so no one
	 * else can grant it — even if a reference to the store leaks. Writes
	 * go through the writeMemory method below.
	 */
	private memoryStore?: MemoryStore;
	private memoryWriterToken?: symbol;
	/**
	 * Optional memory loader. When wired, handleUserMessage calls
	 * loadMemories at entry, injects promptText into the system prompt,
	 * and stashes injectedMemoryIds / injectedSkillIds on the current turn
	 * so a downstream propose_changes can stamp them onto the changeset.
	 */
	private memoryLoader?: MemoryLoader;
	/**
	 * Optional context synchronizer. When wired, runTurn calls
	 * buildContextUpdate("master") at the top of every turn and prepends
	 * the result to the user message so the model sees committed changes
	 * (other agents, human edits) that landed since its last turn.
	 * Spec §3.11 / §7.4. Audit §A.8 closure.
	 */
	private contextSynchronizer?: ContextSynchronizer;
	/** Per-turn memory injection IDs. Reset at handleUserMessage entry. */
	private currentInjectedMemoryIds: string[] = [];
	private currentInjectedSkillIds: string[] = [];
	private currentDeferredRegistry?: DeferredRegistry;
	private overflowStore: OverflowStore;
	/** Identity of the currently-executing user message. Set at handleUserMessage entry,
	 * read by pipeline ctx builder + handleDispatch. Prevents re-entrancy by being
	 * cleared in a finally block. MasterAgent is single-turn per instance. */
	private currentIdentity?: {
		userId?: string;
		sessionId?: string;
		projectId?: string;
	};

	constructor(deps: {
		runtime: AgentRuntime;
		contextManager: ProjectContextManager;
		writeLock: ProjectWriteLock;
		subAgentDispatchers: Map<
			string,
			(input: DispatchInput) => Promise<DispatchOutput>
		>;
		hooks?: ToolHook[];
		skillContracts?: SkillContract[];
		changesetManager?: ChangesetManager;
		explorationEngine?: ExplorationEngine;
		taskRegistry?: TaskRegistry;
		serverCore?: ServerEditorCore;
		memoryStore?: MemoryStore;
		memoryLoader?: MemoryLoader;
		contextSynchronizer?: ContextSynchronizer;
	}) {
		this.runtime = deps.runtime;
		this.contextManager = deps.contextManager;
		this.writeLock = deps.writeLock;
		this.subAgentDispatchers = deps.subAgentDispatchers;
		this.skillContracts = deps.skillContracts ?? [];
		this.changesetManager = deps.changesetManager;
		this.explorationEngine = deps.explorationEngine;
		this.taskRegistry = deps.taskRegistry;
		this.serverCore = deps.serverCore;
		this.memoryStore = deps.memoryStore;
		this.memoryLoader = deps.memoryLoader;
		this.contextSynchronizer = deps.contextSynchronizer;

		// Claim the sole-writer token at construction. grantWriterToken throws
		// on repeat invocation so if anything else has already grabbed the
		// token from this store, this boot fails loudly — which is exactly the
		// invariant spec §9.4 wants us to preserve.
		if (this.memoryStore) {
			this.memoryWriterToken = this.memoryStore.grantWriterToken();
		}

		// Create session-scoped overflow store for result budget control (P2)
		this.overflowStore = new OverflowStore();

		// Create ToolPipeline wrapping the raw tool handler
		this.pipeline = new ToolPipeline(
			async (name, input, _ctx, _onProgress) => {
				const result = await this.handleToolCall(name, input);
				// Detect business-level failures (handleToolCall returns { error: ... })
				if (
					result &&
					typeof result === "object" &&
					"error" in (result as Record<string, unknown>)
				) {
					return {
						success: false,
						error: String((result as Record<string, unknown>).error),
					};
				}
				return { success: true, data: result };
			},
			{ overflowStore: this.overflowStore },
		);

		// Register all master tools with the pipeline
		for (const tool of masterToolDefinitions) {
			this.pipeline.registerTool(tool);
		}

		// Register read_overflow tool for result budget dereferencing (P2)
		const readOverflowTool = createReadOverflowTool();
		this.pipeline.registerTool(readOverflowTool);

		// Register any provided hooks
		if (deps.hooks) {
			for (const hook of deps.hooks) {
				this.pipeline.registerHook(hook);
			}
		}

		// Wire tool registry for order-preserving parallel execution
		if (this.runtime.setToolRegistry) {
			const toolRegistryMap = new Map(
				masterToolDefinitions.map((t) => [t.name, t]),
			);
			this.runtime.setToolRegistry(toolRegistryMap);
		}

		// Wire pipeline into runtime — all tool calls now go through the pipeline
		this.runtime.setToolExecutor(async (name: string, input: unknown) => {
			const result = await this.pipeline.execute(name, input, {
				agentType: "master",
				taskId: "master-session",
				sessionId: this.currentIdentity?.sessionId,
				userId: this.currentIdentity?.userId,
			});
			if (!result.success) {
				return { error: result.error };
			}
			return result.data;
		});
	}

	/** Access the pipeline for trace inspection or hook registration. */
	getPipeline(): ToolPipeline {
		return this.pipeline;
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	async handleUserMessage(
		message: string,
		history?: Array<{ role: string; content: string }>,
		identity?: { userId?: string; sessionId?: string; projectId?: string },
		/**
		 * Phase 5e: rolling summary from prior compactions, if any. When present,
		 * runTurn injects it into the system prompt so the model has continuity
		 * even though pre-summary messages were dropped from `history`.
		 */
		sessionSummary?: string,
		/**
		 * Phase 5d: optional spatial/temporal/ghost-ref annotations the user
		 * attached to this turn. runTurn serializes them as a structured
		 * prefix in the user message text so the model can ground intent on
		 * the same coords later code paths use programmatically.
		 */
		annotations?: Annotations,
		/**
		 * Phase 5d (Q1=d): optional annotated frame — the captured preview
		 * frame with the user's overlay drawn on TOP, then base64-encoded.
		 * When present, runTurn attaches it as an Anthropic vision block on
		 * the user message so Claude can SEE what was circled instead of
		 * reconstructing from coords-as-text. ~1.5K tokens; only paid when
		 * an annotation actually rides this turn.
		 */
		annotatedFrame?: AnnotatedFrame,
	): Promise<{ text: string; tokensUsed: { input: number; output: number } }> {
		this.currentIdentity = identity;
		// Reset per-turn memory injection lists; runTurn populates them if
		// the memory loader is wired and a TaskContext can be resolved.
		this.currentInjectedMemoryIds = [];
		this.currentInjectedSkillIds = [];
		try {
			return await this.runTurn(
				message,
				history,
				sessionSummary,
				annotations,
				annotatedFrame,
			);
		} finally {
			this.currentIdentity = undefined;
			this.currentInjectedMemoryIds = [];
			this.currentInjectedSkillIds = [];
		}
	}

	/**
	 * Write a memory record via the master-owned token. This is the sole
	 * sanctioned write path per spec §9.4 — sub-agents, observers, and
	 * extractors that need to persist memories must call this method
	 * (typically via an injected callback) instead of touching MemoryStore
	 * directly. Throws if no memoryStore was configured at construction.
	 */
	async writeMemory(path: string, memory: ParsedMemory): Promise<void> {
		if (!this.memoryStore || !this.memoryWriterToken) {
			throw new Error(
				"MasterAgent.writeMemory: memoryStore was not configured at construction. " +
					"Wire it via the memoryStore constructor dep to enable memory persistence.",
			);
		}
		await this.memoryStore.writeMemory(this.memoryWriterToken, path, memory);
	}

	/**
	 * Returns a write callback bound to this master's writer token. Pass to
	 * MemoryExtractor / PatternObserver as their `writeMemory` dep so they
	 * can persist through the sanctioned path without holding a store ref.
	 */
	getMemoryWriter(): (path: string, memory: ParsedMemory) => Promise<void> {
		return (path, memory) => this.writeMemory(path, memory);
	}

	/**
	 * Phase 5c: write a conflict marker via the master-owned token. Mirrors
	 * writeMemory — sole sanctioned path per spec §9.4. Throws if no
	 * memoryStore was configured at construction.
	 */
	async writeConflictMarker(params: {
		actionType: string;
		target?: string;
		severity: "high" | "medium" | "low";
		conflictsWith?: string[];
		reason: string;
	}): Promise<void> {
		if (!this.memoryStore || !this.memoryWriterToken) {
			throw new Error(
				"MasterAgent.writeConflictMarker: memoryStore was not configured at construction. " +
					"Wire it via the memoryStore constructor dep to enable conflict-marker persistence.",
			);
		}
		await this.memoryStore.writeConflictMarker(this.memoryWriterToken, params);
	}

	/**
	 * Phase 5c: returns a write callback bound to this master's writer token.
	 * Pass to MemoryExtractor as its `writeConflictMarker` dep so it can
	 * persist markers through the sanctioned path without holding a store ref.
	 */
	getConflictMarkerWriter(): (params: {
		actionType: string;
		target?: string;
		severity: "high" | "medium" | "low";
		conflictsWith?: string[];
		reason: string;
	}) => Promise<void> {
		return (params) => this.writeConflictMarker(params);
	}

	/**
	 * Expose the memory IDs injected into the most recent turn. Called by
	 * propose_changes (or anyone that builds a changeset from the current
	 * turn) to stamp injectedMemoryIds / injectedSkillIds per spec §9.4 so
	 * downstream approve / reject can do reinforceRelatedMemories lookups.
	 */
	getCurrentInjectedMemoryIds(): { memoryIds: string[]; skillIds: string[] } {
		return {
			memoryIds: [...this.currentInjectedMemoryIds],
			skillIds: [...this.currentInjectedSkillIds],
		};
	}

	/**
	 * Resolve a TaskContext from the current identity + project context,
	 * if the caller has provided enough information. Returns null when
	 * brand mapping isn't registered — loadMemories requires a brand, so
	 * we skip memory loading in that case rather than feeding a stub.
	 */
	private resolveTaskContext(agentType: AgentType): TaskContext | null {
		const projectId = this.currentIdentity?.projectId;
		const sessionId = this.currentIdentity?.sessionId;
		if (!projectId || !sessionId) return null;
		const brandMapping = this.contextManager.getBrandForProject(projectId);
		if (!brandMapping) return null;
		return {
			brand: brandMapping.brand,
			series: brandMapping.series,
			projectId,
			sessionId,
			agentType,
		};
	}

	/**
	 * Shared memory-load path used by the master turn AND each sub-agent
	 * dispatch (spec §9.4 requires both). Calls memoryLoader.loadMemories
	 * with the agentType-specific TaskContext, appends the resulting
	 * injectedMemoryIds / injectedSkillIds onto the current turn so a
	 * downstream propose_changes can stamp them, and returns the MemoryContext
	 * so the caller can inject promptText where appropriate. Returns null
	 * when memory is not wired or the TaskContext can't be resolved. Loader
	 * errors are swallowed — memory is best-effort; it must not fail the
	 * user's turn.
	 */
	private async loadMemoriesFor(
		agentType: AgentType,
		templateKey = "single-edit",
	): Promise<{
		promptText: string;
		injectedMemoryIds: string[];
		injectedSkillIds: string[];
	} | null> {
		if (!this.memoryLoader) return null;
		const taskContext = this.resolveTaskContext(agentType);
		if (!taskContext) return null;
		try {
			const memoryContext = await this.memoryLoader.loadMemories(
				taskContext,
				templateKey,
			);
			// Append (not replace) so master-injected IDs + per-dispatch IDs
			// both land on the eventual changeset.
			this.currentInjectedMemoryIds.push(...memoryContext.injectedMemoryIds);
			this.currentInjectedSkillIds.push(...memoryContext.injectedSkillIds);
			return memoryContext;
		} catch {
			// Memory store unavailable — proceed without memory context.
			return null;
		}
	}

	/**
	 * Phase 5c: load conflict markers via the memory loader, swallowing errors
	 * so a missing/unreadable conflicts dir doesn't fail the user's turn. The
	 * loader itself already swallows per-file parse errors; this catch covers
	 * the listConflictMarkers + listing-error path.
	 */
	private async loadConflictMarkersBestEffort(): Promise<ConflictMarker[]> {
		if (!this.memoryLoader) return [];
		try {
			return await this.memoryLoader.loadConflictMarkers();
		} catch {
			return [];
		}
	}

	/**
	 * Phase 5c (5c-Q3): format conflict markers as a dedicated system-prompt
	 * section. The "do not repeat" framing is intentional — markers exist
	 * because the user already rejected this pattern multiple times, and the
	 * agent should propose a different approach (or ask) before retrying.
	 */
	private formatConflictsSection(markers: ConflictMarker[]): string {
		const lines: string[] = ["## Active conflicts (do not repeat)"];
		lines.push(
			"The following actions were repeatedly rejected. Acknowledge the conflict",
			"and propose a different approach (or ask the user to clarify) before",
			"re-proposing them.",
			"",
		);
		for (const m of markers) {
			lines.push(
				`### ${m.action_type} → ${m.target} (${m.severity}, last seen ${m.last_seen_at})`,
			);
			lines.push(m.reason);
			lines.push("");
		}
		return lines.join("\n").trimEnd();
	}

	/**
	 * Phase 5d: serialize annotations as a structured prefix the model can
	 * read deterministically. Coords are 0..1 normalized (Q4) so the LLM
	 * sees the same numbers regardless of viewport — and the same numbers
	 * downstream tool calls would use programmatically.
	 *
	 * Returns "" when no annotations of substance are present so callers
	 * don't append an empty header.
	 */
	private formatAnnotationPrefix(annotations: Annotations): string {
		if (!annotations) return "";
		const lines: string[] = [];
		if (annotations.spatial && annotations.spatial.length > 0) {
			lines.push("Spatial (0..1 normalized to preview canvas):");
			for (const s of annotations.spatial) {
				const labelSuffix = s.label ? ` — "${s.label}"` : "";
				lines.push(
					`  - {x: ${s.x.toFixed(3)}, y: ${s.y.toFixed(3)}, w: ${s.w.toFixed(3)}, h: ${s.h.toFixed(3)}}${labelSuffix}`,
				);
			}
		}
		if (annotations.temporal) {
			lines.push(
				`Temporal: ${annotations.temporal.startSec.toFixed(2)}s → ${annotations.temporal.endSec.toFixed(2)}s`,
			);
		}
		if (annotations.ghostRef) {
			lines.push(`Ghost reference: ${annotations.ghostRef.ghostId}`);
		}
		if (lines.length === 0) return "";
		return ["## User indication", ...lines, ""].join("\n");
	}

	private async runTurn(
		message: string,
		history?: Array<{ role: string; content: string }>,
		sessionSummary?: string,
		annotations?: Annotations,
		annotatedFrame?: AnnotatedFrame,
	): Promise<{ text: string; tokensUsed: { input: number; output: number } }> {
		const ctx = this.contextManager.get();

		// Match skills to intent and use as active skills for this message
		const matchedSkills = this.matchSkillsForIntent(message);
		const activeSkills =
			matchedSkills.length > 0 ? matchedSkills : this.skillContracts;

		// Apply skill constraints to runtime config
		const resolvedModel = this.resolveModel(activeSkills);
		const allTools = this.resolveTools(activeSkills);

		const formatCtx: ToolFormatContext = {
			filterContext: { projectContext: ctx },
			descriptionContext: {
				projectContext: ctx,
				activeSkills: activeSkills.map((s) => ({ name: s.name })),
				agentType: "master",
			},
		};

		// Separate core tools (fully loaded) from deferred tools
		const coreTools = allTools.filter((t) => !t.shouldDefer);
		const deferredTools = allTools.filter((t) => t.shouldDefer);

		// Create deferred registry and wire into runtime
		const deferredRegistry = new DeferredRegistry(
			deferredTools,
			formatCtx.filterContext,
		);

		if (this.runtime.setDeferredRegistry) {
			this.runtime.setDeferredRegistry(deferredRegistry);
		}

		// Add resolve_tools to core tools if there are deferred tools
		const apiTools = [...coreTools];
		if (deferredRegistry.getDeferredListing()) {
			apiTools.push(createResolveToolsTool());
			// Register resolve_tools with the pipeline
			this.pipeline.registerTool(createResolveToolsTool());
		}

		// Build system prompt with deferred listing appended
		let systemPrompt = this.buildSystemPrompt(ctx, activeSkills);

		// Load relevant memories per spec §9.4. loadMemoriesFor handles the
		// wired-or-not / best-effort concerns and mutates the per-turn injected
		// IDs; we just need to inject promptText when available.
		const masterMemory = await this.loadMemoriesFor("master");
		if (masterMemory?.promptText) {
			systemPrompt += `\n\n## Memory\n\n${masterMemory.promptText}`;
		}

		// Phase 5c: load active conflict markers and surface them in a dedicated
		// section. Best-effort — loader returns [] when memory isn't wired or
		// listing fails. Kept separate from the regular Memory section so the
		// LLM doesn't weigh past rejections like positive guidance.
		const conflictMarkers = this.memoryLoader
			? await this.loadConflictMarkersBestEffort()
			: [];
		if (conflictMarkers.length > 0) {
			systemPrompt += `\n\n${this.formatConflictsSection(conflictMarkers)}`;
		}

		// Phase 5e Q3+Q4: when prior turns were compacted, the rolling summary
		// rides in the system prompt so the model retains continuity even though
		// the original messages were dropped from `history`. The "compacted"
		// label is intentional — we want the model to know context was condensed
		// (and therefore not assume it has the verbatim record).
		if (sessionSummary && sessionSummary.trim().length > 0) {
			systemPrompt += `\n\n## Conversation summary (compacted earlier turns)\n\n${sessionSummary.trim()}\n\nThe above is a condensed summary of earlier turns. Recent messages follow verbatim.`;
		}

		const deferredListing = deferredRegistry.getDeferredListing();
		if (deferredListing) {
			systemPrompt += `\n\n${deferredListing}`;
		}

		// Store registry for resolve_tools handler
		this.currentDeferredRegistry = deferredRegistry;

		const config: AgentConfig = {
			agentType: "master",
			model: resolvedModel,
			system: systemPrompt,
			tools: formatToolsForApi(apiTools, formatCtx),
			tokenBudget: TOKEN_BUDGETS.master,
			maxIterations: MAX_ITERATIONS.master,
		};

		// Convert history to Anthropic message format for multi-turn context
		const anthropicHistory = history?.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.content,
		}));

		// Spec §3.11.5 / §7.4: lazy-sync external state changes (other agents,
		// human edits) into the model's view by prepending a Change Log
		// summary to the user message at the top of each turn. Master is the
		// only place we plumb this for now; sub-agents read the same delta
		// via their own loadMemoriesFor path. buildContextUpdate returns
		// null when nothing has changed since the last sync, in which case
		// we leave the message untouched.
		let effectiveMessage = message;
		if (this.contextSynchronizer) {
			const contextUpdate =
				this.contextSynchronizer.buildContextUpdate("master");
			if (contextUpdate) {
				effectiveMessage = `${contextUpdate}\n\n## Current request\n${message}`;
			}
		}

		// Phase 5d: prepend the annotation prefix BEFORE the user message
		// (after any contextSynchronizer block). Coords + temporal + ghost
		// refs ride as deterministic text the model can parse exactly the
		// way downstream tools will. The annotated frame (if present) gets
		// attached as a vision block via userContent below.
		const annotationPrefix = this.formatAnnotationPrefix(annotations);
		if (annotationPrefix) {
			effectiveMessage = `${annotationPrefix}${effectiveMessage}`;
		}

		// Phase 5d (Q1=d): when an annotated frame ships with the turn,
		// build an Anthropic content array (text + image) so Claude SEES
		// what was circled instead of reconstructing from coords-as-text.
		// Anthropic SDK accepts string OR array — we pass array only when
		// we actually have an image, keeping the un-annotated path bit-
		// for-bit identical to today.
		const userContent = annotatedFrame
			? [
					{ type: "text" as const, text: effectiveMessage },
					{
						type: "image" as const,
						source: {
							type: "base64" as const,
							media_type: annotatedFrame.mediaType,
							data: annotatedFrame.base64,
						},
					},
				]
			: undefined;

		const result = await this.runtime.run(
			config,
			effectiveMessage,
			anthropicHistory,
			userContent,
		);
		return { text: result.text, tokensUsed: result.tokensUsed };
	}

	/**
	 * Resolve model from active skills. If any skill specifies a model
	 * different from default, use it. Falls back to claude-opus-4-6.
	 */
	private resolveModel(activeSkills: SkillContract[]): string {
		for (const skill of activeSkills) {
			if (skill.frontmatter.model) {
				return skill.resolvedModel;
			}
		}
		return "claude-opus-4-6";
	}

	/**
	 * Resolve tools from active skills. Applies both allowed_tools (whitelist)
	 * and denied_tools (blacklist) from skill contracts.
	 */
	private resolveTools(activeSkills: SkillContract[]): ToolDefinition[] {
		let tools = [...masterToolDefinitions];

		// Collect allowed_tools from active skills (union = any skill can enable a tool)
		const allowedSets = activeSkills
			.filter(
				(s) =>
					s.frontmatter.allowed_tools && s.frontmatter.allowed_tools.length > 0,
			)
			.map((s) => new Set(s.resolvedTools));

		if (allowedSets.length > 0) {
			const allowed = new Set<string>();
			for (const set of allowedSets) {
				for (const tool of set) allowed.add(tool);
			}
			tools = tools.filter((t) => allowed.has(t.name));
		}

		// Collect denied_tools from active skills (union = any skill can deny a tool)
		const deniedTools = new Set<string>();
		for (const skill of activeSkills) {
			if (skill.frontmatter.denied_tools) {
				for (const tool of skill.frontmatter.denied_tools) {
					deniedTools.add(tool);
				}
			}
		}
		if (deniedTools.size > 0) {
			tools = tools.filter((t) => !deniedTools.has(t.name));
		}

		return tools;
	}

	// ── System Prompt Builder ─────────────────────────────────────────────────

	buildSystemPrompt(
		ctx: Readonly<ProjectContext>,
		activeSkills?: SkillContract[],
	): string {
		const builder = new PromptBuilder();
		builder.register(delegationContractSection);

		const contracts = activeSkills ?? this.skillContracts;
		if (contracts.length > 0) {
			builder.register({
				key: "activeSkills",
				priority: 40,
				isStatic: false,
				render: () => {
					const lines = ["## Active Skills"];
					for (const contract of contracts) {
						lines.push(`### ${contract.name}`);
						lines.push(contract.content);
						if (contract.resolvedTools.length > 0) {
							lines.push(`Allowed tools: ${contract.resolvedTools.join(", ")}`);
						}
						lines.push(`Effort: ${contract.frontmatter.effort ?? "medium"}`);
						lines.push("");
					}
					return lines.join("\n");
				},
			});
		}

		const promptCtx: PromptContext = {
			projectContext: ctx,
			agentIdentity: {
				role: "Master Agent",
				description:
					"You are the Master Agent for OpenCut, an AI-powered video editor. " +
					"You coordinate sub-agents (editor, vision, creator, audio, asset) to fulfill user requests.",
				rules: [
					"Analyze the user's intent before dispatching to sub-agents.",
					"Follow the Sub-Agent Delegation Contract exactly.",
					"For destructive edits, use propose_changes to get user approval first.",
				],
			},
		};
		return builder.build(promptCtx);
	}

	/**
	 * Return all skill contracts whose `when_to_use` patterns match the given intent.
	 */
	matchSkillsForIntent(intent: string): SkillContract[] {
		const runtime = new SkillRuntime({ availableTools: [], defaultModel: "" });
		return this.skillContracts.filter((contract) =>
			runtime.matchesIntent(intent, contract.frontmatter),
		);
	}

	// ── Tool Call Handler ─────────────────────────────────────────────────────

	private async handleToolCall(name: string, input: unknown): Promise<unknown> {
		// Dispatch tools
		const route = DISPATCH_ROUTES[name];
		if (route) {
			return this.handleDispatch(route, input as Record<string, unknown>);
		}

		switch (name) {
			case "read_overflow": {
				const { ReadOverflowSchema } = await import(
					"../tools/read-overflow-tool.js"
				);
				const parsed = ReadOverflowSchema.parse(input);
				return executeReadOverflow(parsed, this.overflowStore);
			}

			case "resolve_tools": {
				if (this.currentDeferredRegistry) {
					const params = input as { names?: string[]; search?: string };
					const resolved = this.currentDeferredRegistry.resolve(
						params.names,
						params.search,
					);
					return {
						resolved: resolved.map((t) => t.name),
						count: resolved.length,
					};
				}
				return { resolved: [], count: 0 };
			}

			case "propose_changes": {
				if (this.changesetManager) {
					const params = input as {
						summary: string;
						affectedElements: string[];
						projectId?: string;
					};
					// Thread the current turn's userId so ChangesetManager can stamp
					// the owner on the pending changeset (B5 IDOR closure). Falls back
					// to "unscoped" when identity isn't wired (dev paths); the store
					// preserves that value so only an "unscoped" caller can decide it.
					//
					// Also stamp injectedMemoryIds / injectedSkillIds collected during
					// this turn (master loadMemories + per-dispatch sub-agent
					// loadMemories both append here) so approve/reject can later drive
					// reinforceRelatedMemories and skill usage-count updates per
					// spec §9.4. A defensive slice ensures the pending changeset
					// holds its own copies — later-turn resets won't mutate it.
					return this.changesetManager.propose({
						...params,
						userId: this.currentIdentity?.userId ?? "unscoped",
						projectId:
							params.projectId ?? this.currentIdentity?.projectId ?? "default",
						injectedMemoryIds: [...this.currentInjectedMemoryIds],
						injectedSkillIds: [...this.currentInjectedSkillIds],
					});
				}
				return {
					error:
						"propose_changes unavailable: ChangesetManager not configured for this session",
				};
			}

			case "explore_options": {
				if (!this.explorationEngine) {
					return {
						error:
							"explore_options unavailable: ExplorationEngine not configured for this session",
					};
				}
				// Audit §A.7 fix: projectId must come from the current turn's
				// identity so the persisted exploration row carries the right
				// tenant scope. Without an identity we cannot safely persist —
				// surface a clear error instead of falling back to "default".
				const projectId = this.currentIdentity?.projectId;
				if (!projectId) {
					return {
						error:
							"explore_options requires a projectId on the current turn identity",
					};
				}
				// Reviewer MEDIUM #3: validate against the existing zod
				// schema (the same one the model sees in the tool definition)
				// so a malformed model output yields a clear error instead
				// of crashing mid-persist with a runtime TypeError.
				const parsed = ExploreOptionsSchema.safeParse(input);
				if (!parsed.success) {
					return {
						error: `explore_options input failed schema validation: ${parsed.error.message}`,
					};
				}
				return this.explorationEngine.explore({
					...parsed.data,
					projectId,
				});
			}

			case "export_video": {
				if (this.taskRegistry) {
					const params = input as Record<string, unknown>;
					const task = this.taskRegistry.createTask({
						type: "export",
						description: `Export video: ${params.format ?? "mp4"} ${params.quality ?? "standard"}`,
					});
					return { task_id: task.taskId };
				}
				return {
					error:
						"export_video unavailable: TaskRegistry not configured for this session",
				};
			}

			default:
				return { error: `Unknown tool: ${name}` };
		}
	}

	// ── Dispatch Helpers ──────────────────────────────────────────────────────

	private async handleDispatch(
		route: { agentKey: string; defaultAccessMode: DispatchInput["accessMode"] },
		rawInput: Record<string, unknown>,
	): Promise<unknown> {
		const dispatcher = this.subAgentDispatchers.get(route.agentKey);
		if (!dispatcher) {
			return {
				error: `No dispatcher registered for sub-agent: ${route.agentKey}`,
			};
		}

		const accessMode =
			(rawInput.accessMode as DispatchInput["accessMode"]) ??
			route.defaultAccessMode;

		// Mint a fresh taskId per dispatch so every command issued by the
		// sub-agent is tagged with the same id. On dispatcher throw, Master
		// asks serverCore to roll back commands sharing this id as a unit.
		const taskId = `dispatch-${nanoid(10)}`;

		// Spec §9.4: each sub-agent dispatch independently loads memories
		// scoped to its agentType. The resulting IDs are appended to the
		// current-turn injection list so propose_changes stamps them all.
		// Only DispatchInput.context receives the promptText so the sub-agent
		// can include it in its own system prompt if desired.
		const subAgentMemory = await this.loadMemoriesFor(
			route.agentKey as AgentType,
		);

		// Merge the caller-supplied context with the per-dispatch memory
		// promptText (if any) so the sub-agent dispatcher can prepend it to
		// its system prompt without the sub-agent having to reach for the
		// memory loader directly.
		const mergedContext = subAgentMemory?.promptText
			? {
					...(rawInput.context as Record<string, unknown> | undefined),
					memoryPromptText: subAgentMemory.promptText,
				}
			: (rawInput.context as Record<string, unknown> | undefined);

		const dispatchInput: DispatchInput = {
			task: rawInput.task as string,
			accessMode,
			context: mergedContext,
			constraints: rawInput.constraints as DispatchInput["constraints"],
			identity: {
				userId: this.currentIdentity?.userId,
				sessionId: this.currentIdentity?.sessionId,
				projectId: this.currentIdentity?.projectId,
				taskId,
			},
		};

		const needsLock = accessMode === "write" || accessMode === "read_write";

		const runDispatcher = async (): Promise<unknown> => {
			try {
				return await dispatcher(dispatchInput);
			} catch (err) {
				// Best-effort rollback: unwind every command tagged with this
				// dispatch's taskId. If serverCore isn't wired (tests, legacy),
				// skip silently — the error still surfaces to the Master loop.
				if (this.serverCore) {
					try {
						this.serverCore.rollbackByTaskId(taskId);
					} catch {
						// Swallow rollback errors; the original dispatch error is
						// the important signal.
					}
				}
				const message = err instanceof Error ? err.message : String(err);
				return { error: `Sub-agent dispatch failed: ${message}` };
			}
		};

		if (needsLock) {
			await this.writeLock.acquire();
			try {
				return await runDispatcher();
			} finally {
				this.writeLock.release();
			}
		}

		return runDispatcher();
	}
}
