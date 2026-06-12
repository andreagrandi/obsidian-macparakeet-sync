/**
 * Path planning: turn a meeting + frozen number into sanitized vault paths.
 * Pure logic, no Obsidian or filesystem access.
 */

const MAX_TITLE_LENGTH = 60;
/** Characters invalid in Obsidian filenames or wiki-links (PLAN §7). */
const INVALID_CHARS = /[*"\\/<>:|?#^[\]]/g;

/** Date components resolved from a meeting's ISO createdAt, in UTC. */
export interface DateParts {
	year: string;
	month: string;
	day: string;
	date: string;
}

/** Parse the YYYY-MM-DD portion of an ISO timestamp without timezone drift. */
export function dateParts(createdAt: string): DateParts {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt);
	if (match) {
		const [, year = "", month = "", day = ""] = match;
		return { year, month, day, date: `${year}-${month}-${day}` };
	}
	const parsed = new Date(createdAt);
	if (Number.isNaN(parsed.getTime())) {
		return { year: "0000", month: "00", day: "00", date: "0000-00-00" };
	}
	const year = String(parsed.getUTCFullYear()).padStart(4, "0");
	const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
	const day = String(parsed.getUTCDate()).padStart(2, "0");
	return { year, month, day, date: `${year}-${month}-${day}` };
}

/** The "{year}/{month}" bucket a meeting's number is counted within. */
export function bucketKey(createdAt: string): string {
	const { year, month } = dateParts(createdAt);
	return `${year}/${month}`;
}

/** Sanitize a title for use as a folder/file name (PLAN §7). */
export function sanitizeTitle(raw: string): string {
	let title = (raw ?? "").replace(INVALID_CHARS, "-").replace(/\s+/g, " ").trim();
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trim();
	}
	title = title.replace(/^[.\s]+|[.\s]+$/g, "");
	return title.length > 0 ? title : "Untitled Meeting";
}

/** Join path segments, trimming stray slashes and collapsing duplicates. */
export function joinPath(...parts: string[]): string {
	return parts
		.map((part) => part.replace(/^\/+|\/+$/g, ""))
		.filter((part) => part.length > 0)
		.join("/")
		.replace(/\/{2,}/g, "/");
}

/** Render a path template against a meeting (basic token set; extended in #4). */
export function renderTemplate(
	template: string,
	meeting: { createdAt: string; title: string },
	n: number,
): string {
	const { year, month } = dateParts(meeting.createdAt);
	const title = sanitizeTitle(meeting.title);
	return template
		.replaceAll("{year}", year)
		.replaceAll("{month}", month)
		.replaceAll("{n}", String(n))
		.replaceAll("{title}", title);
}
