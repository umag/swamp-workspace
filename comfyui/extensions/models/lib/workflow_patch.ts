/**
 * ComfyUI "API format" workflow graph patcher.
 *
 * The `/prompt` endpoint consumes the API format: a flat object mapping a
 * node-id to a node. We drive workflows by overriding node inputs without
 * mutating the caller's template (we deep-clone first).
 */

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string } & Record<string, unknown>;
}

export type ApiGraph = Record<string, ApiNode>;

/** A single override: `inputs` is shallow-merged into the node's `inputs`. */
export interface NodePatch {
  nodeId: string;
  inputs: Record<string, unknown>;
}

/**
 * Compare two node-ids: numeric ids sort numerically and come before
 * non-numeric ids; non-numeric ids sort lexically among themselves.
 */
function compareNodeIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a.trim() !== "" && Number.isFinite(na);
  const bNum = b.trim() !== "" && Number.isFinite(nb);
  if (aNum && bNum) {
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Node-ids whose `class_type` matches, in numeric-then-lexical order. */
export function findNodesByClass(graph: ApiGraph, classType: string): string[] {
  return Object.keys(graph)
    .filter((id) => graph[id]?.class_type === classType)
    .sort(compareNodeIds);
}

/** Node-ids whose `_meta.title` matches exactly, in numeric-then-lexical order. */
export function findNodesByTitle(graph: ApiGraph, title: string): string[] {
  return Object.keys(graph)
    .filter((id) => graph[id]?._meta?.title === title)
    .sort(compareNodeIds);
}

/**
 * Deep-clone the graph, then for each patch assert the node exists (throw if
 * not) and shallow-merge `patch.inputs` over the node's `inputs`. The input
 * graph is never mutated.
 */
export function patchWorkflow(graph: ApiGraph, patches: NodePatch[]): ApiGraph {
  const clone = structuredClone(graph);
  for (const patch of patches) {
    const node = clone[patch.nodeId];
    if (node === undefined) {
      throw new Error(`node '${patch.nodeId}' not found in workflow`);
    }
    node.inputs = { ...node.inputs, ...patch.inputs };
  }
  return clone;
}

export interface IdeogramOverrides {
  caption?: string;
  captionNodeId?: string;
  captionInputKey?: string; // default "text"
  seed?: number;
  seedNodeId?: string;
  seedInputKey?: string; // default "noise_seed"
  resolution?: string;
  resolutionNodeId?: string;
  resolutionInputKey?: string; // default "aspect_ratio"
}

/**
 * Turn IdeogramOverrides into NodePatch[] and apply via `patchWorkflow`.
 *
 * Only fields whose value is defined emit a patch. If a value is provided but
 * its node id is omitted we throw — we do not guess which node to target.
 */
export function applyIdeogramOverrides(
  graph: ApiGraph,
  o: IdeogramOverrides,
): ApiGraph {
  const patches: NodePatch[] = [];

  if (o.caption !== undefined) {
    if (o.captionNodeId === undefined) {
      throw new Error(
        "caption provided without captionNodeId; pass the node id explicitly",
      );
    }
    patches.push({
      nodeId: o.captionNodeId,
      inputs: { [o.captionInputKey ?? "text"]: o.caption },
    });
  }

  if (o.seed !== undefined) {
    if (o.seedNodeId === undefined) {
      throw new Error(
        "seed provided without seedNodeId; pass the node id explicitly",
      );
    }
    patches.push({
      nodeId: o.seedNodeId,
      inputs: { [o.seedInputKey ?? "noise_seed"]: o.seed },
    });
  }

  if (o.resolution !== undefined) {
    if (o.resolutionNodeId === undefined) {
      throw new Error(
        "resolution provided without resolutionNodeId; pass the node id explicitly",
      );
    }
    patches.push({
      nodeId: o.resolutionNodeId,
      inputs: { [o.resolutionInputKey ?? "aspect_ratio"]: o.resolution },
    });
  }

  return patchWorkflow(graph, patches);
}
