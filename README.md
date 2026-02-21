# .parataxis

canvas-native query results for obsidian. connect a source node to a group, label the edge, and results appear inside the group.

## how it works

the plugin watches for edges labeled `parataxis` (configurable). when it finds one pointing from a source node to a group, it resolves the source and populates the group with file nodes.

```
source node ──parataxis──▶ group
```

three source types, inferred from the node:

### `.md` file node → backlinks

embed a markdown file on the canvas. the group fills with every note that links to it.

### `.base` file node → base query

embed a `.base` file. the group fills with whatever the base query returns.

### text node → search

write a query in a text node. supported patterns:

- `tag:#journaling` — files with the tag (including nested tags)
- `path:projects/active/` — files under the path
- `[[Some Note]]` — backlinks to that note

## usage

1. create or embed a source node on a canvas (file or text)
2. create a group nearby
3. draw an edge from the source node to the group
4. label the edge `parataxis` (or whatever you've configured)
5. results populate the group

## commands

**update parataxis groups (add new)** — adds missing results. leaves existing nodes untouched. safe to run repeatedly.

**regenerate parataxis groups (full diff)** — adds missing results AND removes nodes no longer in the query results. use when your source data changed and you want the group to reflect current state.

both available from the command palette and right-click context menu on canvas nodes.

## settings

**edge label** — the label that triggers processing. defaults to `parataxis`. case-insensitive matching.

## triggers

processing runs automatically when:

- a canvas file is opened (500ms delay)
- an edge label is set to the configured value (detected via monkey-patching)

and manually via:

- command palette
- right-click context menu on any canvas node

## limitations

- **base source** opens the `.base` file in a hidden tab to read results (no headless API exists). may briefly flash on screen.
- **search** supports `tag:`, `path:`, and `[[link]]` only — not the full obsidian search syntax.
- **edge detection** relies on undocumented canvas internals (`addEdge`, `setData`). works as of obsidian 1.6+, but could break.
- **layout** is naive — new nodes tile horizontally to the right. no auto-arrange.

## development

```bash
pnpm install
pnpm run dev
pnpm run build
pnpm run test
```
