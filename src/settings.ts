import { type App, PluginSettingTab, Setting } from "obsidian";
import type ParataxisPlugin from "./main";

export class ParataxisSettingTab extends PluginSettingTab {
  plugin: ParataxisPlugin;

  constructor(app: App, plugin: ParataxisPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Edge label")
      .setDesc("Only edges with this label will trigger parataxis processing.")
      .addText((text) =>
        text
          .setPlaceholder("Parataxis")
          .setValue(this.plugin.settings.edgeLabel)
          .onChange(async (value) => {
            this.plugin.settings.edgeLabel = value || "parataxis";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Verbose notices")
      .setDesc("Show notices even when no parataxis edges are found on a canvas.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.verboseNotices)
          .onChange(async (value) => {
            this.plugin.settings.verboseNotices = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
