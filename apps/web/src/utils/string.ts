// Re-export from @opencut/core
export { capitalizeFirstLetter } from "@opencut/core";

// Web-only utility
export function uppercase({ string }: { string: string }) {
	return string.toUpperCase();
}
