import { describe, expect, it } from "vitest";
import type { AiResult, MeetingDetail } from "../cli/types";
import { formatDuration, renderFrontmatter, renderMeeting } from "./renderer";

const MEETING: MeetingDetail = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	shortID: "550E8400",
	title: "Weekly Standup",
	status: "completed",
	createdAt: "2026-06-12T10:00:00Z",
	updatedAt: "2026-06-12T10:30:00Z",
	durationMs: 2820000,
	transcript: "Hello there.",
	userNotes: "",
};

function result(overrides: Partial<AiResult>): AiResult {
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

describe("renderMeeting", () => {
	it("renders an index note and one file per result", () => {
		const files = renderMeeting({
			meeting: MEETING,
			results: [result({ id: "a", name: "Summary", createdAt: "2026-06-12T10:05:00Z" })],
			n: 2,
			folderPath: "MacParakeet/Meetings/2026/06/2-Weekly Standup",
		});

		const index = files.find((file) => file.key === "index");
		const summary = files.find((file) => file.key === "result:a");
		expect(index?.path).toBe("MacParakeet/Meetings/2026/06/2-Weekly Standup/2-Weekly Standup.md");
		expect(summary?.path).toBe("MacParakeet/Meetings/2026/06/2-Weekly Standup/Summary.md");
		expect(index?.sourceUpdatedAt).toBe(MEETING.updatedAt);
		expect(summary?.sourceUpdatedAt).toBe("2026-06-12T10:05:00Z");
	});

	it("puts meeting frontmatter and a sibling link in the index", () => {
		const index = renderMeeting({
			meeting: MEETING,
			results: [result({ id: "a", name: "Summary" })],
			n: 2,
			folderPath: "MacParakeet/M",
		})[0];

		expect(index?.content).toContain("macparakeet-id: 550e8400-e29b-41d4-a716-446655440000");
		expect(index?.content).toContain("type: macparakeet-meeting");
		expect(index?.content).toContain("duration: 47m");
		expect(index?.content).toContain("# Weekly Standup");
		expect(index?.content).toContain("[[Summary]]");
	});

	it("disambiguates two results sharing a prompt name with a shortID suffix", () => {
		const files = renderMeeting({
			meeting: MEETING,
			results: [
				result({ id: "a", name: "Summary", shortID: "AAAA", createdAt: "2026-06-12T10:05:00Z" }),
				result({ id: "b", name: "Summary", shortID: "BBBB", createdAt: "2026-06-12T10:06:00Z" }),
			],
			n: 1,
			folderPath: "M",
		});

		const names = files
			.filter((file) => file.key.startsWith("result:"))
			.map((file) => file.path);
		expect(names).toContain("M/Summary.md");
		expect(names).toContain("M/Summary (BBBB).md");
	});

	it("names the index exactly after its folder, regardless of the template", () => {
		// A folder name that a length cap or custom template would not reproduce
		// from sanitizing `{n}-{title}` independently.
		const folderPath = "Archive/2026-06-12 Quarterly Review and Planning Q3 (very long)";
		const [index] = renderMeeting({ meeting: MEETING, results: [], n: 7, folderPath });
		expect(index?.key).toBe("index");
		expect(index?.path).toBe(`${folderPath}/2026-06-12 Quarterly Review and Planning Q3 (very long).md`);
	});

	it("emits only an index (with no links) when there are no results", () => {
		const files = renderMeeting({ meeting: MEETING, results: [], n: 1, folderPath: "M" });
		expect(files).toHaveLength(1);
		expect(files[0]?.key).toBe("index");
		expect(files[0]?.content).not.toContain("[[");
	});

	it("includes a result's content and result-id frontmatter", () => {
		const files = renderMeeting({
			meeting: MEETING,
			results: [result({ id: "a", name: "Action Items", content: "- do x" })],
			n: 1,
			folderPath: "M",
		});
		const action = files.find((file) => file.key === "result:a");
		expect(action?.content).toContain("result-id: a");
		expect(action?.content).toContain("# Action Items");
		expect(action?.content).toContain("- do x");
	});
});

describe("renderFrontmatter", () => {
	it("quotes values containing YAML-significant characters", () => {
		const block = renderFrontmatter({ prompt: "Notes: the plan #1", id: "x" });
		expect(block).toContain('prompt: "Notes: the plan #1"');
		expect(block).toContain("id: x");
	});
});

describe("formatDuration", () => {
	it("formats sub-hour durations in minutes", () => {
		expect(formatDuration(2820000)).toBe("47m");
	});

	it("formats multi-hour durations as hours and minutes", () => {
		expect(formatDuration(3 * 3600000 + 5 * 60000)).toBe("3h 5m");
	});

	it("drops the minutes when a duration is a whole number of hours", () => {
		expect(formatDuration(2 * 3600000)).toBe("2h");
	});
});
