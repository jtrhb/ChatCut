// EditorCore
export { EditorCore } from "./editor-core";
export type { SerializedEditorState } from "./editor-core";

// ChangeLog
export { ChangeLog } from "./change-log";
export * from "./types/change-log";

// Managers
export { CommandManager } from "./managers/commands";
export type { ExecuteOptions } from "./managers/commands";
export { TimelineManager } from "./managers/timeline-manager";
export { ScenesManager } from "./managers/scenes-manager";
export { SelectionManager } from "./managers/selection-manager";
export { ProjectManager } from "./managers/project-manager";

// Commands
export { Command } from "./commands/base-command";
export { BatchCommand } from "./commands/batch-command";
export { PreviewTracker } from "./commands/preview-tracker";
export * from "./commands/timeline";
export * from "./commands/scene";
export * from "./commands/project";

// Types - Timeline
export type {
	Bookmark,
	TScene,
	TrackType,
	VideoTrack,
	TextTrack,
	AudioTrack,
	StickerTrack,
	EffectTrack,
	TimelineTrack,
	AudioElement,
	UploadAudioElement,
	LibraryAudioElement,
	VideoElement,
	ImageElement,
	TextBackground,
	TextElement,
	StickerElement,
	EffectElement,
	VisualElement,
	ElementUpdatePatch,
	TimelineElement,
	ElementType,
	CreateUploadAudioElement,
	CreateLibraryAudioElement,
	CreateAudioElement,
	CreateVideoElement,
	CreateImageElement,
	CreateTextElement,
	CreateStickerElement,
	CreateEffectElement,
	CreateTimelineElement,
	ClipboardItem,
	Transform,
} from "./types/timeline";

// Types - Project
export type {
	TBackground,
	TCanvasSize,
	TProjectMetadata,
	TProjectSettings,
	TTimelineViewState,
	TProject,
} from "./types/project";

// Types - Effects
export type {
	Effect,
	EffectParamType,
	EffectParamValues,
	EffectParamDefinition,
	EffectDefinition,
} from "./types/effects";

// Types - Animation
export type {
	AnimationPropertyPath,
	AnimationValueKind,
	AnimationValue,
	AnimationInterpolation,
	AnimationKeyframe,
	NumberKeyframe,
	ColorKeyframe,
	DiscreteKeyframe,
	AnimationChannel,
	NumberAnimationChannel,
	ColorAnimationChannel,
	DiscreteAnimationChannel,
	ElementAnimationChannelMap,
	ElementAnimations,
	ElementKeyframe,
	SelectedKeyframeRef,
} from "./types/animation";
export { ANIMATION_PROPERTY_PATHS } from "./types/animation";

// Types - Rendering
export type { BlendMode } from "./types/rendering";

// Types - Time
export type { TTimeCode } from "./types/time";

// Animation utilities
export {
	getChannelValueAtTime,
	getNumberChannelValueAtTime,
	normalizeChannel,
	clampAnimationsToDuration,
	cloneAnimations,
	getChannel,
	removeElementKeyframe,
	retimeElementKeyframe,
	setChannel,
	splitAnimationsAtTime,
	upsertElementKeyframe,
	coerceAnimationValueForProperty,
	getAnimationPropertyDefinition,
	getDefaultInterpolationForProperty,
	getElementBaseValueForProperty,
	isAnimationPropertyPath,
	supportsAnimationProperty,
	withElementBaseValueForProperty,
	upsertEffectParamKeyframe,
	removeEffectParamKeyframe,
	resolveEffectParamsAtTime,
} from "./animation";

// Utils
export { generateUUID } from "./utils/id";
export { capitalizeFirstLetter } from "./utils/string";
export {
	roundToFrame,
	formatTimeCode,
	parseTimeCode,
	guessTimeCodeFormat,
	timeToFrame,
	frameToTime,
	snapTimeToFrame,
	getSnappedSeekTime,
	getLastFrameTime,
} from "./utils/time";
export {
	canElementHaveAudio,
	isVisualElement,
	canElementBeHidden,
	hasMediaId,
	requiresMediaId,
	wouldElementOverlap,
	getElementsAtTime,
} from "./utils/element-utils";
export {
	canTracktHaveAudio,
	canTrackBeHidden,
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
	getHighestInsertIndexForTrack,
	isMainTrack,
	getMainTrack,
	ensureMainTrack,
	canElementGoOnTrack,
	validateElementTrackCompatibility,
	enforceMainTrackStart,
} from "./utils/track-utils";
export { updateElementInTracks } from "./utils/track-element-update";
export { rippleShiftElements } from "./utils/ripple-utils";
export { calculateTotalDuration } from "./utils/timeline-utils";
export {
	getMainScene,
	ensureMainScene,
	buildDefaultScene,
	canDeleteScene,
	getFallbackSceneAfterDelete,
	findCurrentScene,
	getProjectDurationFromScenes,
	updateSceneInArray,
} from "./utils/scenes";
export {
	getFrameTime,
	isBookmarkAtTime,
	toggleBookmarkInArray,
	removeBookmarkFromArray,
	updateBookmarkInArray,
	moveBookmarkInArray,
	getBookmarkAtTime,
	findBookmarkIndex,
} from "./utils/bookmarks";
