import { describe, expect, it } from "vitest";
import type { AiResult, MeetingDetail, MeetingSummary } from "../cli/types";
import { SyncEngine, mostRecentCompleted } from "./engine";
import { DEFAULT_SETTINGS, type CliClient, type Settings, type SyncStateData, type VaultIO } from "./types";
import { emptyState } from "./types";

const SUMMARY: MeetingSummary = {
	id: "m-1",
	shortID: "M1",
	title: "Weekly Standup",
	status: "completed",
	createdAt: "2026-06-12T10:00:00Z",
	updatedAt: "2026-06-12T10:30:00Z",
	durationMs: 2820000,
	hasNotes: false,
	promptResultCount: 1,
};

const DETAIL: MeetingDetail = {
	id: "m-1",
	shortID: "M1",
	title: "Weekly Standup",
	status: "completed",
	createdAt: "2026-06-12T10:00:00Z",
	updatedAt: "2026-06-12T10:30:00Z",
	durationMs: 2820000,
	transcript: "Hello.",
	userNotes: "",
};

function aiResult(overrides: Partial<AiResult>): AiResult {
	return {
		id: "r-1",
		shortID: "R1",
		name: "Summary",
		content: "A summary.",
		promptContent: "Summarize.",
		createdAt: "2026-06-12T10:05:00Z",
		updatedAt: "2026-06-12T10:05:00Z",
		...overrides,
	};
}

/** Records every write/createFolder so tests can assert exact I/O. */
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

/** CLI fake that counts detail/result fetches so we can prove skips do no I/O. */
class FakeCli implements CliClient {
	showCount = 0;
	resultsCount = 0;
	constructor(
		private meetings: MeetingSummary[],
		private detail: MeetingDetail,
		private results: AiResult[],
	) {}
	async listMeetings(): Promise<MeetingSummary[]> {
		return this.meetings;
	}
	async showMeeting(): Promise<MeetingDetail> {
		this.showCount += 1;
		return this.detail;
	}
	async listResults(): Promise<AiResult[]> {
		this.resultsCount += 1;
		return this.results;
	}
	setMeetings(meetings: MeetingSummary[]): void {
		this.meetings = meetings;
	}
	setResults(results: AiResult[]): void {
		this.results = results;
	}
}

function makeEngine(cli: CliClient, vault: VaultIO, state: SyncStateData, settings: Settings = DEFAULT_SETTINGS) {
	return new SyncEngine({
		cli,
		vault,
		getSettings: () => settings,
		getState: () => state,
		persist: async () => {},
	});
}

describe("SyncEngine (tracer scope)", () => {
	it("creates a folder, index, and result files for a new meeting", async () => {
		const cli = new FakeCli([SUMMARY], DETAIL, [aiResult({ id: "r-1" })]);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");

		const summary = await makeEngine(cli, vault, state).sync();

		expect(summary).toEqual({ created: 1, updated: 0, unchanged: 0 });
		const folder = "MacParakeet/Meetings/2026/06/1-Weekly Standup";
		expect(vault.folders.has(folder)).toBe(true);
		expect(vault.files.has(`${folder}/1-Weekly Standup.md`)).toBe(true);
		expect(vault.files.has(`${folder}/Summary.md`)).toBe(true);
		expect(state.meetings["m-1"]?.n).toBe(1);
		expect(state.counters["2026/06"]).toBe(2);
	});

	it("skips an unchanged meeting with zero fetches and zero writes", async () => {
		const cli = new FakeCli([SUMMARY], DETAIL, [aiResult({ id: "r-1" })]);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");
		const engine = makeEngine(cli, vault, state);

		await engine.sync();
		vault.writeLog.length = 0;
		const showCountAfterFirst = cli.showCount;

		const second = await engine.sync();

		expect(second).toEqual({ created: 0, updated: 0, unchanged: 1 });
		expect(vault.writeLog).toHaveLength(0);
		expect(cli.showCount).toBe(showCountAfterFirst);
	});

	it("adds only the new result file and refreshes the index when a result appears", async () => {
		const cli = new FakeCli([SUMMARY], DETAIL, [aiResult({ id: "r-1", name: "Summary" })]);
		const vault = new FakeVault();
		const state = emptyState("2026-06-01");
		const engine = makeEngine(cli, vault, state);

		await engine.sync();

		// A second result arrives: count grows, meeting updatedAt bumps.
		cli.setResults([
			aiResult({ id: "r-1", name: "Summary", createdAt: "2026-06-12T10:05:00Z" }),
			aiResult({ id: "r-2", name: "Action Items", createdAt: "2026-06-12T10:09:00Z" }),
		]);
		cli.setMeetings([{ ...SUMMARY, updatedAt: "2026-06-12T10:40:00Z", promptResultCount: 2 }]);
		vault.writeLog.length = 0;

		const summary = await engine.sync();

		const folder = "MacParakeet/Meetings/2026/06/1-Weekly Standup";
		expect(summary).toEqual({ created: 0, updated: 1, unchanged: 0 });
		expect(vault.files.has(`${folder}/Action Items.md`)).toBe(true);
		// Wrote exactly the new result and the refreshed index; not the unchanged Summary.
		expect(vault.writeLog.sort()).toEqual(
			[`${folder}/Action Items.md`, `${folder}/1-Weekly Standup.md`].sort(),
		);
		const index = vault.files.get(`${folder}/1-Weekly Standup.md`);
		expect(index).toContain("[[Action Items]]");
	});

	it("does nothing when there are no completed meetings", async () => {
		const cli = new FakeCli([{ ...SUMMARY, status: "recording" }], DETAIL, []);
		const vault = new FakeVault();
		const summary = await makeEngine(cli, vault, emptyState("2026-06-01")).sync();
		expect(summary).toEqual({ created: 0, updated: 0, unchanged: 0 });
		expect(vault.writeLog).toHaveLength(0);
	});
});

describe("mostRecentCompleted", () => {
	it("returns the completed meeting with the latest createdAt", () => {
		const meetings: MeetingSummary[] = [
			{ ...SUMMARY, id: "old", createdAt: "2026-06-01T00:00:00Z" },
			{ ...SUMMARY, id: "new", createdAt: "2026-06-12T00:00:00Z" },
			{ ...SUMMARY, id: "newest-but-recording", status: "recording", createdAt: "2026-06-20T00:00:00Z" },
		];
		expect(mostRecentCompleted(meetings)?.id).toBe("new");
	});

	it("returns null when nothing is completed", () => {
		expect(mostRecentCompleted([{ ...SUMMARY, status: "recording" }])).toBeNull();
	});
});
