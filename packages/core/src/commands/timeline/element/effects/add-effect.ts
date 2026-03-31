import { Command } from "../../../base-command";
import { EditorCore } from "../../../../editor-core";
import { isVisualElement } from "../../../../utils/element-utils";
import { updateElementInTracks } from "../../../../utils/track-element-update";
import type { TimelineTrack, VisualElement } from "../../../../types/timeline";
import type { Effect, EffectParamValues } from "../../../../types/effects";
import { generateUUID } from "../../../../utils/id";

/** Server-safe effect instance builder that creates a minimal effect */
function buildEffectInstance({ effectType }: { effectType: string }): Effect {
	return {
		id: generateUUID(),
		type: effectType,
		params: {} as EffectParamValues,
		enabled: true,
	};
}

function addEffectToElement({
	element,
	effectType,
}: {
	element: VisualElement;
	effectType: string;
}): VisualElement {
	const instance = buildEffectInstance({ effectType });
	const currentEffects = element.effects ?? [];
	return { ...element, effects: [...currentEffects, instance] };
}

export class AddClipEffectCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private effectId: string | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectType: string;

	constructor({
		trackId,
		elementId,
		effectType,
	}: {
		trackId: string;
		elementId: string;
		effectType: string;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectType = effectType;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = updateElementInTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isVisualElement,
			update: (element) => {
				const updated = addEffectToElement({
					element: element as VisualElement,
					effectType: this.effectType,
				});
				const effects = updated.effects ?? [];
				this.effectId = effects[effects.length - 1]?.id ?? null;
				return updated;
			},
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getEffectId(): string | null {
		return this.effectId;
	}
}
