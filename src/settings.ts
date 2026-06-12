/**
 * Pure settings validation and normalization helpers, kept Obsidian-free so
 * they can be unit-tested. The settings UI lives in settings-tab.ts.
 */

import { DEFAULT_SETTINGS } from "./sync";

/** Normalize a base-folder string: trim, strip stray slashes, fall back to default. */
export function cleanBaseFolder(input: string): string {
	const cleaned = input
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	return cleaned.length > 0 ? cleaned : DEFAULT_SETTINGS.baseFolder;
}

/** A path template is valid when it is non-empty after trimming. */
export function isValidTemplate(input: string): boolean {
	return input.trim().length > 0;
}

/** Coerce an interval field to a non-negative whole number of minutes (0 = off). */
export function cleanInterval(input: string | number): number {
	const value = typeof input === "number" ? input : Number.parseInt(input, 10);
	if (!Number.isFinite(value) || value < 0) {
		return 0;
	}
	return Math.floor(value);
}

/** A sync-since value is valid when blank (= install date) or a YYYY-MM-DD date. */
export function isValidSyncSince(input: string): boolean {
	const value = input.trim();
	if (value.length === 0) {
		return true;
	}
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
