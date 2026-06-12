import { describe, expect, it } from "vitest";
import { assignNumber, effectiveSyncSince, normalizeData } from "./state";
import { DEFAULT_SETTINGS, emptyState } from "./types";

describe("normalizeData", () => {
	it("fills defaults when data.json is empty", () => {
		const data = normalizeData(undefined, "2026-06-12");
		expect(data.settings).toEqual(DEFAULT_SETTINGS);
		expect(data.state).toEqual(emptyState("2026-06-12"));
	});

	it("preserves persisted settings and state across a round-trip", () => {
		const original = {
			settings: { ...DEFAULT_SETTINGS, baseFolder: "Notes", syncTranscript: true },
			state: {
				installDate: "2026-01-01",
				counters: { "2026/06": 3 },
				meetings: {
					"m-1": {
						folderPath: "Notes/Meetings/2026/06/2-Standup",
						n: 2,
						bucket: "2026/06",
						snapshot: { updatedAt: "2026-06-12T10:30:00Z", promptResultCount: 3 },
						files: { index: { path: "x.md", sourceUpdatedAt: "2026-06-12T10:30:00Z" } },
					},
				},
			},
		};
		const data = normalizeData(original, "2026-06-12");
		expect(data).toEqual(original);
	});

	it("ignores an unrelated installDate argument when state already has one", () => {
		const data = normalizeData({ state: { installDate: "2025-12-25" } }, "2026-06-12");
		expect(data.state.installDate).toBe("2025-12-25");
	});
});

describe("assignNumber", () => {
	it("assigns 1 then 2 within a fresh bucket and advances the counter", () => {
		const state = emptyState("2026-06-01");
		expect(assignNumber(state, "a", "2026/06")).toBe(1);
		expect(assignNumber(state, "b", "2026/06")).toBe(2);
		expect(state.counters["2026/06"]).toBe(3);
	});

	it("returns a meeting's frozen number without touching the counter", () => {
		const state = emptyState("2026-06-01");
		state.meetings["a"] = {
			folderPath: "x",
			n: 7,
			bucket: "2026/06",
			snapshot: { updatedAt: "", promptResultCount: 0 },
			files: {},
		};
		state.counters["2026/06"] = 9;
		expect(assignNumber(state, "a", "2026/06")).toBe(7);
		expect(state.counters["2026/06"]).toBe(9);
	});

	it("counts buckets independently", () => {
		const state = emptyState("2026-06-01");
		expect(assignNumber(state, "a", "2026/06")).toBe(1);
		expect(assignNumber(state, "b", "2026/07")).toBe(1);
	});

	it("gives a backfilled older meeting the next free number without renumbering the first", () => {
		const state = emptyState("2026-06-01");
		// A newer meeting is synced first and frozen at n=1.
		const newer = assignNumber(state, "newer", "2026/06");
		state.meetings["newer"] = {
			folderPath: `M/1-newer`,
			n: newer,
			bucket: "2026/06",
			snapshot: { updatedAt: "", promptResultCount: 0 },
			files: {},
		};
		// Later, an older meeting in the same month is backfilled -> next free number.
		expect(assignNumber(state, "older", "2026/06")).toBe(2);
		// Re-syncing the first meeting keeps its frozen number.
		expect(assignNumber(state, "newer", "2026/06")).toBe(1);
	});
});

describe("effectiveSyncSince", () => {
	it("uses the setting when present", () => {
		const state = emptyState("2026-06-01");
		expect(effectiveSyncSince({ ...DEFAULT_SETTINGS, syncSince: "2026-03-01" }, state)).toBe("2026-03-01");
	});

	it("falls back to the install date when the setting is blank", () => {
		const state = emptyState("2026-06-01");
		expect(effectiveSyncSince({ ...DEFAULT_SETTINGS, syncSince: "" }, state)).toBe("2026-06-01");
	});
});
