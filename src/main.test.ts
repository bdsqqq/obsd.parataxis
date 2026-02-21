import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import ParataxisPlugin from "./main";
import type { CanvasData, CanvasNode } from "./types";

/** Create a minimal plugin instance with mock app */
function createPlugin(opts?: {
  files?: TFile[];
  cacheMap?: Map<string, { tags?: { tag: string }[]; frontmatter?: { tags?: string[] } }>;
  backlinksMap?: Map<string, string[]>;
  linkpathDest?: Map<string, TFile>;
}) {
  const files = opts?.files ?? [];
  const cacheMap =
    opts?.cacheMap ??
    new Map<string, { tags?: { tag: string }[]; frontmatter?: { tags?: string[] } }>();
  const backlinksMap = opts?.backlinksMap ?? new Map<string, string[]>();
  const linkpathDest = opts?.linkpathDest ?? new Map<string, TFile>();

  const filesByPath = new Map<string, TFile>();
  for (const f of files) filesByPath.set(f.path, f);

  const plugin = new ParataxisPlugin();
  plugin.settings = { edgeLabel: "parataxis", verboseNotices: false };
  plugin.app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p: string) => filesByPath.get(p) ?? null,
    },
    metadataCache: {
      getFileCache: (f: TFile) => cacheMap.get(f.path) ?? null,
      getFirstLinkpathDest: (name: string) => linkpathDest.get(name) ?? null,
      getBacklinksForFile: (f: TFile) => {
        const paths = backlinksMap.get(f.path);
        if (!paths) return { data: new Map() };
        return { data: new Map(paths.map((p) => [p, []])) };
      },
    },
  } as unknown as typeof plugin.app;

  return plugin;
}

function makeTFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.name = path.split("/").pop()!;
  f.basename = f.name.replace(/\.[^.]+$/, "");
  f.extension = path.split(".").pop()!;
  return f;
}

function makeNode(overrides: Partial<CanvasNode> & { id: string; type: CanvasNode["type"] }): CanvasNode {
  return { x: 0, y: 0, width: 100, height: 50, ...overrides };
}

// ─── findBindings ────────────────────────────────────────────────

describe("findBindings", () => {
  it("finds edges with matching label connecting source → group", () => {
    const plugin = createPlugin();
    const canvas: CanvasData = {
      nodes: [
        makeNode({ id: "src", type: "file", file: "note.md" }),
        makeNode({ id: "grp", type: "group" }),
      ],
      edges: [
        { id: "e1", fromNode: "src", toNode: "grp", label: "parataxis" },
      ],
    };
    const bindings = plugin.findBindings(canvas);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].sourceNode.id).toBe("src");
    expect(bindings[0].targetGroup.id).toBe("grp");
  });

  it("matches label case-insensitively", () => {
    const plugin = createPlugin();
    const canvas: CanvasData = {
      nodes: [
        makeNode({ id: "src", type: "text", text: "tag:#foo" }),
        makeNode({ id: "grp", type: "group" }),
      ],
      edges: [
        { id: "e1", fromNode: "src", toNode: "grp", label: "Parataxis" },
      ],
    };
    expect(plugin.findBindings(canvas)).toHaveLength(1);
  });

  it("ignores edges without the label", () => {
    const plugin = createPlugin();
    const canvas: CanvasData = {
      nodes: [
        makeNode({ id: "src", type: "file", file: "note.md" }),
        makeNode({ id: "grp", type: "group" }),
      ],
      edges: [
        { id: "e1", fromNode: "src", toNode: "grp", label: "other" },
        { id: "e2", fromNode: "src", toNode: "grp" },
      ],
    };
    expect(plugin.findBindings(canvas)).toHaveLength(0);
  });

  it("ignores edges where target is not a group", () => {
    const plugin = createPlugin();
    const canvas: CanvasData = {
      nodes: [
        makeNode({ id: "src", type: "file", file: "a.md" }),
        makeNode({ id: "dst", type: "file", file: "b.md" }),
      ],
      edges: [
        { id: "e1", fromNode: "src", toNode: "dst", label: "parataxis" },
      ],
    };
    expect(plugin.findBindings(canvas)).toHaveLength(0);
  });

  it("ignores edges where source or target node doesn't exist", () => {
    const plugin = createPlugin();
    const canvas: CanvasData = {
      nodes: [makeNode({ id: "grp", type: "group" })],
      edges: [
        { id: "e1", fromNode: "ghost", toNode: "grp", label: "parataxis" },
      ],
    };
    expect(plugin.findBindings(canvas)).toHaveLength(0);
  });

  it("handles empty canvas", () => {
    const plugin = createPlugin();
    expect(plugin.findBindings({})).toHaveLength(0);
    expect(plugin.findBindings({ nodes: [], edges: [] })).toHaveLength(0);
  });
});

// ─── classifySource ──────────────────────────────────────────────

describe("classifySource", () => {
  const plugin = createPlugin();

  it("file node with .base → 'base'", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "file", file: "db.base" }))).toBe("base");
  });

  it("file node with .md → 'backlinks'", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "file", file: "note.md" }))).toBe("backlinks");
  });

  it("file node with other extension → null", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "file", file: "pic.png" }))).toBeNull();
  });

  it("text node with text → 'search'", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "text", text: "tag:#foo" }))).toBe("search");
  });

  it("text node without text → null", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "text" }))).toBeNull();
  });

  it("group node → null", () => {
    expect(plugin.classifySource(makeNode({ id: "1", type: "group" }))).toBeNull();
  });
});

// ─── isInsideGroup ───────────────────────────────────────────────

describe("isInsideGroup", () => {
  const plugin = createPlugin();
  const group = makeNode({ id: "g", type: "group", x: 0, y: 0, width: 400, height: 300 });

  it("node fully inside → true", () => {
    const node = makeNode({ id: "n", type: "file", x: 10, y: 10, width: 100, height: 50 });
    expect(plugin.isInsideGroup(node, group)).toBe(true);
  });

  it("node partially outside → false", () => {
    const node = makeNode({ id: "n", type: "file", x: 350, y: 10, width: 100, height: 50 });
    expect(plugin.isInsideGroup(node, group)).toBe(false);
  });

  it("node completely outside → false", () => {
    const node = makeNode({ id: "n", type: "file", x: 500, y: 500, width: 100, height: 50 });
    expect(plugin.isInsideGroup(node, group)).toBe(false);
  });

  it("node exactly at group bounds → true", () => {
    const node = makeNode({ id: "n", type: "file", x: 0, y: 0, width: 400, height: 300 });
    expect(plugin.isInsideGroup(node, group)).toBe(true);
  });
});

// ─── addNodesToGroup ─────────────────────────────────────────────

describe("addNodesToGroup", () => {
  it("adds file nodes to the right of existing content", () => {
    const plugin = createPlugin();
    const group = makeNode({ id: "g", type: "group", x: 0, y: 0, width: 400, height: 300 });
    const existing = makeNode({ id: "ex", type: "file", file: "old.md", x: 20, y: 70, width: 250, height: 60 });
    const canvas: CanvasData = { nodes: [group, existing] };
    const files = [makeTFile("new.md")];

    plugin.addNodesToGroup(canvas, group, files);

    const added = canvas.nodes!.find((n) => n.file === "new.md");
    expect(added).toBeDefined();
    // should be placed to the right of existing node (270 + 20 gap = 290)
    expect(added!.x).toBe(existing.x + existing.width + 20);
  });

  it("grows group width to contain new nodes", () => {
    const plugin = createPlugin();
    const group = makeNode({ id: "g", type: "group", x: 0, y: 0, width: 200, height: 300 });
    const canvas: CanvasData = { nodes: [group] };
    const files = [makeTFile("a.md"), makeTFile("b.md")];

    plugin.addNodesToGroup(canvas, group, files);

    // group should have grown to fit both nodes
    const addedNodes = canvas.nodes!.filter((n) => n.type === "file");
    expect(addedNodes).toHaveLength(2);
    const rightmostEdge = Math.max(...addedNodes.map((n) => n.x + n.width));
    expect(group.width).toBeGreaterThanOrEqual(rightmostEdge - group.x);
  });

  it("positions at group start when group is empty", () => {
    const plugin = createPlugin();
    const group = makeNode({ id: "g", type: "group", x: 100, y: 200, width: 400, height: 300 });
    const canvas: CanvasData = { nodes: [group] };
    const files = [makeTFile("first.md")];

    plugin.addNodesToGroup(canvas, group, files);

    const added = canvas.nodes!.find((n) => n.file === "first.md");
    expect(added).toBeDefined();
    // PADDING = 20, so x should be group.x + 20
    expect(added!.x).toBe(group.x + 20);
  });

  it("preserves existing nodes", () => {
    const plugin = createPlugin();
    const group = makeNode({ id: "g", type: "group", x: 0, y: 0, width: 600, height: 300 });
    const existing = makeNode({ id: "ex", type: "file", file: "keep.md", x: 20, y: 70, width: 250, height: 60 });
    const canvas: CanvasData = { nodes: [group, existing] };

    plugin.addNodesToGroup(canvas, group, [makeTFile("new.md")]);

    expect(canvas.nodes!.find((n) => n.id === "ex")).toBeDefined();
    expect(canvas.nodes!.filter((n) => n.type === "file")).toHaveLength(2);
  });
});

// ─── resolveSearch ───────────────────────────────────────────────

describe("resolveSearch", () => {
  it("tag:#sometag matches files with that tag (inline)", () => {
    const f1 = makeTFile("tagged.md");
    const f2 = makeTFile("other.md");
    const cacheMap = new Map([
      ["tagged.md", { tags: [{ tag: "#sometag" }] }],
      ["other.md", { tags: [{ tag: "#different" }] }],
    ]);
    const plugin = createPlugin({ files: [f1, f2], cacheMap });

    const node = makeNode({ id: "s", type: "text", text: "tag:#sometag" });
    const result = plugin.resolveSearch(node);
    expect(result.map((f) => f.path)).toEqual(["tagged.md"]);
  });

  it("tag:#sometag matches files with that tag (frontmatter)", () => {
    const f1 = makeTFile("fm.md");
    const cacheMap = new Map([
      ["fm.md", { frontmatter: { tags: ["sometag"] } }],
    ]);
    const plugin = createPlugin({ files: [f1], cacheMap });

    const node = makeNode({ id: "s", type: "text", text: "tag:#sometag" });
    const result = plugin.resolveSearch(node);
    expect(result.map((f) => f.path)).toEqual(["fm.md"]);
  });

  it("path:folder/ matches files in that path", () => {
    const f1 = makeTFile("folder/note.md");
    const f2 = makeTFile("other/note.md");
    const plugin = createPlugin({ files: [f1, f2] });

    const node = makeNode({ id: "s", type: "text", text: "path:folder/" });
    const result = plugin.resolveSearch(node);
    expect(result.map((f) => f.path)).toEqual(["folder/note.md"]);
  });

  it("[[Note]] resolves as backlinks", () => {
    const target = makeTFile("Note.md");
    const linker = makeTFile("linker.md");
    const plugin = createPlugin({
      files: [target, linker],
      linkpathDest: new Map([["Note", target]]),
      backlinksMap: new Map([["Note.md", ["linker.md"]]]),
    });

    const node = makeNode({ id: "s", type: "text", text: "[[Note]]" });
    const result = plugin.resolveSearch(node);
    expect(result.map((f) => f.path)).toEqual(["linker.md"]);
  });

  it("empty/unknown query returns empty array", () => {
    const plugin = createPlugin();

    expect(plugin.resolveSearch(makeNode({ id: "s", type: "text", text: "" }))).toEqual([]);
    expect(plugin.resolveSearch(makeNode({ id: "s", type: "text", text: "  " }))).toEqual([]);
    expect(plugin.resolveSearch(makeNode({ id: "s", type: "text", text: "random junk" }))).toEqual([]);
    expect(plugin.resolveSearch(makeNode({ id: "s", type: "text" }))).toEqual([]);
  });
});
