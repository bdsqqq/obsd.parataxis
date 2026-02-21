import { Menu, Notice, Plugin, TFile } from "obsidian";
import type { ViewState, WorkspaceLeaf } from "obsidian";
import { around } from "monkey-around";
import { DEFAULT_SETTINGS } from "./defaults";
import { ParataxisSettingTab } from "./settings";
import type {
  CanvasData,
  CanvasNode,
  ParataxisBinding,
  ParataxisSettings,
  SourceType,
} from "./types";

/** Minimal shape of the internal Bases controller (not in public API) */
type BasesControllerLike = {
  results?: unknown;
  initialScan?: unknown;
};

/** Minimal shape of the results Map (keys are TFile instances) */
type ResultsMapLike = {
  keys: () => IterableIterator<unknown>;
  size: number;
};

/** Shape of the internal BasesView state stored on the leaf */
type BasesViewStateLike = {
  file?: string;
  viewName?: string;
};

export default class ParataxisPlugin extends Plugin {
  settings: ParataxisSettings = DEFAULT_SETTINGS;

  /** tracks canvas prototypes already patched to avoid double-patching addEdge */
  private patchedCanvasPrototypes = new WeakSet<object>();

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

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "canvas") {
          window.setTimeout(() => {
            void this.processCanvasFile(file, "update");
          }, 500);
        }
      })
    );

    // patch canvas views to detect edge labeling in real time
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.app.workspace.iterateAllLeaves((leaf) => {
          // @ts-expect-error — canvas is an internal property on the canvas view
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const canvas: { constructor: { prototype: object }; edges: Map<string, object> } | undefined = leaf.view?.canvas;
          if (canvas) this.patchCanvas(canvas);
        });
      })
    );

    // right-click context menu on canvas nodes
    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error — canvas:node-menu is undocumented but stable
        "canvas:node-menu",
        (menu: Menu, node: unknown) => {
          void node;
          menu.addItem((item) => {
            item
              // eslint-disable-next-line obsidianmd/ui/sentence-case
              .setTitle("Parataxis: Update")
              .setIcon("workflow")
              .onClick(() => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.extension === "canvas") {
                  void this.processCanvasFile(activeFile, "update");
                }
              });
          });
          menu.addItem((item) => {
            item
              // eslint-disable-next-line obsidianmd/ui/sentence-case
              .setTitle("Parataxis: Regenerate")
              .setIcon("refresh-cw")
              .onClick(() => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.extension === "canvas") {
                  void this.processCanvasFile(activeFile, "regenerate");
                }
              });
          });
        }
      )
    );
  }

  /** monkey-patch a canvas prototype so new edges trigger processing on label match */
  private patchCanvas(canvas: { constructor: { prototype: object }; edges: Map<string, object> }) {
    const proto = canvas.constructor.prototype;
    if (this.patchedCanvasPrototypes.has(proto)) return;
    this.patchedCanvasPrototypes.add(proto);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const patchEdgeBound: (edge: Record<string, (...args: unknown[]) => unknown>) => void =
      this.patchEdge.bind(this);
    const uninstallAddEdge = around(proto as Record<string, (...args: unknown[]) => unknown>, {
      addEdge(next) {
        return function (this: unknown, edge: unknown) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const result = next.call(this, edge);
          patchEdgeBound(edge as Record<string, (...args: unknown[]) => unknown>);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return result;
        };
      },
    });
    this.register(uninstallAddEdge);

    // patch edges already present on this canvas
    for (const [, edge] of canvas.edges) {
      this.patchEdge(edge as Record<string, (...args: unknown[]) => unknown>);
    }
  }

  /** monkey-patch an individual edge's setData to detect label changes */
  private patchEdge(edge: Record<string, (...args: unknown[]) => unknown>) {
    const getSettings = () => this.settings;
    const getActiveFile = () => this.app.workspace.getActiveFile();
    const processFile = (file: TFile, mode: "update" | "regenerate") => this.processCanvasFile(file, mode);
    const uninstall = around(edge, {
      setData(next) {
        return function (this: unknown, data: unknown, ...args: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const result = next.call(this, data, ...args);
          const d = data as { label?: string } | null;
          if (
            typeof d?.label === "string" &&
            d.label.toLowerCase() === getSettings().edgeLabel.toLowerCase()
          ) {
            const activeFile = getActiveFile();
            if (activeFile?.extension === "canvas") {
              void processFile(activeFile, "update");
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return result;
        };
      },
    });
    this.register(uninstall);
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
    await this.processCanvasFile(activeFile, mode);
  }

  /** Process a specific canvas file */
  async processCanvasFile(file: TFile, mode: "update" | "regenerate") {
    const raw = await this.app.vault.read(file);
    let canvas: CanvasData;
    try {
      canvas = JSON.parse(raw) as CanvasData;
    } catch {
      new Notice("Failed to parse canvas file.");
      return;
    }

    const bindings = this.findBindings(canvas);
    if (bindings.length === 0) {
      if (this.settings.verboseNotices) {
        new Notice(`No edges labeled "${this.settings.edgeLabel}" found.`);
      }
      return;
    }

    let changed = false;
    for (const binding of bindings) {
      const result = await this.processBinding(canvas, binding, mode);
      if (result) changed = true;
    }

    if (changed) {
      await this.app.vault.modify(file, JSON.stringify(canvas, null, "\t"));
      new Notice(`Parataxis: ${mode === "update" ? "updated" : "regenerated"} ${bindings.length} group(s).`);
    } else if (this.settings.verboseNotices) {
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

  /**
   * Query a .base file for its matching files by opening it in a background
   * leaf and reading controller.results after they settle.
   *
   * There is no headless API for evaluating Bases — this workaround opens
   * the Base in a new tab, polls the internal controller until results
   * arrive or a timeout elapses, then extracts TFiles and cleans up.
   *
   * @see https://forum.obsidian.md/t/provide-api-access-to-the-results-of-bases-view/110660
   */
  async resolveBase(node: CanvasNode): Promise<TFile[]> {
    if (!node.file) return [];

    const baseFile = this.app.vault.getAbstractFileByPath(node.file);
    if (!(baseFile instanceof TFile)) {
      new Notice(`Parataxis: base file not found: ${node.file}`);
      return [];
    }

    // subpath selects a named view (e.g. "#Read" → view "Read")
    const viewName = node.subpath?.replace(/^#/, "") || undefined;

    const TIMEOUT_MS = 5_000;
    const POLL_MS = 50;

    const previousLeaf = this.app.workspace.getMostRecentLeaf();
    let leaf: WorkspaceLeaf | null = null;

    try {
      leaf = this.app.workspace.getLeaf("tab");

      // append fragment so Bases opens the correct named view
      const linktext = viewName ? `${baseFile.path}#${viewName}` : baseFile.path;
      await this.app.workspace.openLinkText(
        linktext,
        baseFile.path,
        false,
        { active: false }
      );

      // wait for the BasesView controller to appear and produce results
      const controller = await this.pollBasesController(leaf, TIMEOUT_MS, POLL_MS, viewName);
      if (!controller) {
        new Notice("Parataxis: base query timed out waiting for results.");
        return [];
      }

      return this.extractFilesFromBasesResults(controller);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Parataxis: base query failed — ${msg}`);
      return [];
    } finally {
      try {
        if (leaf && previousLeaf && previousLeaf !== leaf) {
          this.app.workspace.setActiveLeaf(previousLeaf, { focus: true });
        }
      } catch { /* ignore */ }

      try {
        leaf?.detach();
      } catch { /* ignore */ }
    }
  }

  /**
   * Poll a leaf until its BasesView controller has settled results.
   * When viewName is provided, also verifies the leaf loaded the correct
   * named view before accepting results — prevents reading the wrong
   * view's data when two edges target the same .base with different subpaths.
   */
  private async pollBasesController(
    leaf: WorkspaceLeaf,
    timeoutMs: number,
    pollMs: number,
    viewName?: string
  ): Promise<BasesControllerLike | null> {
    const deadline = performance.now() + timeoutMs;

    while (performance.now() < deadline) {
      const vs: ViewState = leaf.getViewState();
      if (vs.type === "bases") {
        // when a specific view was requested, wait until it loads
        if (viewName) {
          const state = (vs.state ?? {}) as BasesViewStateLike;
          if (state.viewName !== viewName) {
            await new Promise<void>((r) => window.setTimeout(r, pollMs));
            continue;
          }
        }

        // @ts-expect-error — controller is an internal Bases property not in public API
        const controller = leaf.view.controller as BasesControllerLike | undefined;
        if (controller?.results && typeof (controller.results as ResultsMapLike).keys === "function") {
          // settled once initialScan flips to false, or best-effort on timeout
          if (controller.initialScan === false) return controller;
        }
      }
      await new Promise<void>((r) => window.setTimeout(r, pollMs));
    }

    // best-effort: return controller even if initialScan hasn't finished
    const vs: ViewState = leaf.getViewState();
    if (vs.type === "bases") {
      // don't return best-effort results from the wrong view
      if (viewName) {
        const state = (vs.state ?? {}) as BasesViewStateLike;
        if (state.viewName !== viewName) return null;
      }

      // @ts-expect-error — controller is an internal Bases property not in public API
      const controller = leaf.view.controller as BasesControllerLike | undefined;
      if (controller?.results && typeof (controller.results as ResultsMapLike).keys === "function") {
        return controller;
      }
    }

    return null;
  }

  /** Extract TFile instances from the controller.results Map-like object */
  private extractFilesFromBasesResults(controller: BasesControllerLike): TFile[] {
    const results = controller.results as ResultsMapLike | undefined;
    if (!results || typeof results.keys !== "function") return [];

    const files: TFile[] = [];
    for (const key of results.keys()) {
      if (key instanceof TFile) files.push(key);
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
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
