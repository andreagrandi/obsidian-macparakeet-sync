import { type App, PluginSettingTab, Setting, debounce, normalizePath } from "obsidian";
import type MeetingNotesSyncPlugin from "./main";
import { cleanBaseFolder, cleanInterval, isValidSyncSince, isValidTemplate } from "./settings";

/** The full configuration UI; reads and writes the plugin's live settings. */
export class MeetingNotesSettingTab extends PluginSettingTab {
	private readonly plugin: MeetingNotesSyncPlugin;
	private cliStatusEl: HTMLElement | null = null;

	constructor(app: App, plugin: MeetingNotesSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.getSettings();

		new Setting(containerEl)
			.setName("macparakeet-cli path")
			.setDesc(
				"Leave empty to auto-discover (Homebrew paths, then the MacParakeet app bundle). " +
					"Set a full path to override discovery.",
			)
			.addText((text) =>
				text
					.setPlaceholder("/opt/homebrew/bin/macparakeet-cli")
					.setValue(settings.cliPath)
					.onChange(
						debounce(
							async (value: string) => {
								await this.plugin.updateSettings({ cliPath: value.trim() });
								await this.refreshCliStatus();
							},
							600,
							true,
						),
					),
			);
		this.cliStatusEl = containerEl.createEl("div", { cls: "setting-item-description" });
		void this.refreshCliStatus();

		new Setting(containerEl)
			.setName("Base folder")
			.setDesc("Vault folder all meeting folders are created under.")
			.addText((text) =>
				text.setValue(settings.baseFolder).onChange((value) => {
					void this.plugin.updateSettings({ baseFolder: normalizePath(cleanBaseFolder(value)) });
				}),
			);

		const templateError = containerEl.createEl("div", { cls: "setting-item-description mod-warning" });
		new Setting(containerEl)
			.setName("Path template")
			.setDesc("Folder path per meeting. Tokens: {year} {month} {monthName} {day} {date} {n} {title}")
			.addText((text) =>
				text.setValue(settings.pathTemplate).onChange((value) => {
					if (!isValidTemplate(value)) {
						templateError.setText("Path template cannot be empty.");
						return;
					}
					templateError.setText("");
					void this.plugin.updateSettings({ pathTemplate: value.trim() });
				}),
			);

		const sinceError = containerEl.createEl("div", { cls: "setting-item-description mod-warning" });
		new Setting(containerEl)
			.setName("Sync meetings since")
			.setDesc("Only meetings created on/after this date are imported. Empty = the install date.")
			.addText((text) => {
				text.inputEl.type = "date";
				text.setValue(settings.syncSince).onChange((value) => {
					if (!isValidSyncSince(value)) {
						sinceError.setText("Enter a YYYY-MM-DD date or leave empty.");
						return;
					}
					sinceError.setText("");
					void this.plugin.updateSettings({ syncSince: value.trim() });
				});
			});

		new Setting(containerEl)
			.setName("Sync AI results")
			.setDesc("Import each meeting's AI prompt results as separate notes.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncResults).onChange((value) => {
					void this.plugin.updateSettings({ syncResults: value });
				}),
			);

		new Setting(containerEl)
			.setName("Sync meeting notes")
			.setDesc("Import the notes you typed in MacParakeet as Notes.md.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncNotes).onChange((value) => {
					void this.plugin.updateSettings({ syncNotes: value });
				}),
			);

		new Setting(containerEl)
			.setName("Sync transcript")
			.setDesc("Import the full transcript as Transcript.md. Transcripts can be long; off by default.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncTranscript).onChange((value) => {
					void this.plugin.updateSettings({ syncTranscript: value });
				}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to sync in the background. 0 disables the timer.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.syncIntervalMinutes)).onChange((value) => {
					void this.plugin.updateSettings({ syncIntervalMinutes: cleanInterval(value) });
				});
			});

		new Setting(containerEl)
			.setName("Sync on launch")
			.setDesc("Run a sync shortly after Obsidian starts.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncOnLaunch).onChange((value) => {
					void this.plugin.updateSettings({ syncOnLaunch: value });
				}),
			);
	}

	/** Validate the CLI from the current override and reflect the result inline. */
	private async refreshCliStatus(): Promise<void> {
		const el = this.cliStatusEl;
		if (!el) {
			return;
		}
		el.removeClass("mod-warning");
		el.setText("Checking macparakeet-cli…");
		const status = await this.plugin.validateCli();
		if (status.ok) {
			el.setText(`Connected · ${status.path} · ${status.meetingCount} meetings`);
		} else {
			el.addClass("mod-warning");
			el.setText(`Not connected: ${status.error}`);
		}
	}
}
