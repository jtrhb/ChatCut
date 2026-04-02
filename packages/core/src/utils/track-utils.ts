import type {
	TrackType,
	TimelineTrack,
	ElementType,
	VideoTrack,
	AudioTrack,
	StickerTrack,
	TextTrack,
	EffectTrack,
	TimelineElement,
} from "../types/timeline";
import { generateUUID } from "./id";

/** Server-safe track default names (no JSX/React icons) */
const TRACK_DEFAULT_NAMES: Record<TrackType, string> = {
	video: "Video track",
	text: "Text track",
	audio: "Audio track",
	sticker: "Sticker track",
	effect: "Effect track",
};

export function canTrackHaveAudio(
	track: TimelineTrack,
): track is VideoTrack | AudioTrack {
	return track.type === "audio" || track.type === "video";
}

/** @deprecated Use `canTrackHaveAudio` instead. */
export const canTracktHaveAudio = canTrackHaveAudio;

export function canTrackBeHidden(
	track: TimelineTrack,
): track is VideoTrack | TextTrack | StickerTrack | EffectTrack {
	return track.type !== "audio";
}

export function buildEmptyTrack({
	id,
	type,
	name,
}: {
	id: string;
	type: TrackType;
	name?: string;
}): TimelineTrack {
	const trackName = name ?? TRACK_DEFAULT_NAMES[type];

	switch (type) {
		case "video":
			return {
				id,
				name: trackName,
				type: "video",
				elements: [],
				hidden: false,
				muted: false,
				isMain: false,
			};
		case "text":
			return {
				id,
				name: trackName,
				type: "text",
				elements: [],
				hidden: false,
			};
		case "sticker":
			return {
				id,
				name: trackName,
				type: "sticker",
				elements: [],
				hidden: false,
			};
		case "audio":
			return {
				id,
				name: trackName,
				type: "audio",
				elements: [],
				muted: false,
			};
		case "effect":
			return {
				id,
				name: trackName,
				type: "effect",
				elements: [],
				hidden: false,
			};
		default:
			throw new Error(`Unsupported track type: ${type}`);
	}
}

export function getDefaultInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: TimelineTrack[];
	trackType: TrackType;
}): number {
	if (trackType === "audio") {
		return tracks.length;
	}

	if (trackType === "effect") {
		return 0;
	}

	const mainTrackIndex = tracks.findIndex((track) => isMainTrack(track));
	if (mainTrackIndex >= 0) {
		return mainTrackIndex;
	}

	const firstAudioTrackIndex = tracks.findIndex(
		(track) => track.type === "audio",
	);
	if (firstAudioTrackIndex >= 0) {
		return firstAudioTrackIndex;
	}

	return tracks.length;
}

export function getHighestInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: TimelineTrack[];
	trackType: TrackType;
}): number {
	const mainTrackIndex = tracks.findIndex((track) => isMainTrack(track));

	if (trackType === "audio") {
		return mainTrackIndex >= 0 ? mainTrackIndex + 1 : tracks.length;
	}

	return 0;
}

export function isMainTrack(track: TimelineTrack): track is VideoTrack {
	return track.type === "video" && track.isMain === true;
}

export function getMainTrack({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack | null {
	return tracks.find((track) => isMainTrack(track)) ?? null;
}

export function ensureMainTrack({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack[] {
	const hasMainTrack = tracks.some((track) => isMainTrack(track));

	if (!hasMainTrack) {
		const mainTrack: TimelineTrack = {
			id: generateUUID(),
			name: "Main Track",
			type: "video",
			elements: [],
			muted: false,
			isMain: true,
			hidden: false,
		};
		return [mainTrack, ...tracks];
	}

	return tracks;
}

export function canElementGoOnTrack({
	elementType,
	trackType,
}: {
	elementType: ElementType;
	trackType: TrackType;
}): boolean {
	if (elementType === "text") return trackType === "text";
	if (elementType === "audio") return trackType === "audio";
	if (elementType === "sticker") return trackType === "sticker";
	if (elementType === "effect") return trackType === "effect";
	if (elementType === "video" || elementType === "image") {
		return trackType === "video";
	}
	return false;
}

export function validateElementTrackCompatibility({
	element,
	track,
}: {
	element: { type: ElementType };
	track: { type: TrackType };
}): { isValid: boolean; errorMessage?: string } {
	const isValid = canElementGoOnTrack({
		elementType: element.type,
		trackType: track.type,
	});

	if (!isValid) {
		return {
			isValid: false,
			errorMessage: `${element.type} elements cannot be placed on ${track.type} tracks`,
		};
	}

	return { isValid: true };
}

export function getEarliestMainTrackElement({
	tracks,
	excludeElementId,
}: {
	tracks: TimelineTrack[];
	excludeElementId?: string;
}): TimelineElement | null {
	const mainTrack = getMainTrack({ tracks });
	if (!mainTrack) {
		return null;
	}

	const elements = mainTrack.elements.filter(
		(element) => !excludeElementId || element.id !== excludeElementId,
	);

	if (elements.length === 0) {
		return null;
	}

	return elements.reduce((earliest, element) =>
		element.startTime < earliest.startTime ? element : earliest,
	);
}

export function enforceMainTrackStart({
	tracks,
	targetTrackId,
	requestedStartTime,
	excludeElementId,
}: {
	tracks: TimelineTrack[];
	targetTrackId: string;
	requestedStartTime: number;
	excludeElementId?: string;
}): number {
	const mainTrack = getMainTrack({ tracks });
	if (!mainTrack || mainTrack.id !== targetTrackId) {
		return requestedStartTime;
	}

	const earliestElement = getEarliestMainTrackElement({
		tracks,
		excludeElementId,
	});

	if (!earliestElement) {
		return 0;
	}

	if (requestedStartTime <= earliestElement.startTime) {
		return 0;
	}

	return requestedStartTime;
}
