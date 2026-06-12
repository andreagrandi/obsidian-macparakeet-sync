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
}

/** Render the index note plus one file per AI result for a meeting. */
export function renderMeeting(input: RenderInput): RenderedFile[] {
	const { meeting, n, folderPath } = input;
	const results = sortResults(input.results);

	const resultFiles = renderResults(meeting, results, folderPath);
	const links = resultFiles.map((file) => basename(file.path));

	const indexName = sanitizeTitle(`${n}-${meeting.title}`);
	const index: RenderedFile = {
		key: "index",
		path: `${folderPath}/${indexName}.md`,
		content: renderIndex(meeting, links),
		sourceUpdatedAt: meeting.updatedAt,
	};

	return [index, ...resultFiles];
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

function renderIndex(meeting: MeetingDetail, links: string[]): string {
	const frontmatter: Record<string, string> = {
		"macparakeet-id": meeting.id,
		type: "macparakeet-meeting",
		date: meeting.createdAt,
		duration: formatDuration(meeting.durationMs),
	};
	if (meeting.engine) {
		frontmatter.engine = meeting.engine;
	}

	const body = [`# ${meeting.title}`];
	if (links.length > 0) {
		body.push("", links.map((target) => `[[${target}]]`).join(" · "));
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
