import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "./defaults";
import { ParataxisSettingTab } from "./settings";
import type {
  CanvasData,
  CanvasNode,
  ParataxisBinding,
  ParataxisSettings,
  SourceType,
} from "./types";

export default class ParataxisPlugin extends Plugin {
  settings: ParataxisSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ParataxisSettingTab(this.app, this));

    this.addCommand({
      id: "update-canvas",
      name: "Update parataxis groups (add new)",
      callback: () => {
        void this.processActiveCanvas("update");
      },
    });

    this.addCommand({
      id: "regenerate-canvas",
      name: "Regenerate parataxis groups (full diff)",
      callback: () => {
        void this.processActiveCanvas("regenerate");
      },
    });
  }

  onunload() {}

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<ParataxisSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Process the currently active canvas file */
  async processActiveCanvas(mode: "update" | "regenerate") {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "canvas") {
      new Notice("No active canvas file.");
      return;
    }

    const raw = await this.app.vault.read(activeFile);
    let canvas: CanvasData;
    try {
      canvas = JSON.parse(raw) as CanvasData;
    } catch {
      new Notice("Failed to parse canvas file.");
      return;
    }

    const bindings = this.findBindings(canvas);
    if (bindings.length === 0) {
      new Notice(`No edges labeled "${this.settings.edgeLabel}" found.`);
      return;
    }

    let changed = false;
    for (const binding of bindings) {
      const result = await this.processBinding(canvas, binding, mode);
      if (result) changed = true;
    }

    if (changed) {
      await this.app.vault.modify(activeFile, JSON.stringify(canvas, null, "\t"));
      new Notice(`Parataxis: ${mode === "update" ? "updated" : "regenerated"} ${bindings.length} group(s).`);
    } else {
      new Notice("Parataxis: no changes needed.");
    }
  }

  /** Find all edges labeled with the configured label, paired with source + target group */
  findBindings(canvas: CanvasData): ParataxisBinding[] {
    const nodes = canvas.nodes ?? [];
    const edges = canvas.edges ?? [];
    const nodeMap = new Map<string, CanvasNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    const bindings: ParataxisBinding[] = [];
    for (const edge of edges) {
      if (edge.label?.toLowerCase() !== this.settings.edgeLabel.toLowerCase()) continue;

      const sourceNode = nodeMap.get(edge.fromNode);
      const targetGroup = nodeMap.get(edge.toNode);
      if (!sourceNode || !targetGroup) continue;
      if (targetGroup.type !== "group") continue;

      bindings.push({ edge, sourceNode, targetGroup });
    }

    return bindings;
  }

  /** Classify what kind of source a node represents */
  classifySource(node: CanvasNode): SourceType | null {
    if (node.type === "file" && node.file) {
      if (node.file.endsWith(".base")) return "base";
      if (node.file.endsWith(".md")) return "backlinks";
      return null;
    }
    if (node.type === "text" && node.text) {
      return "search";
    }
    return null;
  }

  /** Resolve a source node into a list of files */
  async resolveSource(node: CanvasNode, sourceType: SourceType): Promise<TFile[]> {
    switch (sourceType) {
      case "backlinks":
        return this.resolveBacklinks(node);
      case "base":
        return this.resolveBase(node);
      case "search":
        return this.resolveSearch(node);
    }
  }

  /** Get backlinks for a .md file node */
  resolveBacklinks(node: CanvasNode): TFile[] {
    if (!node.file) return [];
    const file = this.app.vault.getAbstractFileByPath(node.file);
    if (!(file instanceof TFile)) return [];
    return this.getBacklinkFiles(file);
  }

  /** Query a .base file for results — placeholder for base evaluation */
  async resolveBase(_node: CanvasNode): Promise<TFile[]> {
    // TODO: implement base query evaluation
    // Options: CLI (obsidian base:query), hidden leaf, or internal API
    new Notice("Base query source is not yet implemented.");
    return [];
  }

  /** Resolve a text node as a search query against vault metadata */
  resolveSearch(node: CanvasNode): TFile[] {
    const query = node.text?.trim();
    if (!query) return [];

    const files = this.app.vault.getMarkdownFiles();

    // tag search: tag:#sometag
    const tagMatch = query.match(/^tag:\s*#?(.+)$/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      return files.filter((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        if (!cache) return false;
        const inlineTags = cache.tags?.map((t) => t.tag.toLowerCase().replace(/^#/, "")) ?? [];
        const fmTags = (Array.isArray(cache.frontmatter?.tags) ? cache.frontmatter.tags : []) as string[];
        const allTags = [...inlineTags, ...fmTags.map((t) => t.toLowerCase().replace(/^#/, ""))];
        return allTags.some((t) => t === tag || t.startsWith(tag + "/"));
      });
    }

    // folder search: path:some/folder
    const pathMatch = query.match(/^path:\s*(.+)$/i);
    if (pathMatch) {
      const folder = pathMatch[1];
      return files.filter((f) => f.path.startsWith(folder));
    }

    // link search: [[NoteName]] — finds notes that link to NoteName (backlinks)
    const linkMatch = query.match(/^\[\[(.+)\]\]$/);
    if (linkMatch) {
      const targetName = linkMatch[1];
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, "");
      if (!targetFile) return [];
      return this.getBacklinkFiles(targetFile);
    }

    return [];
  }

  /** Extract TFile[] from the undocumented getBacklinksForFile API */
  private getBacklinkFiles(file: TFile): TFile[] {
    const backlinks: { data?: Map<string, unknown> } | undefined = (this.app.metadataCache as Record<string, unknown> & typeof this.app.metadataCache).getBacklinksForFile?.(file) as { data?: Map<string, unknown> } | undefined;
    const files: TFile[] = [];
    if (backlinks?.data) {
      for (const [path] of backlinks.data) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) files.push(f);
      }
    }
    return files;
  }

  /** Process a single binding: resolve source, diff group contents, update canvas */
  async processBinding(
    canvas: CanvasData,
    binding: ParataxisBinding,
    mode: "update" | "regenerate"
  ): Promise<boolean> {
    const sourceType = this.classifySource(binding.sourceNode);
    if (!sourceType) return false;

    const resultFiles = await this.resolveSource(binding.sourceNode, sourceType);
    const resultPaths = new Set(resultFiles.map((f) => f.path));

    const nodes = canvas.nodes ?? [];

    // Find existing file nodes inside the target group
    const existingFileNodes = nodes.filter(
      (n) =>
        n.type === "file" &&
        n.file &&
        this.isInsideGroup(n, binding.targetGroup)
    );
    const existingPaths = new Set(existingFileNodes.map((n) => n.file!));

    // Determine what to add
    const toAdd = resultFiles.filter((f) => !existingPaths.has(f.path));

    // Determine what to remove (only in regenerate mode)
    const toRemove =
      mode === "regenerate"
        ? existingFileNodes.filter((n) => !resultPaths.has(n.file!))
        : [];

    if (toAdd.length === 0 && toRemove.length === 0) return false;

    // Remove stale nodes
    if (toRemove.length > 0 && canvas.nodes) {
      const removeIds = new Set(toRemove.map((n) => n.id));
      canvas.nodes = canvas.nodes.filter((n) => !removeIds.has(n.id));
      // Also remove edges connected to removed nodes
      if (canvas.edges) {
        canvas.edges = canvas.edges.filter(
          (e) => !removeIds.has(e.fromNode) && !removeIds.has(e.toNode)
        );
      }
    }

    // Add new nodes to the right within the group
    if (toAdd.length > 0) {
      this.addNodesToGroup(canvas, binding.targetGroup, toAdd);
    }

    return true;
  }

  /** Check if a node's position falls within a group's bounds */
  isInsideGroup(node: CanvasNode, group: CanvasNode): boolean {
    return (
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height
    );
  }

  /** Add file nodes to a group, arranged to the right of existing content */
  addNodesToGroup(canvas: CanvasData, group: CanvasNode, files: TFile[]) {
    if (!canvas.nodes) canvas.nodes = [];

    const NODE_WIDTH = 250;
    const NODE_HEIGHT = 60;
    const GAP = 20;
    const PADDING = 20;

    // Find the rightmost x of existing nodes in the group
    const nodesInGroup = canvas.nodes.filter(
      (n) => n.id !== group.id && this.isInsideGroup(n, group)
    );
    let startX: number;
    if (nodesInGroup.length > 0) {
      const maxRight = Math.max(...nodesInGroup.map((n) => n.x + n.width));
      startX = maxRight + GAP;
    } else {
      startX = group.x + PADDING;
    }

    const startY = group.y + PADDING + 30; // 30px offset for group label

    for (let i = 0; i < files.length; i++) {
      const x = startX + i * (NODE_WIDTH + GAP);
      const y = startY;

      canvas.nodes.push({
        id: this.generateId(),
        type: "file",
        file: files[i].path,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    }

    // Grow group width to contain all new nodes
    const lastNodeRight = startX + files.length * (NODE_WIDTH + GAP) - GAP + PADDING;
    if (lastNodeRight > group.x + group.width) {
      group.width = lastNodeRight - group.x;
    }

    // Ensure group height contains nodes
    const neededHeight = startY + NODE_HEIGHT + PADDING - group.y;
    if (neededHeight > group.height) {
      group.height = neededHeight;
    }
  }

  /** Generate a unique ID for canvas nodes */
  generateId(): string {
    const chars = "0123456789abcdef";
    let id = "";
    for (let i = 0; i < 16; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }
}
