import type { TFile } from "obsidian";

/** Settings persisted by the plugin */
export interface ParataxisSettings {
  /** The edge label that triggers parataxis processing */
  edgeLabel: string;
}

/** A node in the JSON Canvas format */
export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  // text node
  text?: string;
  // file node
  file?: string;
  subpath?: string;
  // group node
  label?: string;
  background?: string;
  backgroundStyle?: string;
}

/** An edge in the JSON Canvas format */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}

/** The top-level JSON Canvas structure */
export interface CanvasData {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

/** The result of resolving a source strategy */
export interface SourceResult {
  files: TFile[];
}

/** Identifies a parataxis edge: source node → group */
export interface ParataxisBinding {
  edge: CanvasEdge;
  sourceNode: CanvasNode;
  targetGroup: CanvasNode;
}

/** Source strategy type, inferred from node */
export type SourceType = "base" | "backlinks" | "search";
