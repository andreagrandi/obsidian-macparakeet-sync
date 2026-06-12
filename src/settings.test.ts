import { describe, expect, it } from "vitest";
import { cleanBaseFolder, cleanInterval, isValidSyncSince, isValidTemplate } from "./settings";

describe("cleanBaseFolder", () => {
	it("trims whitespace and strips leading/trailing slashes", () => {
		expect(cleanBaseFolder("  /Notes/MacParakeet/  ")).toBe("Notes/MacParakeet");
	});

	it("collapses duplicate slashes", () => {
		expect(cleanBaseFolder("a//b///c")).toBe("a/b/c");
	});

	it("falls back to the default when empty", () => {
		expect(cleanBaseFolder("   ")).toBe("MacParakeet");
		expect(cleanBaseFolder("///")).toBe("MacParakeet");
	});
});

describe("isValidTemplate", () => {
	it("accepts a non-empty template", () => {
		expect(isValidTemplate("Meetings/{n}-{title}")).toBe(true);
	});

	it("rejects an empty or whitespace-only template", () => {
		expect(isValidTemplate("")).toBe(false);
		expect(isValidTemplate("   ")).toBe(false);
	});
});

describe("cleanInterval", () => {
	it("parses a positive integer", () => {
		expect(cleanInterval("30")).toBe(30);
		expect(cleanInterval(45)).toBe(45);
	});

	it("treats 0 as off", () => {
		expect(cleanInterval("0")).toBe(0);
	});

	it("floors fractional values", () => {
		expect(cleanInterval("12.9")).toBe(12);
	});

	it("coerces negatives and non-numbers to 0", () => {
		expect(cleanInterval("-5")).toBe(0);
		expect(cleanInterval("abc")).toBe(0);
		expect(cleanInterval("")).toBe(0);
	});
});

describe("isValidSyncSince", () => {
	it("accepts an empty value (meaning the install date)", () => {
		expect(isValidSyncSince("")).toBe(true);
		expect(isValidSyncSince("   ")).toBe(true);
	});

	it("accepts a real YYYY-MM-DD date", () => {
		expect(isValidSyncSince("2026-06-12")).toBe(true);
	});

	it("rejects a malformed or impossible date", () => {
		expect(isValidSyncSince("2026/06/12")).toBe(false);
		expect(isValidSyncSince("12-06-2026")).toBe(false);
		expect(isValidSyncSince("2026-13-40")).toBe(false);
		expect(isValidSyncSince("garbage")).toBe(false);
	});
});
