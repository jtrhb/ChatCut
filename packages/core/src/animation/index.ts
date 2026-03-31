export {
	getChannelValueAtTime,
	getNumberChannelValueAtTime,
	normalizeChannel,
} from "./interpolation";

export {
	clampAnimationsToDuration,
	cloneAnimations,
	getChannel,
	removeElementKeyframe,
	retimeElementKeyframe,
	setChannel,
	splitAnimationsAtTime,
	upsertElementKeyframe,
} from "./keyframes";

export {
	coerceAnimationValueForProperty,
	getAnimationPropertyDefinition,
	getDefaultInterpolationForProperty,
	getElementBaseValueForProperty,
	isAnimationPropertyPath,
	supportsAnimationProperty,
	withElementBaseValueForProperty,
} from "./property-registry";

export {
	upsertEffectParamKeyframe,
	removeEffectParamKeyframe,
	resolveEffectParamsAtTime,
} from "./effect-param-channel";
