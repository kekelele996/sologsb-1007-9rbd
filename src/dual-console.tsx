import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { BLOCK_PAD, formatRulerTime, niceStep, type AlignmentModel, type ResolvedDual } from "./dual-track";
import { formatTime } from "./persistence";
import type { ProjectData, Segment, TranscriptTrack } from "./types";

interface DualConsoleProps {
  dual: ResolvedDual;
  alignment: AlignmentModel;
  project: ProjectData;
  selectedId: string;
  scale: number;
  onSelect: (id: string, side: "original" | "revision") => void;
  onChangeTolerance: (value: number) => void;
  onChangePairTrack: (side: "original" | "revision", trackId: string) => void;
  onChangeScale: (scale: number) => void;
}

interface BlockData {
  segment: Segment;
  top: number;
  height: number;
  aligned: boolean;
}

const MIN_BLOCK_HEIGHT = 34;

function speakerNameOf(project: ProjectData, speakerId: string) {
  return project.speakers.find((speaker) => speaker.id === speakerId)?.name ?? "未知";
}

function speakerColorOf(project: ProjectData, speakerId: string) {
  return project.speakers.find((speaker) => speaker.id === speakerId)?.color ?? "#64748b";
}

export function DualConsole(props: DualConsoleProps) {
  const [toleranceDraft, setToleranceDraft] = createSignal(String(props.dual.tolerance));
  const [gutterOffset, setGutterOffset] = createSignal(0);
  let originalScroll: HTMLDivElement | undefined;
  let revisionScroll: HTMLDivElement | undefined;
  let syncing = false;
  let firstRun = true;

  createEffect(() => setToleranceDraft(props.dual.tolerance.toFixed(2).replace(/\.?0+$/, "")));

  const trackHeight = createMemo(() => Math.max(props.alignment.duration * props.scale + BLOCK_PAD * 2 + 80, 320));

  const blocksOf = (track: TranscriptTrack, unaligned: Set<string>): BlockData[] =>
    track.segments.map((segment) => ({
      segment,
      top: segment.start * props.scale + BLOCK_PAD,
      height: Math.max(MIN_BLOCK_HEIGHT, (segment.end - segment.start) * props.scale - 6),
      aligned: !unaligned.has(segment.id),
    }));

  const originalBlocks = createMemo(() => blocksOf(props.dual.original, props.alignment.originalUnaligned));
  const revisionBlocks = createMemo(() => blocksOf(props.dual.revision, props.alignment.revisionUnaligned));

  const originalById = createMemo(() => new Map(props.dual.original.segments.map((segment) => [segment.id, segment])));
  const revisionById = createMemo(() => new Map(props.dual.revision.segments.map((segment) => [segment.id, segment])));

  const selectedOriginal = createMemo(() => originalById().get(props.selectedId));
  const selectedRevision = createMemo(() => revisionById().get(props.selectedId));

  const pairOfSelected = createMemo(() => {
    const link = props.alignment.pairs.find(
      (pair) => pair.originalId === props.selectedId || pair.revisionId === props.selectedId,
    );
    return link ?? null;
  });

  /** 点一侧片段时对侧一起定位（滚动+描边）的片段：精确配对优先，否则取时间重叠片段。 */
  const locateOriginalIds = createMemo<Set<string>>(() => {
    const selected = selectedRevision();
    if (!selected) return new Set([props.selectedId]);
    const link = props.alignment.pairs.find((pair) => pair.revisionId === selected.id);
    if (link) return new Set([link.originalId]);
    return new Set(
      props.dual.original.segments
        .filter((segment) => segment.end + props.dual.tolerance >= selected.start && segment.start - props.dual.tolerance <= selected.end)
        .map((segment) => segment.id),
    );
  });

  const locateRevisionIds = createMemo<Set<string>>(() => {
    const selected = selectedOriginal();
    if (!selected) return new Set([props.selectedId]);
    const link = props.alignment.pairs.find((pair) => pair.originalId === selected.id);
    if (link) return new Set([link.revisionId]);
    return new Set(
      props.dual.revision.segments
        .filter((segment) => segment.end + props.dual.tolerance >= selected.start && segment.start - props.dual.tolerance <= selected.end)
        .map((segment) => segment.id),
    );
  });

  const rulerTicks = createMemo(() => {
    const step = niceStep(props.scale);
    const ticks: { time: number }[] = [];
    for (let time = 0; time <= props.alignment.duration + 0.01; time += step) ticks.push({ time });
    return ticks;
  });

  const connectors = createMemo(() =>
    props.alignment.pairs
      .map((pair) => ({
        original: originalById().get(pair.originalId),
        revision: revisionById().get(pair.revisionId),
      }))
      .filter((item): item is { original: Segment; revision: Segment } => Boolean(item.original && item.revision)),
  );

  const commitTolerance = () => {
    const parsed = Number.parseFloat(toleranceDraft());
    props.onChangeTolerance(Number.isFinite(parsed) ? parsed : props.dual.tolerance);
  };

  const syncFrom = (source: HTMLDivElement, target: HTMLDivElement | undefined) => {
    setGutterOffset(source.scrollTop);
    if (!target || syncing) return;
    syncing = true;
    target.scrollTop = source.scrollTop;
    // 同步赋值会同步触发对侧 scroll 事件；等当前事件循环结束后再放行，避免回环与初始抖动。
    setTimeout(() => {
      syncing = false;
    }, 0);
  };

  const centerBlock = (scroller: HTMLDivElement | undefined, segment: Segment | undefined) => {
    if (!scroller || !segment) return;
    const top = segment.start * props.scale + BLOCK_PAD;
    const height = Math.max(MIN_BLOCK_HEIGHT, (segment.end - segment.start) * props.scale - 6);
    scroller.scrollTo({ top: top + height / 2 - scroller.clientHeight / 2, behavior: "smooth" });
  };

  // 选中片段变化时两侧一起定位。
  createEffect(() => {
    const selectedId = props.selectedId;
    void props.alignment;
    void props.scale;
    if (firstRun) {
      firstRun = false;
      return;
    }
    const anchorOriginal =
      originalById().get(selectedId) ?? props.dual.original.segments.find((segment) => locateOriginalIds().has(segment.id));
    const anchorRevision =
      revisionById().get(selectedId) ?? props.dual.revision.segments.find((segment) => locateRevisionIds().has(segment.id));
    centerBlock(originalScroll, anchorOriginal);
    centerBlock(revisionScroll, anchorRevision);
  });

  onMount(() => {
    const firstOriginal =
      props.dual.original.segments.find((segment) => !props.alignment.originalUnaligned.has(segment.id)) ??
      props.dual.original.segments[0];
    if (firstOriginal && originalScroll) {
      const initialTop = firstOriginal.start * props.scale - originalScroll.clientHeight / 2;
      originalScroll.scrollTop = initialTop;
      if (revisionScroll) revisionScroll.scrollTop = initialTop;
      setGutterOffset(initialTop);
    }
  });

  onCleanup(() => {
    syncing = false;
  });

  const zonesFor = (ranges: { start: number; end: number }[], variant: "original-only" | "revision-only") =>
    ranges.map((range) => ({
      ...range,
      top: range.start * props.scale + BLOCK_PAD,
      height: Math.max(6, (range.end - range.start) * props.scale),
      variant,
    }));

  const renderBlock = (
    block: BlockData,
    side: "original" | "revision",
    locateIds: Set<string>,
    selectedSegment: Segment | undefined,
  ) => {
    const isSelected = selectedSegment?.id === block.segment.id;
    const isLocated = locateIds.has(block.segment.id);
    const classes = [
      "dual-block",
      side === "original" ? "dual-block-readonly" : "dual-block-editable",
      isSelected ? "is-selected" : "",
      isLocated && !isSelected ? "is-located" : "",
      block.aligned ? "is-aligned" : "is-misaligned",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        type="button"
        class={classes}
        style={{
          top: `${block.top}px`,
          height: `${block.height}px`,
          "--speaker-color": speakerColorOf(props.project, block.segment.speakerId),
        }}
        aria-label={`${side === "original" ? "原音片段（只读）" : "校订片段"} ${formatTime(block.segment.start, false)}`}
        aria-pressed={isSelected}
        onClick={() => props.onSelect(block.segment.id, side)}
      >
        <span class="dual-block-time">
          {formatTime(block.segment.start, false)} – {formatTime(block.segment.end, false)}
          {side === "original" && <em class="dual-lock">只读</em>}
          {!block.aligned && <em class="dual-mismatch-tag">未对齐</em>}
        </span>
        <span class="dual-block-speaker">{speakerNameOf(props.project, block.segment.speakerId)}</span>
        <span class="dual-block-text">{block.segment.text}</span>
      </button>
    );
  };

  const renderRuler = () => (
    <div class="dual-ruler" aria-hidden="true">
      <For each={rulerTicks()}>
        {(tick) => (
          <span class="dual-ruler-tick" style={{ top: `${tick.time * props.scale + BLOCK_PAD}px` }}>
            <i />
            <b>{formatRulerTime(tick.time)}</b>
          </span>
        )}
      </For>
    </div>
  );

  const renderLane = (side: "original" | "revision") => {
    const isOriginal = side === "original";
    const track = isOriginal ? props.dual.original : props.dual.revision;
    const blocks = isOriginal ? originalBlocks() : revisionBlocks();
    const locateIds = isOriginal ? locateOriginalIds() : locateRevisionIds();
    const selectedSegment = isOriginal ? selectedOriginal() : selectedRevision();
    const zones = isOriginal
      ? zonesFor(props.alignment.originalOnly, "original-only")
      : zonesFor(props.alignment.revisionOnly, "revision-only");
    const unalignedCount = isOriginal
      ? props.alignment.originalUnaligned.size
      : props.alignment.revisionUnaligned.size;
    return (
      <section class={`dual-lane ${isOriginal ? "dual-lane-original" : "dual-lane-revision"}`}>
        <header class="dual-lane-head">
          <div class="dual-lane-title">
            <strong>{track.name}</strong>
            <small>
              {track.language} · {track.segments.length} 段
            </small>
          </div>
          <span class={`dual-count ${unalignedCount > 0 ? "has-mismatch" : "all-aligned"}`}>
            {unalignedCount > 0 ? `${unalignedCount} 段未对齐` : "全部对齐"}
          </span>
          {isOriginal && <span class="dual-readonly-badge" title="原音轨只读：拆分、合并与改时只作用于校订轨">🔒 只读</span>}
        </header>
        <div
          class="dual-lane-scroll"
          ref={isOriginal ? originalScroll : revisionScroll}
          onScroll={(event) => syncFrom(event.currentTarget, isOriginal ? revisionScroll : originalScroll)}
        >
          <div class="dual-lane-canvas" style={{ height: `${trackHeight()}px` }}>
            <div class="dual-zones" aria-hidden="true">
              <For each={zones}>
                {(zone) => (
                  <span
                    class={`dual-zone ${zone.variant}`}
                    style={{ top: `${zone.top}px`, height: `${zone.height}px` }}
                    title={`${formatTime(zone.start, false)} – ${formatTime(zone.end, false)} 对侧缺失`}
                  />
                )}
              </For>
            </div>
            {renderRuler()}
            <For each={blocks}>{(block) => renderBlock(block, side, locateIds, selectedSegment)}</For>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div class="dual-console">
      <div class="dual-toolbar">
        <div class="dual-pair-picker">
          <label>
            <span>原音（只读）</span>
            <select
              value={props.dual.original.id}
              onChange={(event) => props.onChangePairTrack("original", event.currentTarget.value)}
            >
              <For each={props.project.tracks.filter((track) => track.id !== props.dual.revision.id)}>
                {(track) => (
                  <option value={track.id}>{track.name}</option>
                )}
              </For>
            </select>
          </label>
          <span class="dual-pair-arrow" aria-hidden="true">
            ⇄
          </span>
          <label>
            <span>校订（可改）</span>
            <select
              value={props.dual.revision.id}
              onChange={(event) => props.onChangePairTrack("revision", event.currentTarget.value)}
            >
              <For each={props.project.tracks.filter((track) => track.id !== props.dual.original.id)}>
                {(track) => (
                  <option value={track.id}>{track.name}</option>
                )}
              </For>
            </select>
          </label>
        </div>

        <label class="dual-tolerance">
          <span>对齐容差</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={toleranceDraft()}
            onInput={(event) => setToleranceDraft(event.currentTarget.value)}
            onChange={commitTolerance}
            onBlur={commitTolerance}
          />
          <em>秒</em>
          <small>随草稿保存，重开仍生效</small>
        </label>

        <div class="dual-summary">
          <span class="dual-summary-item">
            <i class="dot-original" />
            原音未对齐 <b>{props.alignment.originalUnaligned.size}</b>
          </span>
          <span class="dual-summary-item">
            <i class="dot-revision" />
            校订未对齐{" "}
            <b class={props.alignment.revisionUnaligned.size > 0 ? "warn" : ""}>
              {props.alignment.revisionUnaligned.size}
            </b>
          </span>
          <Show when={pairOfSelected()}>
            <span class="dual-summary-paired">当前片段：已配对</span>
          </Show>
        </div>

        <div class="dual-zoom">
          <span>时间轴缩放</span>
          <button type="button" class="zoom-btn" onClick={() => props.onChangeScale(clampScale(props.scale / 1.25))} title="缩小">
            −
          </button>
          <span class="zoom-value">{Math.round(props.scale * 10)} px/秒</span>
          <button type="button" class="zoom-btn" onClick={() => props.onChangeScale(clampScale(props.scale * 1.25))} title="放大">
            ＋
          </button>
        </div>
      </div>

      <div class="dual-stage">
        {renderLane("original")}
        <div class="dual-gutter" aria-hidden="true">
          <svg class="dual-links" style={{ height: `${trackHeight()}px`, transform: `translateY(${-gutterOffset()}px)` }}>
            <For each={connectors()}>
              {(link) => {
                const active = link.original.id === props.selectedId || link.revision.id === props.selectedId;
                const originalEndY = Math.min(
                  link.original.end * props.scale + BLOCK_PAD - 4,
                  link.original.start * props.scale + BLOCK_PAD + MIN_BLOCK_HEIGHT - 4,
                );
                const revisionEndY = Math.min(
                  link.revision.end * props.scale + BLOCK_PAD - 4,
                  link.revision.start * props.scale + BLOCK_PAD + MIN_BLOCK_HEIGHT - 4,
                );
                return (
                  <g class={active ? "dual-link-active" : ""}>
                    <line
                      x1="0"
                      y1={link.original.start * props.scale + BLOCK_PAD + 4}
                      x2="100%"
                      y2={link.revision.start * props.scale + BLOCK_PAD + 4}
                      class="dual-link-line"
                    />
                    <line x1="0" y1={originalEndY} x2="100%" y2={revisionEndY} class="dual-link-line dual-link-end" />
                  </g>
                );
              }}
            </For>
          </svg>
        </div>
        {renderLane("revision")}
      </div>
    </div>
  );
}

function clampScale(scale: number) {
  return Math.min(30, Math.max(2, Math.round(scale * 10) / 10));
}
