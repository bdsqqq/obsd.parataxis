export class Plugin {
  app: unknown;
  manifest: unknown;
  addCommand() {}
  addSettingTab() {}
  loadData() { return Promise.resolve(null); }
  saveData() { return Promise.resolve(); }
  registerEvent() {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = { empty() {}, createEl() { return document.createElement("div"); } };
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display() {}
  hide() {}
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
}

export class TFolder {
  path = "";
  name = "";
  children: unknown[] = [];
}
