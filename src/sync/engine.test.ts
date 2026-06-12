import { describe, expect, it } from "vitest";
import type { AiResult, MeetingDetail, MeetingSummary } from "../cli/types";
import { SyncEngine, inScope } from "./engine";
import { DEFAULT_SETTINGS, type CliClient, type Settings, type SyncStateData, type VaultIO } from "./types";
import { emptyState } from "./types";

function summary(overrides: Partial<MeetingSummary> & { id: string }): MeetingSummary {
	return {
		shortID: overrides.id.slice(0, 4).toUpperCase(),
		title: "Weekly Standup",
		status: "completed",
		createdAt: "2026-06-12T10:00:00Z",
		updatedAt: "2026-06-12T10:30:00Z",
		durationMs: 2820000,
		hasNotes: false,
		promptResultCount: 0,
		...overrides,
	};
}

function detail(overrides: Partial<MeetingDetail> & { id: string }): MeetingDetail {
	return {
		shortID: overrides.id.slice(0, 4).toUpperCase(),
		title: "Weekly Standup",
		status: "completed",
		createdAt: "2026-06-12T10:00:00Z",
		updatedAt: "2026-06-12T10:30:00Z",
		durationMs: 2820000,
		transcript: "Hello there.",
		userNotes: "",
		...overrides,
	};
}

function aiResult(overrides: Partial<AiResult> & { id: string }): AiResult {
	return {
		shortID: overrides.id.slice(0, 4).toUpperCase(),
		name: "Summary",
		content: "A summary.",
		promptContent: "Summarize.",
		createdAt: "2026-06-12T10:05:00Z",
		updatedAt: "2026-06-12T10:05:00Z",
		...overrides,
	};
}

class FakeVault implements VaultIO {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly writeLog: string[] = [];

	async folderExists(path: string): Promise<boolean> {
		return this.folders.has(path);
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
	async fileExists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
	async write(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		this.writeLog.push(path);
	}
}

class FakeCli implements CliClient {
	showCount = 0;
	resultsCount = 0;
	constructor(
		public meetings: MeetingSummary[],
		public details: Record<string, MeetingDetail>,
		public results: Record<string, AiResult[]>,
	) {}
	async listMeetings(): Promise<MeetingSummary[]> {
		return this.meetings;
	}
	async showMeeting(id: string): Promise<MeetingDetail> {
		this.showCount += 1;
		const found = this.details[id];
		if (!found) {
			throw new Error(`no detail for ${id}`);
		}
		return found;
	}
	async listResults(id: string): Promise<AiResult[]> {
		this.resultsCount += 1;
		return this.results[id] ?? [];
	}
}

function makeEngine(cli: CliClient, vault: VaultIO, state: SyncStateData, settings: Settings) {
	return new SyncEngine({
		cli,
		vault,
		getSettings: () => settings,
		getState: () => state,
		persist: async () => {},
	});
}

/** Default settings with a wide-open sync window so fixtures are in scope. */
function settings(overrides: Partial<Settings> = {}): Settings {
	return { ...DEFAULT_SETTINGS, syncSince: "2000-01-01", ...overrides };
}

const FOLDER = "MacParakeet/Meetings/2026/06 - June/1 - Weekly Standup";

describe("SyncEngine — new meeting", () => {
	it("creates the folder, index, and result files", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1", promptResultCount: 1 })],
			{ "m-1": detail({ id: "m-1" }) },
			{ "m-1": [aiResult({ id: "r-1" })] },
		);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");

		const result = await makeEngine(cli, vault, state, settings()).sync();

		expect(result).toEqual({ created: 1, updated: 0, unchanged: 0 });
		expect(vault.folders.has(FOLDER)).toBe(true);
		expect(vault.files.has(`${FOLDER}/1 - Weekly Standup.md`)).toBe(true);
		expect(vault.files.has(`${FOLDER}/Summary.md`)).toBe(true);
		expect(state.meetings["m-1"]?.n).toBe(1);
	});
});

describe("SyncEngine — classification matrix", () => {
	function setup() {
		const cli = new FakeCli(
			[summary({ id: "m-1", promptResultCount: 1 })],
			{ "m-1": detail({ id: "m-1" }) },
			{ "m-1": [aiResult({ id: "r-1" })] },
		);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");
		const engine = makeEngine(cli, vault, state, settings());
		return { cli, vault, state, engine };
	}

	it("skips an unchanged meeting with zero fetches and zero writes", async () => {
		const { cli, vault, engine } = setup();
		await engine.sync();
		vault.writeLog.length = 0;
		const showsAfterFirst = cli.showCount;

		const result = await engine.sync();

		expect(result).toEqual({ created: 0, updated: 0, unchanged: 1 });
		expect(vault.writeLog).toHaveLength(0);
		expect(cli.showCount).toBe(showsAfterFirst);
	});

	it("treats a bumped updatedAt as changed", async () => {
		const { cli, vault, engine } = setup();
		await engine.sync();
		vault.writeLog.length = 0;
		cli.meetings = [summary({ id: "m-1", promptResultCount: 1, updatedAt: "2026-06-12T11:00:00Z" })];
		cli.details["m-1"] = detail({ id: "m-1", updatedAt: "2026-06-12T11:00:00Z" });

		const result = await engine.sync();

		expect(result).toEqual({ created: 0, updated: 1, unchanged: 0 });
		expect(vault.writeLog.length).toBeGreaterThan(0);
	});

	it("adds only the new result file and refreshes the index when a result appears", async () => {
		const { cli, vault, engine } = setup();
		await engine.sync();
		vault.writeLog.length = 0;
		cli.meetings = [summary({ id: "m-1", promptResultCount: 2, updatedAt: "2026-06-12T11:00:00Z" })];
		cli.results["m-1"] = [
			aiResult({ id: "r-1", name: "Summary" }),
			aiResult({ id: "r-2", name: "Action Items", createdAt: "2026-06-12T10:09:00Z" }),
		];

		const result = await engine.sync();

		expect(result).toEqual({ created: 0, updated: 1, unchanged: 0 });
		expect(vault.writeLog.sort()).toEqual(
			[`${FOLDER}/Action Items.md`, `${FOLDER}/1 - Weekly Standup.md`].sort(),
		);
		expect(vault.files.get(`${FOLDER}/1 - Weekly Standup.md`)).toContain("[[Action Items]]");
	});
});

describe("SyncEngine — content toggles", () => {
	it("writes Notes.md and Transcript.md only when their toggles are on and content exists", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1", hasNotes: true })],
			{ "m-1": detail({ id: "m-1", userNotes: "Remember the demo.", transcript: "Full transcript." }) },
			{ "m-1": [] },
		);
		const vault = new FakeVault();

		await makeEngine(cli, vault, emptyState("2026-06-01"), settings({ syncTranscript: true })).sync();

		expect(vault.files.has(`${FOLDER}/Notes.md`)).toBe(true);
		expect(vault.files.has(`${FOLDER}/Transcript.md`)).toBe(true);
		expect(vault.files.get(`${FOLDER}/Notes.md`)).toContain("Remember the demo.");
	});

	it("does not write Notes.md when the meeting has no notes", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1" })],
			{ "m-1": detail({ id: "m-1", userNotes: "" }) },
			{ "m-1": [] },
		);
		const vault = new FakeVault();
		await makeEngine(cli, vault, emptyState("2026-06-01"), settings()).sync();
		expect(vault.files.has(`${FOLDER}/Notes.md`)).toBe(false);
	});

	it("does not retroactively backfill transcripts for unchanged meetings", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1" })],
			{ "m-1": detail({ id: "m-1", transcript: "Full transcript." }) },
			{ "m-1": [] },
		);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");
		const liveSettings = settings({ syncTranscript: false });
		const engine = new SyncEngine({
			cli,
			vault,
			getSettings: () => liveSettings,
			getState: () => state,
			persist: async () => {},
		});

		await engine.sync();
		expect(vault.files.has(`${FOLDER}/Transcript.md`)).toBe(false);

		// Toggle transcript on, but the meeting itself has not changed.
		liveSettings.syncTranscript = true;
		const result = await engine.sync();

		expect(result).toEqual({ created: 0, updated: 0, unchanged: 1 });
		expect(vault.files.has(`${FOLDER}/Transcript.md`)).toBe(false);

		// Once the meeting changes, the now-enabled transcript is written.
		cli.meetings = [summary({ id: "m-1", updatedAt: "2026-06-12T12:00:00Z" })];
		cli.details["m-1"] = detail({ id: "m-1", transcript: "Full transcript.", updatedAt: "2026-06-12T12:00:00Z" });
		await engine.sync();
		expect(vault.files.has(`${FOLDER}/Transcript.md`)).toBe(true);
	});
});

describe("SyncEngine — file ownership", () => {
	it("never writes a file the plugin did not create", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1", promptResultCount: 1 })],
			{ "m-1": detail({ id: "m-1" }) },
			{ "m-1": [aiResult({ id: "r-1" })] },
		);
		const vault = new FakeVault();
		const foreign = `${FOLDER}/My thoughts.md`;
		vault.files.set(foreign, "my private notes");
		const engine = makeEngine(cli, vault, emptyState("2026-06-01"), settings());

		await engine.sync();
		// A bumped meeting triggers a re-render; the foreign file is still untouched.
		cli.meetings = [summary({ id: "m-1", promptResultCount: 1, updatedAt: "2026-06-12T13:00:00Z" })];
		cli.details["m-1"] = detail({ id: "m-1", updatedAt: "2026-06-12T13:00:00Z" });
		await engine.sync({ force: true });

		expect(vault.writeLog).not.toContain(foreign);
		expect(vault.files.get(foreign)).toBe("my private notes");
	});
});

describe("SyncEngine — force re-sync", () => {
	it("overwrites content regenerated in place that the cheap diff misses", async () => {
		const cli = new FakeCli(
			[summary({ id: "m-1", promptResultCount: 1 })],
			{ "m-1": detail({ id: "m-1" }) },
			{ "m-1": [aiResult({ id: "r-1", content: "original" })] },
		);
		const vault = new FakeVault();
		const engine = makeEngine(cli, vault, emptyState("2026-06-01"), settings());

		await engine.sync();
		// Result content changes but updatedAt and count stay the same.
		cli.results["m-1"] = [aiResult({ id: "r-1", content: "regenerated" })];

		const normal = await engine.sync();
		expect(normal).toEqual({ created: 0, updated: 0, unchanged: 1 });
		expect(vault.files.get(`${FOLDER}/Summary.md`)).toContain("original");

		const forced = await engine.sync({ force: true });
		expect(forced).toEqual({ created: 0, updated: 1, unchanged: 0 });
		expect(vault.files.get(`${FOLDER}/Summary.md`)).toContain("regenerated");
	});
});

describe("SyncEngine — sync scope and numbering", () => {
	it("imports only completed meetings on/after the sync-since date", async () => {
		const cli = new FakeCli(
			[
				summary({ id: "old", createdAt: "2026-05-01T10:00:00Z" }),
				summary({ id: "recent", createdAt: "2026-06-10T10:00:00Z" }),
				summary({ id: "recording", createdAt: "2026-06-11T10:00:00Z", status: "recording" }),
			],
			{
				old: detail({ id: "old", createdAt: "2026-05-01T10:00:00Z" }),
				recent: detail({ id: "recent", createdAt: "2026-06-10T10:00:00Z" }),
			},
			{},
		);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");

		const result = await makeEngine(cli, vault, state, settings({ syncSince: "2026-06-01" })).sync();

		expect(result.created).toBe(1);
		expect(Object.keys(state.meetings)).toEqual(["recent"]);
	});

	it("numbers a multi-meeting backfill oldest-first within a month", async () => {
		const cli = new FakeCli(
			[
				summary({ id: "b", createdAt: "2026-06-20T10:00:00Z", title: "Later" }),
				summary({ id: "a", createdAt: "2026-06-05T10:00:00Z", title: "Earlier" }),
			],
			{
				a: detail({ id: "a", createdAt: "2026-06-05T10:00:00Z", title: "Earlier" }),
				b: detail({ id: "b", createdAt: "2026-06-20T10:00:00Z", title: "Later" }),
			},
			{},
		);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");

		await makeEngine(cli, vault, state, settings()).sync();

		expect(state.meetings["a"]?.n).toBe(1);
		expect(state.meetings["b"]?.n).toBe(2);
	});
});

describe("inScope", () => {
	it("keeps completed, on-or-after meetings sorted oldest first", () => {
		const meetings: MeetingSummary[] = [
			summary({ id: "new", createdAt: "2026-06-12T00:00:00Z" }),
			summary({ id: "old", createdAt: "2026-06-01T00:00:00Z" }),
			summary({ id: "before", createdAt: "2026-05-01T00:00:00Z" }),
			summary({ id: "recording", createdAt: "2026-06-20T00:00:00Z", status: "recording" }),
		];
		expect(inScope(meetings, "2026-06-01").map((m) => m.id)).toEqual(["old", "new"]);
	});

	it("compares against the calendar date, not the raw timestamp", () => {
		const meetings: MeetingSummary[] = [
			summary({ id: "same-day-early", createdAt: "2026-06-01T02:00:00Z" }),
			summary({ id: "day-before-late", createdAt: "2026-05-31T23:30:00Z" }),
		];
		expect(inScope(meetings, "2026-06-01").map((m) => m.id)).toEqual(["same-day-early"]);
	});
});
