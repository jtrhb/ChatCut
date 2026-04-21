import type { ExtensionManifest, ExtensionType } from "./types.js";

/**
 * Phase 5f (deferral notice).
 *
 * STATUS: Wired but unwired. The class API is complete and unit-tested
 * (`__tests__/extension-registry.test.ts`), but it has ZERO production
 * call sites. Searching the agent tree finds only this file and its test
 * — no `new ExtensionRegistry()` in `index.ts`, no injection through
 * `createServices` / `createWiredMasterAgent`, no consumer reading
 * `listByType()` / `listAll()` to drive runtime behavior.
 *
 * WHY DEFERRED: Per `borrowing-review Round 10`
 * (docs/superpowers/research/advanced-agent-borrowing-review.md):
 *   先要有 extension contract，再谈 extension ecosystem
 *   ("first define the extension contract, then talk about the
 *    extension ecosystem.")
 *
 * The registry is the *runtime* half of the extension story — it stores
 * manifests and lets callers enumerate them. The missing half is the
 * *contract*: WHAT does an enabled extension actually DO? Each
 * `ExtensionType` (tool, prompt, agent, …) needs a concrete loading +
 * dispatch path before the registry can usefully gate anything. Wiring
 * the registry without the contract would create a dormant extension
 * point that callers can register against but nothing dispatches —
 * worse than no extension point because it implies a guarantee the
 * runtime can't keep.
 *
 * WHEN TO WIRE: as soon as the FIRST concrete extension lands —
 * whichever of (a) a third-party tool that the master agent dispatches
 * dynamically based on registry state, (b) a user-installed prompt
 * fragment that PromptBuilder reads, (c) a third-party sub-agent class
 * the dispatcher table can route to, etc. comes first. At that point
 * the relevant call site (`tool-pipeline`, `PromptBuilder`,
 * `MasterAgent`'s dispatcher) gains a registry dep and reads from it.
 *
 * WHAT NOT TO DO: don't pre-emptively wire `new ExtensionRegistry()`
 * through `createServices` "just in case." The cost of wiring is
 * trivial; the value is zero until something reads the registry, and
 * the dependency creep makes it harder to refactor the API once a real
 * caller materializes.
 *
 * Audit cross-reference: `.omc/plans/wiring-audit-remediation.md` §C.5f
 * marks this entry as "deferred — see extension-registry.ts header"
 * (this file). Do not promote it to "wired" in the audit plan until at
 * least one production call site exists.
 */
export class ExtensionRegistry {
	private extensions = new Map<string, ExtensionManifest>();

	register(manifest: ExtensionManifest): void {
		if (this.extensions.has(manifest.id)) {
			throw new Error(`Extension already registered: ${manifest.id}`);
		}
		this.extensions.set(manifest.id, { ...manifest });
	}

	unregister(id: string): void {
		this.extensions.delete(id);
	}

	get(id: string): ExtensionManifest | undefined {
		const ext = this.extensions.get(id);
		return ext ? { ...ext } : undefined;
	}

	enable(id: string): void {
		const ext = this.extensions.get(id);
		if (!ext) throw new Error(`Extension not found: ${id}`);
		ext.enabled = true;
	}

	disable(id: string): void {
		const ext = this.extensions.get(id);
		if (!ext) throw new Error(`Extension not found: ${id}`);
		ext.enabled = false;
	}

	listByType(
		type: ExtensionType,
		opts?: { includeDisabled?: boolean },
	): ExtensionManifest[] {
		return Array.from(this.extensions.values())
			.filter((e) => e.type === type)
			.filter((e) => opts?.includeDisabled || e.enabled)
			.map((e) => ({ ...e }));
	}

	listAll(): ExtensionManifest[] {
		return Array.from(this.extensions.values()).map((e) => ({ ...e }));
	}
}
