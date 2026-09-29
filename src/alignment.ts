import type { Segment } from "./types";

/**
 * 双轨对齐判定：两片段在时间轴上重叠，且起止时间偏差都在容差内，
 * 才视为“已对齐”。容差由草稿保存，重开后沿用同一标准。
 */
export interface AlignmentResult {
  /** 原音片段 id -> 配对的校订片段（双向唯一）。 */
  pairs: Map<string, Segment>;
  /** 校订片段 id -> 配对的原音片段（双向唯一）。 */
  revisionPairs: Map<string, Segment>;
  /** 未找到合格配对的原音片段（时间上重叠但边界超出容差也算未对齐）。 */
  misalignedOriginal: Segment[];
  /** 未找到合格配对的校订片段。 */
  misalignedRevision: Segment[];
  /** 时间轴上两轨对不上的连续区间（秒）。 */
  mismatchRanges: Array<{ start: number; end: number; label: string }>;
}

interface Candidate {
  segment: Segment;
  /** 起止偏差之和，越小越贴合。 */
  drift: number;
  /** 时间重叠长度。 */
  overlap: number;
}

function overlapSeconds(a: Segment, b: Segment) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function candidatesFor(target: Segment, others: Segment[], tolerance: number): Candidate[] {
  return others
    .map((segment) => {
      const overlap = overlapSeconds(target, segment);
      const startDrift = Math.abs(target.start - segment.start);
      const endDrift = Math.abs(target.end - segment.end);
      return { segment, overlap, drift: startDrift + endDrift, startDrift, endDrift };
    })
    .filter((item) => {
      // 必须有实际时间重叠，且起止都落在容差内，才算对齐。
      return item.overlap > 0 && item.startDrift <= tolerance && item.endDrift <= tolerance;
    })
    .sort((a, b) => b.overlap - a.overlap || a.drift - b.drift);
}

/**
 * 贪心求双向唯一配对：每次取“最贴合”的一对（重叠最长、偏差最小），
 * 配掉的片段不再参与，避免一个原音片段同时配上两个校订片段。
 */
export function computeAlignment(
  originalTrack: Segment[],
  revisionTrack: Segment[],
  tolerance: number,
): AlignmentResult {
  const edges: Array<{ original: Segment; revision: Segment; drift: number; overlap: number }> = [];
  for (const original of originalTrack) {
    for (const candidate of candidatesFor(original, revisionTrack, tolerance)) {
      edges.push({ original, revision: candidate.segment, drift: candidate.drift, overlap: candidate.overlap });
    }
  }
  edges.sort((a, b) => b.overlap - a.overlap || a.drift - b.drift);

  const pairs = new Map<string, Segment>();
  const revisionPairs = new Map<string, Segment>();
  const usedOriginal = new Set<string>();
  const usedRevision = new Set<string>();
  for (const edge of edges) {
    if (usedOriginal.has(edge.original.id) || usedRevision.has(edge.revision.id)) continue;
    usedOriginal.add(edge.original.id);
    usedRevision.add(edge.revision.id);
    pairs.set(edge.original.id, edge.revision);
    revisionPairs.set(edge.revision.id, edge.original);
  }

  const misalignedOriginal = originalTrack.filter((segment) => !usedOriginal.has(segment.id));
  const misalignedRevision = revisionTrack.filter((segment) => !usedRevision.has(segment.id));

  return {
    pairs,
    revisionPairs,
    misalignedOriginal,
    misalignedRevision,
    mismatchRanges: mergeRanges([...misalignedOriginal, ...misalignedRevision]),
  };
}

/** 把未对齐片段在时间轴上合并成连续区间，用于标出“对不上”的段落。 */
function mergeRanges(segments: Segment[]): Array<{ start: number; end: number; label: string }> {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const ranges: Array<{ start: number; end: number; label: string }> = [];
  for (const segment of sorted) {
    const last = ranges.at(-1);
    if (last && segment.start <= last.end + 0.05) {
      last.end = Math.max(last.end, segment.end);
    } else {
      ranges.push({ start: segment.start, end: segment.end, label: "未对齐" });
    }
  }
  return ranges;
}

/** 点击一侧片段时，求另一侧应一起定位的片段；已对齐用配对，否则取时间重叠最长者。 */
export function locateCounterpart(
  target: Segment,
  others: Segment[],
  pairedId: string | undefined,
): Segment | null {
  if (pairedId) {
    return others.find((segment) => segment.id === pairedId) ?? null;
  }
  let best: Segment | null = null;
  let bestOverlap = 0;
  for (const candidate of others) {
    const overlap = overlapSeconds(target, candidate);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = candidate;
    }
  }
  return best;
}
