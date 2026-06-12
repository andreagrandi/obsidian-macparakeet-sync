import { describe, expect, it } from "vitest";
import { bucketKey, dateParts, joinPath, renderTemplate, sanitizeTitle, uniqueName } from "./paths";
import { DEFAULT_SETTINGS } from "./types";

describe("sanitizeTitle", () => {
	it("replaces every character invalid in filenames or links with a dash", () => {
		expect(sanitizeTitle('a*b"c\\d/e<f>g:h|i?j#k^l[m]n')).toBe("a-b-c-d-e-f-g-h-i-j-k-l-m-n");
	});

	it("turns path separators into dashes so no stray folders are created", () => {
		expect(sanitizeTitle("Core sync/discovery")).toBe("Core sync-discovery");
		expect(sanitizeTitle("a\\b")).toBe("a-b");
	});

	it("collapses runs of whitespace to single spaces", () => {
		expect(sanitizeTitle("a   b\t c")).toBe("a b c");
	});

	it("trims leading and trailing dots and spaces", () => {
		expect(sanitizeTitle("  ..Weekly Standup..  ")).toBe("Weekly Standup");
	});

	it("caps the title at 60 characters", () => {
		const long = "x".repeat(100);
		expect(sanitizeTitle(long)).toHaveLength(60);
	});

	it("keeps emoji and CJK characters", () => {
		expect(sanitizeTitle("Launch 🎉 party")).toBe("Launch 🎉 party");
		expect(sanitizeTitle("会議メモ")).toBe("会議メモ");
	});

	it("falls back to Untitled Meeting when nothing survives", () => {
		expect(sanitizeTitle("   ")).toBe("Untitled Meeting");
		expect(sanitizeTitle("...")).toBe("Untitled Meeting");
		expect(sanitizeTitle("")).toBe("Untitled Meeting");
	});
});

describe("dateParts", () => {
	it("parses the date components from an ISO timestamp without timezone drift", () => {
		expect(dateParts("2026-06-09T23:30:00Z")).toEqual({
			year: "2026",
			month: "06",
			monthName: "June",
			day: "09",
			date: "2026-06-09",
		});
	});

	it("falls back to UTC parsing for a non-prefixed date string", () => {
		expect(dateParts("June 9, 2026 12:00:00 UTC")).toMatchObject({ year: "2026", month: "06", day: "09" });
	});

	it("yields zeroed parts for an unparseable timestamp", () => {
		expect(dateParts("not a date")).toEqual({
			year: "0000",
			month: "00",
			monthName: "",
			day: "00",
			date: "0000-00-00",
		});
	});
});

describe("renderTemplate", () => {
	it("resolves every supported token", () => {
		const out = renderTemplate(
			"{year}/{monthName} {day} ({date}) n{n} - {title}",
			{ createdAt: "2026-06-09T12:01:00Z", title: "Core sync/discovery" },
			3,
		);
		expect(out).toBe("2026/June 09 (2026-06-09) n3 - Core sync-discovery");
	});

	it("leaves unknown tokens untouched", () => {
		const out = renderTemplate("{year}/{foo}/{title}", { createdAt: "2026-06-09T12:01:00Z", title: "X" }, 1);
		expect(out).toBe("2026/{foo}/X");
	});

	it("zero-pads the month", () => {
		const out = renderTemplate("{month}", { createdAt: "2026-01-09T12:01:00Z", title: "X" }, 1);
		expect(out).toBe("01");
	});

	it("renders the default template as a spaced, number-and-name shape", () => {
		const out = renderTemplate(
			DEFAULT_SETTINGS.pathTemplate,
			{ createdAt: "2026-06-09T12:01:00Z", title: "Core sync/discovery" },
			1,
		);
		expect(out).toBe("Meetings/2026/06 - June/1 - Core sync-discovery");
	});
});

describe("bucketKey", () => {
	it("derives the year/month bucket from createdAt", () => {
		expect(bucketKey("2026-06-12T10:00:00Z")).toBe("2026/06");
	});
});

describe("joinPath", () => {
	it("joins segments and collapses stray slashes", () => {
		expect(joinPath("MacParakeet/", "/Meetings//2026/")).toBe("MacParakeet/Meetings/2026");
	});

	it("drops empty segments", () => {
		expect(joinPath("", "MacParakeet", "")).toBe("MacParakeet");
	});
});

describe("uniqueName", () => {
	it("returns the base name when there is no collision", () => {
		const used = new Set<string>();
		expect(uniqueName("Summary", "AAAA", used)).toBe("Summary");
	});

	it("suffixes the second occurrence with the disambiguator", () => {
		const used = new Set<string>();
		uniqueName("Summary", "AAAA", used);
		expect(uniqueName("Summary", "BBBB", used)).toBe("Summary (BBBB)");
	});

	it("keeps disambiguating a third identical name", () => {
		const used = new Set<string>();
		uniqueName("Summary", "AAAA", used);
		uniqueName("Summary", "BBBB", used);
		// A third "Summary" reusing an already-seen id still resolves to a fresh name.
		const third = uniqueName("Summary", "BBBB", used);
		expect(third).not.toBe("Summary");
		expect(third).not.toBe("Summary (BBBB)");
		expect(used.has(third)).toBe(true);
	});
});
