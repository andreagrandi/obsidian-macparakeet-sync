/**
 * SyncEngine: orchestrate one sync run. For #3 this is scoped to the single
 * most recent completed meeting; #5 widens it to all in-scope meetings.
 */

import type { MeetingSummary } from "../cli/types";
import { joinPath, bucketKey, renderTemplate } from "./paths";
import { renderMeeting } from "./renderer";
import { assignNumber } from "./state";
import type {
	CliClient,
	MeetingRecord,
	Settings,
	SyncStateData,
	SyncSummary,
	VaultIO,
} from "./types";

type Outcome = "created" | "updated" | "unchanged";

export interface SyncEngineDeps {
	cli: CliClient;
	vault: VaultIO;
	getSettings: () => Settings;
	getState: () => SyncStateData;
	persist: () => Promise<void>;
}

export class SyncEngine {
	private readonly cli: CliClient;
	private readonly vault: VaultIO;
	private readonly getSettings: () => Settings;
	private readonly getState: () => SyncStateData;
	private readonly persist: () => Promise<void>;

	constructor(deps: SyncEngineDeps) {
		this.cli = deps.cli;
		this.vault = deps.vault;
		this.getSettings = deps.getSettings;
		this.getState = deps.getState;
		this.persist = deps.persist;
	}

	/** Sync the single most recent completed meeting (tracer scope, #3). */
	async sync(): Promise<SyncSummary> {
		const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0 };
		const meetings = await this.cli.listMeetings();
		const target = mostRecentCompleted(meetings);
		if (!target) {
			return summary;
		}
		const outcome = await this.processMeeting(target);
		tally(summary, outcome);
		await this.persist();
		return summary;
	}

	/** Classify one meeting, fetch + render only when it is new or changed. */
	private async processMeeting(meeting: MeetingSummary): Promise<Outcome> {
		const state = this.getState();
		const settings = this.getSettings();
		const record = state.meetings[meeting.id];

		if (record && isUnchanged(record, meeting)) {
			return "unchanged";
		}

		const isNew = !record;
		const detail = await this.cli.showMeeting(meeting.id);
		const results = settings.syncResults ? await this.cli.listResults(meeting.id) : [];

		const bucket = record?.bucket ?? bucketKey(meeting.createdAt);
		const n = assignNumber(state, meeting.id, bucket);
		const folderPath =
			record?.folderPath ?? joinPath(settings.baseFolder, renderTemplate(settings.pathTemplate, detail, n));

		const current: MeetingRecord = record ?? {
			folderPath,
			n,
			bucket,
			snapshot: { updatedAt: "", promptResultCount: -1 },
			files: {},
		};

		if (isNew) {
			await this.vault.createFolder(folderPath);
		}

		const rendered = renderMeeting({ meeting: detail, results, n, folderPath });
		const index = rendered.find((file) => file.key === "index");
		const artifacts = rendered.filter((file) => file.key !== "index");

		let wrote = 0;
		for (const file of artifacts) {
			const existing = current.files[file.key];
			const stale = !existing || existing.sourceUpdatedAt !== file.sourceUpdatedAt || existing.path !== file.path;
			if (stale) {
				await this.vault.write(file.path, file.content);
				current.files[file.key] = { path: file.path, sourceUpdatedAt: file.sourceUpdatedAt };
				wrote += 1;
			}
		}

		if (index) {
			const existing = current.files.index;
			const stale = !existing || existing.sourceUpdatedAt !== index.sourceUpdatedAt || existing.path !== index.path;
			if (isNew || wrote > 0 || stale) {
				await this.vault.write(index.path, index.content);
				current.files.index = { path: index.path, sourceUpdatedAt: index.sourceUpdatedAt };
			}
		}

		current.snapshot = { updatedAt: meeting.updatedAt, promptResultCount: meeting.promptResultCount };
		state.meetings[meeting.id] = current;
		return isNew ? "created" : "updated";
	}
}

/** A known meeting is unchanged when both snapshot fields still match. */
export function isUnchanged(record: MeetingRecord, meeting: MeetingSummary): boolean {
	return (
		record.snapshot.updatedAt === meeting.updatedAt &&
		record.snapshot.promptResultCount === meeting.promptResultCount
	);
}

/** The most recent completed meeting by createdAt, or null if there are none. */
export function mostRecentCompleted(meetings: MeetingSummary[]): MeetingSummary | null {
	const completed = meetings.filter((meeting) => meeting.status === "completed");
	if (completed.length === 0) {
		return null;
	}
	return completed.reduce((latest, meeting) =>
		meeting.createdAt > latest.createdAt ? meeting : latest,
	);
}

function tally(summary: SyncSummary, outcome: Outcome): void {
	if (outcome === "created") {
		summary.created += 1;
	} else if (outcome === "updated") {
		summary.updated += 1;
	} else {
		summary.unchanged += 1;
	}
}
