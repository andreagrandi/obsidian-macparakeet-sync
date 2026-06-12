/**
 * Plugin data (settings + sync state) normalization and number assignment.
 * Numbering is frozen: a meeting's n is assigned once and never reassigned.
 */

import {
	DEFAULT_SETTINGS,
	type MeetingRecord,
	type PluginData,
	type Settings,
	type SyncStateData,
	emptyState,
} from "./types";

/** Merge persisted (possibly partial) data with defaults into a full PluginData. */
export function normalizeData(raw: unknown, installDate: string): PluginData {
	const obj = isRecord(raw) ? raw : {};
	const settings = normalizeSettings(obj.settings);
	const state = normalizeState(obj.state, installDate);
	return { settings, state };
}

function normalizeSettings(raw: unknown): Settings {
	const obj = isRecord(raw) ? raw : {};
	return {
		cliPath: asString(obj.cliPath, DEFAULT_SETTINGS.cliPath),
		baseFolder: asString(obj.baseFolder, DEFAULT_SETTINGS.baseFolder),
		pathTemplate: asString(obj.pathTemplate, DEFAULT_SETTINGS.pathTemplate),
		syncSince: asString(obj.syncSince, DEFAULT_SETTINGS.syncSince),
		syncResults: asBool(obj.syncResults, DEFAULT_SETTINGS.syncResults),
		syncNotes: asBool(obj.syncNotes, DEFAULT_SETTINGS.syncNotes),
		syncTranscript: asBool(obj.syncTranscript, DEFAULT_SETTINGS.syncTranscript),
		syncIntervalMinutes: asNumber(obj.syncIntervalMinutes, DEFAULT_SETTINGS.syncIntervalMinutes),
		syncOnLaunch: asBool(obj.syncOnLaunch, DEFAULT_SETTINGS.syncOnLaunch),
	};
}

function normalizeState(raw: unknown, installDate: string): SyncStateData {
	if (!isRecord(raw)) {
		return emptyState(installDate);
	}
	return {
		installDate: asString(raw.installDate, installDate),
		counters: isRecord(raw.counters) ? (raw.counters as Record<string, number>) : {},
		meetings: isRecord(raw.meetings) ? (raw.meetings as Record<string, MeetingRecord>) : {},
	};
}

/**
 * Return the frozen number for a meeting, assigning the next free one in its
 * bucket on first sight. Mutates `state.counters` only when assigning.
 */
export function assignNumber(state: SyncStateData, meetingId: string, bucket: string): number {
	const existing = state.meetings[meetingId];
	if (existing) {
		return existing.n;
	}
	const next = state.counters[bucket] ?? 1;
	state.counters[bucket] = next + 1;
	return next;
}

/** The date (YYYY-MM-DD) below which meetings are out of scope. */
export function effectiveSyncSince(settings: Settings, state: SyncStateData): string {
	return settings.syncSince.trim() || state.installDate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
