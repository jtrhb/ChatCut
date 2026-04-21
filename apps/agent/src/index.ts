import { serve } from "@hono/node-server";
import {
	createApp,
	createServices,
	createWiredMasterAgent,
	createMessageHandler,
} from "./server.js";
import {
	SessionCompactor,
	createAnthropicSummarizer,
} from "./session/compactor.js";
import { SkillLoader } from "./skills/loader.js";
import { ProjectContextManager } from "./context/project-context.js";
import { ProjectWriteLock } from "./context/write-lock.js";
import { EditorAgent } from "./agents/editor-agent.js";
import { CreatorAgent } from "./agents/creator-agent.js";
import { AudioAgent } from "./agents/audio-agent.js";
import { VisionAgent } from "./agents/vision-agent.js";
import { AssetAgent } from "./agents/asset-agent.js";
import { VerificationAgent } from "./agents/verification-agent.js";
import { masterToolDefinitions } from "./tools/master-tools.js";
import type { DispatchInput, DispatchOutput } from "./agents/types.js";
import { ServerEditorCore } from "./services/server-editor-core.js";
import { EditorToolExecutor } from "./tools/editor-tools.js";
import { AssetToolExecutor } from "./tools/asset-tool-executor.js";
import { VisionToolExecutor } from "./tools/vision-tool-executor.js";
import { VisionClient } from "./services/vision-client.js";
import { VisionCache } from "./services/vision-cache.js";
import { EmbeddingClient } from "./services/embedding-client.js";
import { CharacterStore } from "./assets/character-store.js";
import { ChangesetManager } from "./changeset/changeset-manager.js";
import { ChangeLog } from "@opencut/core";
import { PatternObserver } from "./memory/pattern-observer.js";
import { MemoryExtractor } from "./memory/memory-extractor.js";
import { ContextSynchronizer } from "./context/context-sync.js";
import type { SkillValidator } from "./skills/skill-validator.js";

// Debounce window for pattern analysis triggers (10 minutes)
const ANALYSIS_DEBOUNCE_MS = 10 * 60 * 1000;
const lastAnalysisAt = new Map<string, number>();

/**
 * Conditionally trigger pattern analysis if enough time has elapsed
 * since the last analysis for this brand/series.
 */
export function maybeTriggerAnalysis(
	patternObserver: PatternObserver,
	brand: string,
	series?: string,
): void {
	const key = `${brand}:${series ?? ""}`;
	const lastAt = lastAnalysisAt.get(key) ?? 0;
	if (Date.now() - lastAt > ANALYSIS_DEBOUNCE_MS) {
		lastAnalysisAt.set(key, Date.now());
		patternObserver.runAnalysis({ brand, series }).catch(() => {
			// Analysis failure is non-fatal — log and continue
		});
	}
}

async function main() {
	// Validate API key at startup — fail fast instead of opaque 401s per dispatch
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error("ANTHROPIC_API_KEY environment variable is required");
	}

	// Collect available tool names for skill resolution
	const availableToolNames = masterToolDefinitions.map((t) => t.name);

	// Load skill contracts before creating the app (requires async I/O)
	const skillLoader = new SkillLoader(null); // null = preset-only mode for now
	const skillContracts = await skillLoader.loadAllSkillContracts(
		"master",
		{},
		{ availableTools: availableToolNames, defaultModel: "claude-opus-4-6" },
	);

	// Create shared services ONCE — avoids split-brain duplicates (B2 fix)
	const services = createServices(skillContracts);
	const { sessionManager, eventBus, eventBusHook } = services;

	// Create shared project infrastructure
	const contextManager = new ProjectContextManager();
	const writeLock = new ProjectWriteLock();

	// Create a default ServerEditorCore with empty timeline.
	// Multi-project support will create per-project cores later.
	const serverEditorCore = ServerEditorCore.fromSnapshot({
		project: null,
		scenes: [
			{
				id: "default",
				name: "Scene 1",
				isMain: true,
				tracks: [],
				bookmarks: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
		activeSceneId: "default",
	});

	// Create EditorToolExecutor backed by real ServerEditorCore
	const editorToolExecutor = new EditorToolExecutor(serverEditorCore);

	// B8: Construct AssetToolExecutor only when ALL of its required infrastructure
	// deps are available. Previously we constructed it whenever EMBEDDING_API_URL
	// was set but passed `{} as any` for assetStore / brandStore / objectStorage
	// — which NPE'd on the first real call. Now we fail-fast at boot: if DB or
	// R2 aren't configured, the executor stays null and its tools are simply
	// unavailable (the tool dispatcher returns "no registered executor") instead
	// of crashing mid-request.
	const embeddingClient = process.env.EMBEDDING_API_URL
		? new EmbeddingClient(
				process.env.EMBEDDING_API_URL,
				process.env.EMBEDDING_API_KEY ?? "",
			)
		: null;

	const hasAssetInfra =
		embeddingClient !== null &&
		!!process.env.DATABASE_URL &&
		!!process.env.R2_BUCKET;

	let assetToolExecutor: AssetToolExecutor | null = null;
	if (hasAssetInfra) {
		// All deps are present — wire the real stores. Dynamic imports keep the
		// db module (which throws on missing DATABASE_URL) off the import graph
		// for dev / test boots that don't have that env set.
		const [{ db }, { AssetStore }, { BrandStore }, { ObjectStorage }] =
			await Promise.all([
				import("./db/index.js"),
				import("./assets/asset-store.js"),
				import("./assets/brand-store.js"),
				import("./services/object-storage.js"),
			]);
		assetToolExecutor = new AssetToolExecutor({
			assetStore: new AssetStore(db),
			brandStore: new BrandStore(db),
			characterStore: new CharacterStore(db as any),
			objectStorage: new ObjectStorage({
				accountId: process.env.R2_ACCOUNT_ID ?? "",
				accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
				secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
				bucket: process.env.R2_BUCKET!,
			} as any),
			embeddingClient: embeddingClient!,
		});
	} else if (embeddingClient) {
		console.warn(
			"[boot] AssetToolExecutor disabled: DATABASE_URL and R2_BUCKET must both be set " +
				"alongside EMBEDDING_API_URL for asset tools to load.",
		);
	}

	// Phase 5a: VisionToolExecutor wires the three vision tools to a real
	// Gemini Files API + analyze pipeline backed by the DB-side VisionCache.
	// Gated on GEMINI_API_KEY (the actual call) + DATABASE_URL (the cache);
	// without the cache, every tool call would hit Gemini fresh — defeats
	// the SCHEMA_VERSION-keyed dedup that the cache exists for.
	let visionToolExecutor: VisionToolExecutor | null = null;
	if (process.env.GEMINI_API_KEY && process.env.DATABASE_URL) {
		const { db } = await import("./db/index.js");
		visionToolExecutor = new VisionToolExecutor({
			visionClient: new VisionClient(process.env.GEMINI_API_KEY),
			visionCache: new VisionCache(db),
		});
		console.log(
			"[boot] vision-tool-executor wired (Gemini Files API + DB-cached)",
		);
	} else {
		console.warn(
			"[boot] VisionToolExecutor disabled: GEMINI_API_KEY + DATABASE_URL must both be set for analyze_video to reach Gemini.",
		);
	}

	// Create ChangesetManager for propose/approve/reject workflow
	const changeLog = new ChangeLog();
	const changesetManager = new ChangesetManager({
		changeLog,
		serverCore: serverEditorCore,
	});

	// ── Memory infrastructure (audit §B.MemoryStore/Loader/Extractor/PatternObserver) ──
	// The MemoryStore is the single backing R2 client used by both the
	// MasterAgent (writer-token claim + per-turn memory injection) AND the
	// /skills route. Previously the skillsRouter block built its own
	// MemoryStore which was never visible to MasterAgent — that left
	// memoryLoader / memoryExtractor / patternObserver dormant. Hoisting
	// here gives both consumers the same instance.
	//
	// ContextSynchronizer is unconditional (it only needs the in-process
	// ChangeLog) so wiring works even without R2.
	const contextSynchronizer = new ContextSynchronizer(changeLog);

	let r2: import("./services/object-storage.js").ObjectStorage | null = null;
	let memoryStore: import("./memory/memory-store.js").MemoryStore | null = null;
	let memoryLoader: import("./memory/memory-loader.js").MemoryLoader | null =
		null;
	if (process.env.R2_BUCKET) {
		const [{ ObjectStorage }, { MemoryStore }, { MemoryLoader }] =
			await Promise.all([
				import("./services/object-storage.js"),
				import("./memory/memory-store.js"),
				import("./memory/memory-loader.js"),
			]);
		r2 = new ObjectStorage({
			accountId: process.env.R2_ACCOUNT_ID ?? "",
			accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
			bucket: process.env.R2_BUCKET!,
		} as any);
		// The user-id scope here matches the skill-store fallback ("default").
		// Replace with per-request user scoping when the auth middleware lands.
		memoryStore = new MemoryStore(r2 as any, "default");
		memoryLoader = new MemoryLoader(memoryStore);
	} else {
		console.warn(
			"[boot] Memory layer disabled: R2_BUCKET not set. MasterAgent will run without memory injection.",
		);
	}

	// ── CoreRegistry + DrizzleMutationDB (audit Phase 2C-2) ──────────────────
	// When DATABASE_URL is set we stand up the per-project registry and a
	// drizzle-backed MutationDB so the /commands route can persist via
	// commitMutation. The legacy singleton serverEditorCore stays wired
	// for the dev/test boot that has no DB. Cutover to a registry-only
	// boot lands when all consumers (changesetManager, ExplorationEngine,
	// Master tool exec) take projectId-scoped cores instead of the
	// singleton — tracked as a follow-up to this phase.
	let coreRegistry:
		| import("./services/core-registry.js").CoreRegistry
		| null = null;
	let mutationDB:
		| import("./services/commit-mutation.js").MutationDB
		| null = null;
	if (process.env.DATABASE_URL) {
		const [{ CoreRegistry }, { DrizzleSnapshotSource }, { DrizzleMutationDB }, { db }] =
			await Promise.all([
				import("./services/core-registry.js"),
				import("./services/drizzle-snapshot-source.js"),
				import("./services/drizzle-mutation-db.js"),
				import("./db/index.js"),
			]);
		coreRegistry = new CoreRegistry({
			source: new DrizzleSnapshotSource(db),
		});
		mutationDB = new DrizzleMutationDB(db);
	} else {
		console.warn(
			"[boot] CoreRegistry + MutationDB disabled: DATABASE_URL not set. /commands runs against the singleton serverEditorCore (no persistence).",
		);
	}

	// ── Job queue + ExplorationEngine (audit §B.JobQueue / §B.ExplorationEngine) ──
	// pg-boss requires DATABASE_URL. ExplorationEngine then needs the queue,
	// a real ServerEditorCore, R2, and the drizzle db. Each dep is gated so
	// a partial setup degrades gracefully (the explore_options master tool
	// returns "not configured" when explorationEngine is absent).
	let jobQueue: import("./services/job-queue.js").JobQueue | null = null;
	let explorationEngine:
		| import("./exploration/exploration-engine.js").ExplorationEngine
		| null = null;
	if (process.env.DATABASE_URL) {
		const { JobQueue } = await import("./services/job-queue.js");
		const queue = new JobQueue({
			connectionString: process.env.DATABASE_URL,
		});
		// Reviewer MEDIUM #4: pg-boss connect failures (bad connection
		// string, transient network) must not abort the whole boot. Every
		// other subsystem here degrades gracefully; mirror that behaviour so
		// a queue outage doesn't take down chat / changeset routes.
		try {
			await queue.start();
			jobQueue = queue;
		} catch (err) {
			console.warn(
				`[boot] JobQueue.start() failed; ExplorationEngine will be disabled. Error: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		if (jobQueue) {
			// Phase 3: GpuServiceClient is the preview-render path. The
			// worker wires when GPU_SERVICE_BASE_URL + GPU_SERVICE_API_KEY
			// are both set; otherwise the stub-log path keeps the queue
			// draining without errors.
			let gpuClient:
				| import("./services/gpu-service-client.js").GpuServiceClient
				| null = null;
			if (
				process.env.GPU_SERVICE_BASE_URL &&
				process.env.GPU_SERVICE_API_KEY
			) {
				const { GpuServiceClient } = await import(
					"./services/gpu-service-client.js"
				);
				gpuClient = new GpuServiceClient({
					baseUrl: process.env.GPU_SERVICE_BASE_URL,
					apiKey: process.env.GPU_SERVICE_API_KEY,
				});
				console.log(
					`[boot] gpu-service-client wired (URL=${process.env.GPU_SERVICE_BASE_URL})`,
				);
			} else {
				console.warn(
					"[boot] gpu-service-client not configured: set GPU_SERVICE_BASE_URL + GPU_SERVICE_API_KEY to enable preview rendering",
				);
			}

			// Worker handler extracted to src/services/preview-render-worker.ts
			// for unit-testability of the full enqueue → poll → log lifecycle.
			//
			// Reviewer Stage C MED #10: dynamic-import failure (build artifact
			// missing, typo) used to crash the entire boot. Wrap and degrade
			// gracefully — preview rendering disabled, but other subsystems
			// (chat, changeset, memory) still come up.
			let handlePreviewRender:
				| typeof import("./services/preview-render-worker.js").handlePreviewRender
				| null = null;
			try {
				({ handlePreviewRender } = await import(
					"./services/preview-render-worker.js"
				));
			} catch (err) {
				console.warn(
					`[boot] preview-render-worker import failed; preview rendering disabled. Error: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			// Stage E.2: writeback persists per-candidate render outcomes
			// to exploration_sessions so a page reload mid-render still
			// finds the preview (or its failure metadata) via the
			// /exploration route. We're already inside the
			// `if (process.env.DATABASE_URL)` branch, but the `db` handle
			// from the CoreRegistry block above is destructured-locally
			// (line 212) and out of scope here, so re-import — same
			// pattern the ExplorationEngine block below uses.
			const { DrizzlePreviewWriteback } = await import(
				"./services/preview-writeback.js"
			);
			const { db: drizzleDb } = await import("./db/index.js");
			const previewWriteback = new DrizzlePreviewWriteback(drizzleDb);

			if (handlePreviewRender) {
				const handler = handlePreviewRender;
				// Stage D.3 + E.2 + E.5: thread EventBus + writeback +
				// signer (R2 satisfies PreviewSigner via getSignedUrl) so
				// the candidate_ready event carries a 24h presigned URL
				// when R2 is configured. With no R2, the event still fires
				// with storageKey only and the route fallback handles
				// signing on demand (E.3).
				jobQueue.registerWorker<
					import("./services/preview-render-worker.js").PreviewRenderJobData
				>("preview-render", (job) =>
					handler(job, {
						gpuClient,
						eventBus,
						writeback: previewWriteback,
						signer: r2 ?? null,
					}),
				);
			}

			if (r2) {
				const { ExplorationEngine } = await import(
					"./exploration/exploration-engine.js"
				);
				const { db } = await import("./db/index.js");
				// `r2` narrows to ObjectStorage in this branch — no cast needed.
				// `db` is the drizzle handle; ExplorationEngine declares a
				// minimal `ExplorationDB` interface and drizzle satisfies it
				// structurally at runtime. Cast via `unknown` to that named
				// type instead of `any` so future drift surfaces in tsc.
				type ExplorationDBT =
					import("./exploration/exploration-engine.js").ExplorationDB;
				explorationEngine = new ExplorationEngine({
					serverCore: serverEditorCore,
					jobQueue,
					objectStorage: r2,
					db: db as unknown as ExplorationDBT,
				});
			} else {
				console.warn(
					"[boot] ExplorationEngine disabled: R2_BUCKET required (in addition to DATABASE_URL).",
				);
			}
		}
	} else {
		console.warn(
			"[boot] JobQueue + ExplorationEngine disabled: DATABASE_URL not set. fan-out exploration unavailable.",
		);
	}

	// ── CreatorToolExecutor (audit §B.ContentEditor / Phase 1C) ──────────────
	// First call site for the previously-dormant ContentEditor pipeline.
	// Requires GENERATION_API_URL + R2 — without both we leave the executor
	// null and the toolExecutor router falls through to "no registered
	// executor" for generate_into_segment, matching the AssetToolExecutor
	// fail-fast pattern.
	let creatorToolExecutor:
		| import("./tools/creator-tool-executor.js").CreatorToolExecutor
		| null = null;
	if (process.env.GENERATION_API_URL && r2) {
		const [{ ContentEditor }, { GenerationClient }, { CreatorToolExecutor }] =
			await Promise.all([
				import("./services/content-editor.js"),
				import("./services/generation-client.js"),
				import("./tools/creator-tool-executor.js"),
			]);
		const generationClient = new GenerationClient({
			baseUrl: process.env.GENERATION_API_URL,
			apiKey: process.env.GENERATION_API_KEY ?? "",
		});
		const contentEditor = new ContentEditor({
			generationClient,
			objectStorage: r2,
			serverEditorCore,
		});
		creatorToolExecutor = new CreatorToolExecutor({ contentEditor });
	} else {
		console.warn(
			"[boot] CreatorToolExecutor disabled: GENERATION_API_URL and R2_BUCKET must both be set for generate_into_segment to load.",
		);
	}

	// Phase 5a LOW-2: assert no two registered executors share a tool
	// name. Tool names must be globally unique across executors because
	// the router below is a first-match-wins linear scan; a future
	// collision would silently route to the earlier executor and the
	// later registration's handler would never fire. This guard runs
	// once at boot and fails fast if a developer ever ships a duplicate.
	{
		const seen = new Map<string, string>();
		const announce = (
			label: string,
			exec: { hasToolName(name: string): boolean } | null,
			names: string[],
		) => {
			if (!exec) return;
			for (const n of names) {
				if (!exec.hasToolName(n)) continue;
				const prior = seen.get(n);
				if (prior) {
					throw new Error(
						`[boot] tool name collision: "${n}" registered by both ${prior} and ${label}`,
					);
				}
				seen.set(n, label);
			}
		};
		const allNames = [
			...(await import("./tools/editor-tools.js")).EDITOR_TOOL_DEFINITIONS.map(
				(t) => t.name,
			),
			...(await import("./tools/asset-tools.js")).assetToolDefinitions.map(
				(t) => t.name,
			),
			...(await import("./tools/creator-tools.js")).creatorToolDefinitions.map(
				(t) => t.name,
			),
			...(await import("./tools/vision-tools.js")).visionToolDefinitions.map(
				(t) => t.name,
			),
		];
		announce("editor", editorToolExecutor, allNames);
		announce("asset", assetToolExecutor, allNames);
		announce("creator", creatorToolExecutor, allNames);
		announce("vision", visionToolExecutor, allNames);
	}

	// Tool executor for sub-agents — routes to real implementations when available.
	// Accepts optional ToolContext from the pipeline so identity (sessionId/userId)
	// reaches the underlying executor for tenant-scoped operations.
	//
	// ORDER MATTERS: this is a first-match-wins linear scan via
	// `hasToolName`. A startup assertion above guarantees tool names are
	// globally unique across executors, so the order is observably
	// equivalent to a name → executor map; sequencing is preserved for
	// dev clarity (most-edited surfaces first). Phase 5a HIGH-1 fix:
	// `onProgress` is now threaded as the 4th arg so long-running tools
	// (analyze_video and future generation/transcription) can emit
	// `tool.progress` events through the EventBus → SSE → web pipeline.
	const toolExecutor = async (
		name: string,
		input: unknown,
		context?: {
			agentType?: string;
			taskId?: string;
			sessionId?: string;
			userId?: string;
		},
		onProgress?: (
			event: import("./tools/types.js").ToolProgressEvent,
		) => void,
	) => {
		if (editorToolExecutor.hasToolName(name)) {
			return editorToolExecutor.execute(
				name,
				input,
				{
					agentType: (context?.agentType as any) ?? "editor",
					taskId: context?.taskId ?? "default",
					sessionId: context?.sessionId,
					userId: context?.userId,
				},
				onProgress as any,
			);
		}
		if (assetToolExecutor?.hasToolName(name)) {
			return assetToolExecutor.execute(
				name,
				input,
				{
					agentType: (context?.agentType as any) ?? "asset",
					taskId: context?.taskId ?? "default",
					sessionId: context?.sessionId,
					userId: context?.userId,
				},
				onProgress as any,
			);
		}
		if (creatorToolExecutor?.hasToolName(name)) {
			return creatorToolExecutor.execute(
				name,
				input,
				{
					agentType: (context?.agentType as any) ?? "creator",
					taskId: context?.taskId ?? "default",
					sessionId: context?.sessionId,
					userId: context?.userId,
				},
				onProgress as any,
			);
		}
		if (visionToolExecutor?.hasToolName(name)) {
			return visionToolExecutor.execute(
				name,
				input,
				{
					agentType: (context?.agentType as any) ?? "vision",
					taskId: context?.taskId ?? "default",
					sessionId: context?.sessionId,
					userId: context?.userId,
				},
				onProgress as any,
			);
		}
		return {
			success: false,
			error: `Tool "${name}" has no registered executor`,
		};
	};

	// Build sub-agent dispatchers
	const sharedAgentDeps = { apiKey, toolExecutor, hooks: [eventBusHook] };
	const editorAgent = new EditorAgent(sharedAgentDeps);
	const creatorAgent = new CreatorAgent(sharedAgentDeps);
	const audioAgent = new AudioAgent(sharedAgentDeps);
	const visionAgent = new VisionAgent(sharedAgentDeps);
	const assetAgent = new AssetAgent(sharedAgentDeps);
	const verificationAgent = new VerificationAgent({ toolExecutor, apiKey });

	const subAgentDispatchers = new Map<
		string,
		(input: DispatchInput) => Promise<DispatchOutput>
	>([
		["editor", (input) => editorAgent.dispatch(input)],
		["creator", (input) => creatorAgent.dispatch(input)],
		["audio", (input) => audioAgent.dispatch(input)],
		["vision", (input) => visionAgent.dispatch(input)],
		["asset", (input) => assetAgent.dispatch(input)],
		["verification", (input) => verificationAgent.dispatch(input)],
	]);

	// Wire MasterAgent — turn tracking is per-request in messageHandler (B3 fix)
	const { taskRegistry } = services;
	const masterAgent = createWiredMasterAgent({
		apiKey,
		contextManager,
		writeLock,
		eventBusHook,
		skillContracts,
		subAgentDispatchers,
		changesetManager,
		taskRegistry,
		serverCore: serverEditorCore,
		memoryStore: memoryStore ?? undefined,
		memoryLoader: memoryLoader ?? undefined,
		contextSynchronizer,
		explorationEngine: explorationEngine ?? undefined,
	});

	// ── Memory consumers wired AFTER MasterAgent (writer token sequencing) ──
	// MasterAgent claims the sole writer token on construction. Extractor /
	// PatternObserver receive the writer callback via masterAgent.getMemoryWriter()
	// so they don't need to see the store directly (spec §9.4).
	let patternObserver: PatternObserver | null = null;
	if (memoryStore) {
		const writeMemory = masterAgent.getMemoryWriter();
		const extractor = new MemoryExtractor({
			changeLog,
			memoryReader: memoryStore,
			writeMemory,
		});
		extractor.start();
		patternObserver = new PatternObserver({
			memoryReader: memoryStore,
			writeMemory,
		});
	}

	// Phase 5e: main() throws above if ANTHROPIC_API_KEY is missing, so this
	// constructor always runs in production. The optional `sessionCompactor?`
	// dep on createMessageHandler still exists for tests + minimal boots that
	// invoke createMessageHandler directly without an apiKey in scope.
	const sessionCompactor = new SessionCompactor({
		summarize: createAnthropicSummarizer({ apiKey }),
	});

	const messageHandler = createMessageHandler({
		masterAgent,
		sessionManager,
		eventBus,
		sessionCompactor,
		// Reviewer HIGH #2: capture patternObserver in a local const
		// inside the truthy branch so the async closure holds a non-null
		// reference instead of relying on `!` (which a future re-null of
		// the outer binding would silently invalidate). Same shape — the
		// IIFE just exists to give the const a scope tighter than this
		// object literal.
		afterTurn: (() => {
			const observer = patternObserver;
			if (!observer) return undefined;
			return async (identity: { projectId: string; sessionId: string; userId?: string }) => {
				const mapping = contextManager.getBrandForProject(identity.projectId);
				if (!mapping) return;
				maybeTriggerAnalysis(observer, mapping.brand, mapping.series);
			};
		})(),
	});

	// B8: Construct skillsRouter only when DB + R2 are configured. Previously
	// we passed `{} as any` for skillStore / memoryStore, which NPE'd on the
	// first /skills request. Now the route is either fully wired or not
	// mounted at all; createApp handles `skillsRouter: undefined` by skipping
	// the mount so /skills simply returns 404 in unconfigured deployments.
	//
	// Audit §B.MemoryStore fix: reuse the hoisted memoryStore (built above
	// before MasterAgent construction) instead of creating a second instance
	// — that split-brain was why MasterAgent's memoryStore was always
	// undefined even when /skills had its own.
	let skillsRouter: import("hono").Hono | undefined;
	if (process.env.DATABASE_URL && memoryStore) {
		const [{ createSkillsRouter }, { SkillStore }, { db }] = await Promise.all([
			import("./routes/skills.js"),
			import("./assets/skill-store.js"),
			import("./db/index.js"),
		]);
		skillsRouter = createSkillsRouter({
			skillStore: new SkillStore(db),
			memoryStore,
		});
	} else {
		console.warn(
			"[boot] /skills route disabled: DATABASE_URL and R2_BUCKET must both be set to mount it.",
		);
	}

	// Create changeset router wired to real ChangesetManager
	const { createChangesetRouter } = await import("./routes/changeset.js");
	const changesetRouter = createChangesetRouter({ changesetManager });

	// Phase 3 Stage E.4: build the per-candidate preview lookup so the
	// /exploration route can serve 200/422/404 instead of 503. Gated on
	// DATABASE_URL — same gate as the worker writeback that populates
	// the rows it reads.
	let explorationLookup:
		| import("./services/exploration-lookup.js").ExplorationLookup
		| undefined;
	if (process.env.DATABASE_URL) {
		const [{ DrizzleExplorationLookup }, { db: drizzleDb }] =
			await Promise.all([
				import("./services/exploration-lookup.js"),
				import("./db/index.js"),
			]);
		explorationLookup = new DrizzleExplorationLookup(drizzleDb);
	}

	// Create app ONCE with shared services, messageHandler, and available infrastructure
	const app = createApp({
		services,
		messageHandler,
		infrastructure: {
			serverEditorCore,
			contextManager,
			// Stage E.4: object storage now reaches /exploration too — was
			// previously only constructed inside AssetToolExecutor (line ~136)
			// and never made it onto the infra block, so /media + /exploration
			// fell through to 503. Pass the shared `r2` here.
			objectStorage: r2 ?? undefined,
			coreRegistry: coreRegistry ?? undefined,
			mutationDB: mutationDB ?? undefined,
			explorationLookup,
		},
		skillsRouter,
		changesetRouter,
	});
	const port = parseInt(process.env.PORT || "4000");

	serve({ fetch: app.fetch, port }, (info) => {
		console.log(
			`ChatCut Agent Service running on http://localhost:${info.port}`,
		);
		console.log(`  ${subAgentDispatchers.size} sub-agents registered`);
		if (skillContracts.length > 0) {
			console.log(`  ${skillContracts.length} skill contract(s) loaded`);
		}
		console.log(`  ${availableToolNames.length} master tools available`);
	});
}

main();
