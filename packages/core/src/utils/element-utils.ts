import type {
	AudioElement,
	CreateTimelineElement,
	ImageElement,
	TimelineElement,
	TimelineTrack,
	UploadAudioElement,
	VideoElement,
	VisualElement,
} from "../types/timeline";

export function canElementHaveAudio(
	element: TimelineElement,
): element is AudioElement | VideoElement {
	return element.type === "audio" || element.type === "video";
}

export function isVisualElement(
	element: TimelineElement,
): element is VisualElement {
	return (
		element.type === "video" ||
		element.type === "image" ||
		element.type === "text" ||
		element.type === "sticker"
	);
}

export function canElementBeHidden(
	element: TimelineElement,
): element is VisualElement {
	return isVisualElement(element);
}

export function hasMediaId(
	element: TimelineElement,
): element is UploadAudioElement | VideoElement | ImageElement {
	return "mediaId" in element;
}

export function requiresMediaId({
	element,
}: {
	element: CreateTimelineElement;
}): boolean {
	return (
		element.type === "video" ||
		element.type === "image" ||
		(element.type === "audio" && element.sourceType === "upload")
	);
}

export function wouldElementOverlap({
	elements,
	startTime,
	endTime,
	excludeElementId,
}: {
	elements: TimelineElement[];
	startTime: number;
	endTime: number;
	excludeElementId?: string;
}): boolean {
	return elements.some((element) => {
		if (excludeElementId && element.id === excludeElementId) return false;
		const elementEnd = element.startTime + element.duration;
		return startTime < elementEnd && endTime > element.startTime;
	});
}

export function getElementsAtTime({
	tracks,
	time,
}: {
	tracks: TimelineTrack[];
	time: number;
}): { trackId: string; elementId: string }[] {
	const result: { trackId: string; elementId: string }[] = [];

	for (const track of tracks) {
		for (const element of track.elements) {
			const elementStart = element.startTime;
			const elementEnd = element.startTime + element.duration;

			if (time > elementStart && time < elementEnd) {
				result.push({ trackId: track.id, elementId: element.id });
			}
		}
	}

	return result;
}
