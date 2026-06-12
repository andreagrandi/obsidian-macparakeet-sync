import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { existsSync } from "node:fs";
import { CliBridge, CliError, nodeCommandRunner } from "./cli";
import { SyncEngine } from "./sync";
import { normalizeData } from "./sync";
import type { PluginData, SyncSummary, VaultIO } from "./sync";

export default class MacParakeetSyncPlugin extends Plugin {
	private cli!: CliBridge;
	private engine!: SyncEngine;
	private data!: PluginData;

	async onload(): Promise<void> {
		this.data = normalizeData(await this.loadData(), todayDate());
		await this.saveData(this.data);

		this.cli = new CliBridge({
			runner: nodeCommandRunner,
			pathExists: (path) => existsSync(path),
			overridePath: () => this.data.settings.cliPath.trim() || undefined,
		});

		this.engine = new SyncEngine({
			cli: this.cli,
			vault: new ObsidianVaultIO(this),
			getSettings: () => this.data.settings,
			getState: () => this.data.state,
			persist: () => this.saveData(this.data),
		});

		this.addCommand({
			id: "check-connection",
			name: "Check connection",
			callback: () => {
				void this.checkConnection();
			},
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.syncNow();
			},
		});
	}

	onunload(): void {
		// Commands registered via addCommand are unregistered automatically on unload.
	}

	private async checkConnection(): Promise<void> {
		try {
			const { cliPath, meetingCount } = await this.cli.checkConnection();
			new Notice(`MacParakeet Sync: connected.\nCLI: ${cliPath}\nMeetings: ${meetingCount}`);
		} catch (error) {
			new Notice(`MacParakeet Sync: ${describeCliError(error)}`);
			console.error("MacParakeet Sync: check connection failed", error);
		}
	}

	private async syncNow(): Promise<void> {
		try {
			const summary = await this.engine.sync();
			new Notice(`MacParakeet Sync: ${summarize(summary)}`);
		} catch (error) {
			new Notice(`MacParakeet Sync: ${describeCliError(error)}`);
			console.error("MacParakeet Sync: sync failed", error);
		}
	}
}

/** Obsidian Vault-backed file I/O; the only place that touches the vault. */
class ObsidianVaultIO implements VaultIO {
	constructor(private readonly plugin: Plugin) {}

	private get vault() {
		return this.plugin.app.vault;
	}

	async folderExists(path: string): Promise<boolean> {
		return this.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;
	}

	async createFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const segments = normalized.split("/").filter((segment) => segment.length > 0);
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!(this.vault.getAbstractFileByPath(current) instanceof TFolder)) {
				try {
					await this.vault.createFolder(current);
				} catch (error) {
					// Tolerate a concurrent/pre-existing folder; rethrow anything else.
					if (!/exists/i.test(messageOf(error))) {
						throw error;
					}
				}
			}
		}
	}

	async fileExists(path: string): Promise<boolean> {
		return this.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
	}

	async write(path: string, content: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.vault.modify(existing, content);
			return;
		}
		const parent = normalized.slice(0, normalized.lastIndexOf("/"));
		if (parent.length > 0) {
			await this.createFolder(parent);
		}
		await this.vault.create(normalized, content);
	}
}

/** A one-line sync result for the manual-sync Notice. */
function summarize(summary: SyncSummary): string {
	return `${summary.created} new, ${summary.updated} updated, ${summary.unchanged} unchanged`;
}

/** Turn a thrown error into a single actionable line for a Notice. */
function describeCliError(error: unknown): string {
	if (error instanceof CliError) {
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Today's date as YYYY-MM-DD, used as the default sync-since on first run. */
function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}
