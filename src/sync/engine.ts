/**
 * SyncEngine: orchestrate one sync run over every in-scope meeting, with
 * new/changed/skip classification, mirror updates, and strict file ownership.
 */

import type { MeetingSummary } from "../cli/types";
import { joinPath, bucketKey, dateParts, renderTemplate } from "./paths";
import { renderMeeting } from "./renderer";
import { assignNumber, buildSourceIndex, effectiveSyncSince, findBySource, intervalFromDuration } from "./state";
import type {
	CliClient,
	MeetingRecord,
	Settings,
	SyncOptions,
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

	/** Sync every completed meeting created on/after the sync-since date. */
	async sync(options: SyncOptions = {}): Promise<SyncSummary> {
		const force = options.force ?? false;
		const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0 };

		const state = this.getState();
		const sourceIndex = buildSourceIndex(state);
		const meetings = inScope(await this.cli.listMeetings(), this.syncSince());
		for (const meeting of meetings) {
			tally(summary, await this.processMeeting(meeting, force, sourceIndex));
		}

		await this.persist();
		return summary;
	}

	private syncSince(): string {
		return effectiveSyncSince(this.getSettings(), this.getState());
	}

	/** Classify one meeting, fetch + render only when new, changed, or forced. */
	private async processMeeting(
		meeting: MeetingSummary,
		force: boolean,
		sourceIndex: Map<string, string>,
	): Promise<Outcome> {
		const state = this.getState();
		const settings = this.getSettings();
		const recordKey = findBySource(sourceIndex, "macparakeet", meeting.id) ?? meeting.id;
		const record = state.meetings[recordKey];

		if (record && !force && isUnchanged(record, meeting)) {
			// Lazily upgrade a legacy record to the v2 canonical interval; this is a
			// state-only change (no vault writes), so an upgraded sync stays a no-op.
			if (!record.interval) {
				record.interval = intervalFromDuration(meeting.createdAt, meeting.durationMs);
			}
			return "unchanged";
		}

		const isNew = !record;
		const detail = await this.cli.showMeeting(meeting.id);
		const results = settings.syncResults ? await this.cli.listResults(meeting.id) : [];

		const bucket = record?.bucket ?? bucketKey(meeting.createdAt);
		const n = assignNumber(state, recordKey, bucket);
		const folderPath =
			record?.folderPath ?? joinPath(settings.baseFolder, renderTemplate(settings.pathTemplate, detail, n));

		const current: MeetingRecord = record ?? {
			folderPath,
			n,
			bucket,
			sources: {},
			files: {},
		};

		if (isNew) {
			await this.vault.createFolder(folderPath);
		}

		const rendered = renderMeeting({
			meeting: detail,
			results,
			n,
			folderPath,
			includeNotes: settings.syncNotes,
			includeTranscript: settings.syncTranscript,
		});
		const index = rendered.find((file) => file.key === "index");
		const artifacts = rendered.filter((file) => file.key !== "index");

		let wrote = 0;
		for (const file of artifacts) {
			const existing = current.files[file.key];
			const stale =
				force ||
				!existing ||
				existing.sourceUpdatedAt !== file.sourceUpdatedAt ||
				existing.path !== file.path;
			if (stale) {
				await this.vault.write(file.path, file.content);
				current.files[file.key] = { path: file.path, sourceUpdatedAt: file.sourceUpdatedAt };
				wrote += 1;
			}
		}

		if (index) {
			const existing = current.files.index;
			const indexStale =
				force ||
				!existing ||
				existing.sourceUpdatedAt !== index.sourceUpdatedAt ||
				existing.path !== index.path;
			if (isNew || wrote > 0 || indexStale) {
				await this.vault.write(index.path, index.content);
				current.files.index = { path: index.path, sourceUpdatedAt: index.sourceUpdatedAt };
				wrote += 1;
			}
		}

		current.sources.macparakeet = {
			id: meeting.id,
			snapshot: { updatedAt: meeting.updatedAt, promptResultCount: meeting.promptResultCount },
		};
		if (!current.interval) {
			current.interval = intervalFromDuration(meeting.createdAt, meeting.durationMs);
		}
		state.meetings[recordKey] = current;

		if (isNew) {
			return "created";
		}
		return wrote > 0 ? "updated" : "unchanged";
	}
}

/** A known meeting is unchanged when its MacParakeet snapshot fields still match. */
export function isUnchanged(record: MeetingRecord, meeting: MeetingSummary): boolean {
	const snapshot = record.sources.macparakeet?.snapshot;
	return (
		snapshot !== undefined &&
		snapshot.updatedAt === meeting.updatedAt &&
		snapshot.promptResultCount === meeting.promptResultCount
	);
}

/**
 * Completed meetings created on/after `since`, oldest first for stable
 * numbering. `since` is a calendar date (YYYY-MM-DD), so compare it against the
 * meeting's UTC date rather than its full timestamp to keep the boundary crisp.
 */
export function inScope(meetings: MeetingSummary[], since: string): MeetingSummary[] {
	return meetings
		.filter((meeting) => meeting.status === "completed" && dateParts(meeting.createdAt).date >= since)
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
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
