/**
 * Shared types for the macparakeet-cli bridge: command results, typed errors,
 * and the JSON shapes the plugin depends on.
 */

/** A single meeting as returned by `meetings list --json`. */
export interface MeetingSummary {
	id: string;
	shortID: string;
	title: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	durationMs: number;
	hasNotes: boolean;
	promptResultCount: number;
}

/** A meeting's details from `meetings show <id> --json`. */
export interface MeetingDetail {
	id: string;
	shortID: string;
	title: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	durationMs: number;
	/** Clean transcript, falling back to the raw transcript when absent. */
	transcript: string;
	/** The user's typed meeting notes; empty string when there are none. */
	userNotes: string;
	/** Speech engine, when the CLI reports it (not always present). */
	engine?: string;
}

/** A single AI prompt result from `meetings results list <id> --json`. */
export interface AiResult {
	id: string;
	shortID: string;
	name: string;
	content: string;
	promptContent: string;
	createdAt: string;
	updatedAt: string;
}

/** Parsed `health --json` output; only the database block is load-bearing. */
export interface HealthResult {
	database?: {
		status?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Outcome of spawning the CLI once; the process started unless `spawnError` is set. */
export interface CliRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	/** Set when the process could not be spawned at all (e.g. "ENOENT"). */
	spawnError?: string;
}

/** Spawns macparakeet-cli once; never rejects for ordinary non-zero exits. */
export type CommandRunner = (
	binPath: string,
	args: string[],
	options: { timeoutMs: number },
) => Promise<CliRunResult>;

export type CliErrorKind =
	| "not-found"
	| "spawn"
	| "timeout"
	| "exit"
	| "envelope"
	| "parse";

/** Typed failure from the CLI bridge; `kind` drives user-facing messaging. */
export class CliError extends Error {
	readonly kind: CliErrorKind;
	readonly errorType?: string;
	readonly code?: number | null;

	constructor(
		kind: CliErrorKind,
		message: string,
		extra?: { errorType?: string; code?: number | null },
	) {
		super(message);
		this.name = "CliError";
		this.kind = kind;
		this.errorType = extra?.errorType;
		this.code = extra?.code;
	}
}
