/**
 * NoteRenderer: turn a meeting + its AI results into markdown files.
 * Produces full vault paths and content; the engine decides what to write.
 */

import type { AiResult, MeetingDetail } from "../cli/types";
import { sanitizeTitle, uniqueName } from "./paths";

/** One file the renderer wants written, with the source timestamp it mirrors. */
export interface RenderedFile {
	/** State key: "index", "transcript", "notes", or "result:<result-id>". */
	key: string;
	path: string;
	content: string;
	sourceUpdatedAt: string;
}

export interface RenderInput {
	meeting: MeetingDetail;
	results: AiResult[];
	n: number;
	folderPath: string;
	includeNotes?: boolean;
	includeTranscript?: boolean;
}

/** The artifact links shown in the index, grouped by kind. */
interface IndexLinks {
	results: string[];
	notes?: string;
	transcript?: string;
}

/** Render the index note plus the enabled artifact files for a meeting. */
export function renderMeeting(input: RenderInput): RenderedFile[] {
	const { meeting, n, folderPath } = input;
	const results = sortResults(input.results);

	const resultFiles = renderResults(meeting, results, folderPath);
	const notesFile =
		input.includeNotes && meeting.userNotes.trim().length > 0
			? renderNotesFile(meeting, folderPath)
			: null;
	const transcriptFile =
		input.includeTranscript && meeting.transcript.trim().length > 0
			? renderTranscriptFile(meeting, folderPath)
			: null;

	const links: IndexLinks = {
		results: resultFiles.map((file) => basename(file.path)),
		notes: notesFile ? basename(notesFile.path) : undefined,
		transcript: transcriptFile ? basename(transcriptFile.path) : undefined,
	};

	// The folder note must be named exactly like its folder for folder-note
	// plugin compatibility (PLAN §7) — derive it from the folder, never re-sanitize
	// the title independently (which would diverge under length caps or custom
	// templates that don't place {title} last).
	const indexName = folderPath.slice(folderPath.lastIndexOf("/") + 1);
	const index: RenderedFile = {
		key: "index",
		path: `${folderPath}/${indexName}.md`,
		content: renderIndex(meeting, links),
		sourceUpdatedAt: meeting.updatedAt,
	};

	const artifacts = [notesFile, transcriptFile].filter((file): file is RenderedFile => file !== null);
	return [index, ...resultFiles, ...artifacts];
}

function renderNotesFile(meeting: MeetingDetail, folderPath: string): RenderedFile {
	const frontmatter = { "macparakeet-id": meeting.id, type: "macparakeet-notes" };
	return {
		key: "notes",
		path: `${folderPath}/Notes.md`,
		content: `${renderFrontmatter(frontmatter)}\n# Notes\n\n${meeting.userNotes.trim()}\n`,
		sourceUpdatedAt: meeting.updatedAt,
	};
}

function renderTranscriptFile(meeting: MeetingDetail, folderPath: string): RenderedFile {
	const frontmatter = { "macparakeet-id": meeting.id, type: "macparakeet-transcript" };
	return {
		key: "transcript",
		path: `${folderPath}/Transcript.md`,
		content: `${renderFrontmatter(frontmatter)}\n# Transcript\n\n${meeting.transcript.trim()}\n`,
		sourceUpdatedAt: meeting.updatedAt,
	};
}

/** Render one file per result, disambiguating duplicate prompt names. */
export function renderResults(
	meeting: MeetingDetail,
	results: AiResult[],
	folderPath: string,
): RenderedFile[] {
	const used = new Set<string>();
	return sortResults(results).map((result) => {
		const fileName = uniqueResultName(result, used);
		return {
			key: `result:${result.id}`,
			path: `${folderPath}/${fileName}.md`,
			content: renderResult(meeting, result),
			sourceUpdatedAt: result.updatedAt,
		};
	});
}

/** Sanitized prompt name, with a " (shortID)" suffix on a collision. */
function uniqueResultName(result: AiResult, used: Set<string>): string {
	return uniqueName(sanitizeTitle(result.name), result.shortID || result.id, used);
}

/** Stable order (oldest first, then id) so file naming never churns across syncs. */
function sortResults(results: AiResult[]): AiResult[] {
	return [...results].sort((a, b) => {
		if (a.createdAt !== b.createdAt) {
			return a.createdAt < b.createdAt ? -1 : 1;
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

function renderIndex(meeting: MeetingDetail, links: IndexLinks): string {
	const frontmatter: Record<string, string> = {
		"macparakeet-id": meeting.id,
		type: "macparakeet-meeting",
		date: meeting.createdAt,
		duration: formatDuration(meeting.durationMs),
	};
	if (meeting.engine) {
		frontmatter.engine = meeting.engine;
	}

	const bullets: string[] = [];
	if (links.results.length > 0) {
		bullets.push(`- ${links.results.map((target) => `[[${target}]]`).join(" · ")}`);
	}
	if (links.notes) {
		bullets.push(`- [[${links.notes}]]`);
	}
	if (links.transcript) {
		bullets.push(`- [[${links.transcript}]]`);
	}

	const body = [`# ${meeting.title}`];
	if (bullets.length > 0) {
		body.push("", ...bullets);
	}
	return `${renderFrontmatter(frontmatter)}\n${body.join("\n")}\n`;
}

function renderResult(meeting: MeetingDetail, result: AiResult): string {
	const frontmatter = {
		"macparakeet-id": meeting.id,
		"result-id": result.id,
		prompt: result.name,
		generated: result.createdAt,
	};
	return `${renderFrontmatter(frontmatter)}\n# ${result.name}\n\n${result.content.trim()}\n`;
}

/** Render a YAML frontmatter block, quoting values that need it. */
export function renderFrontmatter(fields: Record<string, string>): string {
	const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`);
	return `---\n${lines.join("\n")}\n---\n`;
}

/** A YAML-safe scalar: raw when plainly safe, otherwise a quoted/escaped string. */
function yamlValue(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(value)) {
		return value;
	}
	return JSON.stringify(value);
}

/** Human duration like "51m" or "1h 23m". */
export function formatDuration(durationMs: number): string {
	const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function basename(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	return file.endsWith(".md") ? file.slice(0, -3) : file;
}
