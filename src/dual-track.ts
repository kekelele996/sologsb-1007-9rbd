import type { DualTrackConfig, ProjectData, Segment, TranscriptTrack } from "./types";

export const DEFAULT_TOLERANCE = 0.5;
export const MIN_TOLERANCE = 0;
export const MAX_TOLERANCE = 10;
export const BLOCK_PAD = 8;
export const RULER_HEIGHT = 30;
const GAP_EPS = 0.25;

export interface TimeRange {
  start: number;
  end: number;
}

/** 已解析的双轨配置：任一侧轨道缺失时返回 null，调用方回退到单轨视图。 */
export interface ResolvedDual {
  config: DualTrackConfig;
  original: TranscriptTrack;
  revision: TranscriptTrack;
  tolerance: number;
}

export function clampTolerance(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TOLERANCE;
  return Math.min(MAX_TOLERANCE, Math.max(MIN_TOLERANCE, Math.round(value * 100) / 100));
}

export function resolveDual(project: ProjectData, config: DualTrackConfig | null): ResolvedDual | null {
  if (!config) return null;
  const original = project.tracks.find((track) => track.id === config.originalTrackId);
  const revision = project.tracks.find((track) => track.id === config.revisionTrackId);
  if (!original || !revision || original.id === revision.id) return null;
  return {
    config,
    original,
    revision,
    tolerance: clampTolerance(config.toleranceSec),
  };
}

/** 首次进入双轨台时挑选默认轨道：按名称识别普通话校订轨与方言原音轨，找不到则取后两条。 */
export function defaultDualConfig(project: ProjectData): DualTrackConfig | null {
  const tracks = project.tracks;
  if (tracks.length < 2) return null;
  const dialectIndex = tracks.findIndex((track) => track.language.includes("福州") || track.name.includes("方言") || track.name.includes("原音"));
  const mandarinIndex = tracks.findIndex((track) => track.language === "普通话" || track.name.includes("普通话"));
  const originalIndex = dialectIndex >= 0 ? dialectIndex : tracks.length - 1;
  let revisionIndex = mandarinIndex >= 0 ? mandarinIndex : tracks.length - 2;
  if (revisionIndex === originalIndex) {
    revisionIndex = tracks.findIndex((track, index) => index !== originalIndex);
  }
  if (revisionIndex < 0 || originalIndex < 0) return null;
  return {
    originalTrackId: tracks[originalIndex].id,
    revisionTrackId: tracks[revisionIndex].id,
    toleranceSec: DEFAULT_TOLERANCE,
  };
}

/** 两侧起止差均在容差内才算同一时间点的片段对。 */
export function isPaired(a: Segment, b: Segment, tolerance: number) {
  return Math.abs(a.start - b.start) <= tolerance && Math.abs(a.end - b.end) <= tolerance;
}

export interface PairLink {
  originalId: string;
  revisionId: string;
}

export interface AlignmentModel {
  pairs: PairLink[];
  /** 原音轨中没有任何容差内配对的片段 id */
  originalUnaligned: Set<string>;
  /** 校订轨中没有任何容差内配对的片段 id */
  revisionUnaligned: Set<string>;
  /** 原音覆盖、校订缺失的时间区间 */
  originalOnly: TimeRange[];
  /** 校订覆盖、原音缺失的时间区间 */
  revisionOnly: TimeRange[];
  duration: number;
}

function greedyPairs(a: Segment[], b: Segment[], tolerance: number): PairLink[] {
  const usedB = new Set<number>();
  const pairs: PairLink[] = [];
  for (const segmentA of a) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < b.length; index += 1) {
      if (usedB.has(index)) continue;
      const segmentB = b[index];
      if (!isPaired(segmentA, segmentB, tolerance)) continue;
      const distance = Math.abs(segmentA.start - segmentB.start) + Math.abs(segmentA.end - segmentB.end);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      usedB.add(bestIndex);
      pairs.push({ originalId: segmentA.id, revisionId: b[bestIndex].id });
    }
  }
  return pairs;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.end - range.start > GAP_EPS)
    .sort((left, right) => left.start - right.start);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start - previous.end <= GAP_EPS) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** covered 内没有被 any 中任意片段（含容差外扩）覆盖的时间区间。 */
function uncoveredRanges(covered: Segment[], any: Segment[], tolerance: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const segment of covered) {
    let cursor = segment.start;
    const expanded = any
      .map((other) => ({ start: other.start - tolerance, end: other.end + tolerance }))
      .filter((range) => range.end > segment.start && range.start < segment.end)
      .sort((a, b) => a.start - b.start);
    for (const coveredRange of expanded) {
      if (coveredRange.start > cursor) {
        ranges.push({ start: cursor, end: Math.min(coveredRange.start, segment.end) });
      }
      cursor = Math.max(cursor, coveredRange.end);
      if (cursor >= segment.end) break;
    }
    if (cursor < segment.end) ranges.push({ start: cursor, end: segment.end });
  }
  return mergeRanges(ranges);
}

export function buildAlignment(dual: ResolvedDual): AlignmentModel {
  const originalSegments = dual.original.segments;
  const revisionSegments = dual.revision.segments;
  const pairs = greedyPairs(originalSegments, revisionSegments, dual.tolerance);
  const pairedOriginal = new Set(pairs.map((pair) => pair.originalId));
  const pairedRevision = new Set(pairs.map((pair) => pair.revisionId));

  return {
    pairs,
    originalUnaligned: new Set(originalSegments.filter((segment) => !pairedOriginal.has(segment.id)).map((segment) => segment.id)),
    revisionUnaligned: new Set(revisionSegments.filter((segment) => !pairedRevision.has(segment.id)).map((segment) => segment.id)),
    originalOnly: uncoveredRanges(originalSegments, revisionSegments, dual.tolerance),
    revisionOnly: uncoveredRanges(revisionSegments, originalSegments, dual.tolerance),
    duration: Math.max(10, ...originalSegments.map((segment) => segment.end), ...revisionSegments.map((segment) => segment.end)),
  };
}

/** 时间重叠（含容差）即算“对侧定位”目标；精确配对由对齐模型另行给出。 */
export function overlappingIds(segment: Segment | undefined, candidates: Segment[], tolerance: number): Set<string> {
  const ids = new Set<string>();
  if (!segment) return ids;
  for (const candidate of candidates) {
    if (candidate.end + tolerance >= segment.start && candidate.start - tolerance <= segment.end) ids.add(candidate.id);
  }
  return ids;
}

export function niceStep(scale: number) {
  const targetPx = 96;
  const targetSec = targetPx / scale;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step >= targetSec) ?? 600;
}

export function formatRulerTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
