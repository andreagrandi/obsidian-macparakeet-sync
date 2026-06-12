import { describe, expect, it } from "vitest";
import { bucketKey, joinPath, renderTemplate, sanitizeTitle } from "./paths";

describe("sanitizeTitle", () => {
	it("replaces characters invalid in filenames or links", () => {
		expect(sanitizeTitle("Andrea / James: 1-1")).toBe("Andrea - James- 1-1");
	});

	it("falls back to Untitled Meeting for an empty result", () => {
		expect(sanitizeTitle("   ")).toBe("Untitled Meeting");
	});
});

describe("renderTemplate", () => {
	it("substitutes year, month, n, and a sanitized title", () => {
		const path = renderTemplate(
			"Meetings/{year}/{month}/{n}-{title}",
			{ createdAt: "2026-06-12T10:00:00Z", title: "Weekly Standup" },
			2,
		);
		expect(path).toBe("Meetings/2026/06/2-Weekly Standup");
	});
});

describe("bucketKey", () => {
	it("derives the year/month bucket from createdAt", () => {
		expect(bucketKey("2026-06-12T10:00:00Z")).toBe("2026/06");
	});
});

describe("joinPath", () => {
	it("joins segments and collapses stray slashes", () => {
		expect(joinPath("MacParakeet/", "/Meetings/2026")).toBe("MacParakeet/Meetings/2026");
	});
});
