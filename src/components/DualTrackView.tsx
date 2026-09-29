import { For, Index, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { ProjectData, Segment, Speaker, Tag, TranscriptTrack } from "../types";
import type { AlignmentResult } from "../alignment";
import { formatTime as defaultFormatTime } from "../persistence";

interface DualTrackViewProps {
  project: Accessor<ProjectData>;
  originalTrack: Accessor<TranscriptTrack | undefined>;
  revisionTrack: Accessor<TranscriptTrack | undefined>;
  alignment: Accessor<AlignmentResult>;
  tolerance: Accessor<number>;
  selectedRevisionId: Accessor<string>;
  focusedOriginalId: Accessor<string>;
  speakerById: (id: string) => Speaker | undefined;
  tagById: (id: string) => Tag | undefined;
  onSelectRevision: (segment: Segment) => void;
  onSelectOriginal: (segment: Segment) => void;
  onEditText: (id: string, text: string) => void;
  onSplit: (id: string, cursor: number) => void;
  onMerge: (id: string) => void;
  onToleranceChange: (seconds: number) => void;
  onAssignOriginal: (trackId: string) => void;
  onAssignRevision: (trackId: string) => void;
}

const RULER_HEIGHT = 36;

function tickInterval(scale: number) {
  const ideal = 120 / scale; // 秒
  const choices = [5, 10, 15, 30, 60, 120, 300];
  return choices.find((value) => value >= ideal) ?? 300;
}

export default function DualTrackView(props: DualTrackViewProps) {
  const [scale, setScale] = createSignal(4.5);
  const editorRefs = new Map<string, HTMLTextAreaElement>();

  const duration = createMemo(() => {
    const ends = [
      ...(props.originalTrack()?.segments ?? []),
      ...(props.revisionTrack()?.segments ?? []),
    ].map((segment) => segment.end);
    return Math.max(30, ...ends) + 4;
  });

  const timelineHeight = createMemo(() => duration() * scale());
  const trackWidth = createMemo(() => duration() * scale());
  const timelineWidth = createMemo(() => trackWidth() * 2 + 84);
  const interval = createMemo(() => tickInterval(scale()));
  const ticks = createMemo(() => {
    const result: number[] = [];
    for (let t = 0; t <= duration(); t += interval()) result.push(t);
    return result;
  });

  const originalMisaligned = createMemo(() => new Set(props.alignment().misalignedOriginal.map((segment) => segment.id)));
  const revisionMisaligned = createMemo(() => new Set(props.alignment().misalignedRevision.map((segment) => segment.id)));

  // 文本外部变化（撤销、导入）后重新撑高编辑框。
  const revisionSignature = createMemo(() => (props.revisionTrack()?.segments ?? []).map((segment) => `${segment.id}:${segment.text.length}`).join("|"));
  createEffect(() => {
    revisionSignature();
    queueMicrotask(() => editorRefs.forEach((el) => autoResize(el)));
  });

  // 点击或用快捷键移动选择时，让两侧片段一起滚动到视口中央。
  let revisionScrollReady = false;
  createEffect(() => {
    const id = props.selectedRevisionId();
    if (!id) return;
    if (!revisionScrollReady) {
      revisionScrollReady = true;
      return;
    }
    document.getElementById(`dual-revision-${id}`)?.scrollIntoView({ block: "center" });
  });
  let originalScrollReady = false;
  createEffect(() => {
    const id = props.focusedOriginalId();
    if (!id) return;
    if (!originalScrollReady) {
      originalScrollReady = true;
      return;
    }
    document.getElementById(`dual-original-${id}`)?.scrollIntoView({ block: "center" });
  });

  const blockStyle = (segment: Segment) => ({
    top: `${segment.start * scale()}px`,
    height: `${Math.max((segment.end - segment.start) * scale() - 6, 40)}px`,
  });

  const renderPills = (segment: Segment) => (
    <>
      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
    </>
  );

  const renderTags = (segment: Segment) => (
    <Show when={segment.tagIds.length}>
      <div class="dual-tags">
        <For each={segment.tagIds.map((id) => props.tagById(id)).filter(Boolean)}>
          {(tag) => <span style={{ "--tag-color": tag!.color } as Record<string, string>}>#{tag!.label}</span>}
        </For>
      </div>
    </Show>
  );

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div class="dual-console">
      <div class="dual-toolbar">
        <div class="dual-track-pickers">
          <label class="dual-picker">
            <span class="dual-picker-label original">原音轨 · 只读</span>
            <select value={props.originalTrack()?.id ?? ""} onChange={(event) => props.onAssignOriginal(event.currentTarget.value)}>
              <For each={props.project().tracks}>
                {(track) => <option value={track.id} disabled={track.id === props.revisionTrack()?.id}>{track.name}</option>}
              </For>
            </select>
          </label>
          <span class="dual-swap" aria-hidden="true">⇄</span>
          <label class="dual-picker">
            <span class="dual-picker-label revision">校订轨 · 可编辑</span>
            <select value={props.revisionTrack()?.id ?? ""} onChange={(event) => props.onAssignRevision(event.currentTarget.value)}>
              <For each={props.project().tracks}>
                {(track) => <option value={track.id} disabled={track.id === props.originalTrack()?.id}>{track.name}</option>}
              </For>
            </select>
          </label>
        </div>

        <div class="dual-toolbar-right">
          <div class="tolerance-control" title="起止时间偏差均不超过该值才算对齐；容差随草稿保存">
            <label for="align-tolerance">对齐容差</label>
            <button class="step-btn" onClick={() => props.onToleranceChange(Math.max(0, +(props.tolerance() - 0.1).toFixed(1)))} aria-label="减小容差">−</button>
            <input
              id="align-tolerance"
              type="number"
              min="0"
              step="0.1"
              value={props.tolerance()}
              onChange={(event) => props.onToleranceChange(Math.max(0, Number(event.currentTarget.value) || 0))}
            />
            <span class="tolerance-unit">秒</span>
            <button class="step-btn" onClick={() => props.onToleranceChange(+(props.tolerance() + 0.1).toFixed(1))} aria-label="增大容差">＋</button>
          </div>
          <div class="zoom-control" role="group" aria-label="时间轴缩放">
            <button class={scale() === 3 ? "active" : ""} onClick={() => setScale(3)}>紧凑</button>
            <button class={scale() === 4.5 ? "active" : ""} onClick={() => setScale(4.5)}>标准</button>
            <button class={scale() === 7 ? "active" : ""} onClick={() => setScale(7)}>舒展</button>
          </div>
        </div>
      </div>

      <div class="dual-countbar">
        <span class={`count-chip original ${props.alignment().misalignedOriginal.length ? "has-miss" : ""}`}>
          原音 {props.originalTrack()?.segments.length ?? 0} 段<b>·</b>
          <strong>{props.alignment().misalignedOriginal.length}</strong> 段未对齐
        </span>
        <span class={`count-chip revision ${props.alignment().misalignedRevision.length ? "has-miss" : ""}`}>
          校订 {props.revisionTrack()?.segments.length ?? 0} 段<b>·</b>
          <strong>{props.alignment().misalignedRevision.length}</strong> 段未对齐
        </span>
        <Show when={!props.alignment().misalignedOriginal.length && !props.alignment().misalignedRevision.length}>
          <span class="count-ok">两轨片段已全部对齐</span>
        </Show>
      </div>

      <div class="dual-mismatch-chips" role="list" aria-label="未对齐片段">
        <For each={props.alignment().misalignedOriginal}>
          {(segment) => (
            <button class="miss-chip original" role="listitem" onClick={() => props.onSelectOriginal(segment)}>
              <span class="miss-flag">原音</span>{defaultFormatTime(segment.start, false)}–{defaultFormatTime(segment.end, false)}
            </button>
          )}
        </For>
        <For each={props.alignment().misalignedRevision}>
          {(segment) => (
            <button class="miss-chip revision" role="listitem" onClick={() => props.onSelectRevision(segment)}>
              <span class="miss-flag">校订</span>{defaultFormatTime(segment.start, false)}–{defaultFormatTime(segment.end, false)}
            </button>
          )}
        </For>
      </div>

      <div class="dual-scroll">
        <div class="dual-ruler" style={{ height: `${RULER_HEIGHT}px`, width: `${timelineWidth()}px` }}>
          <div class="dual-col-head original">
            <span class="col-head-label">原音轨（只读）</span>
            <For each={ticks()}>{(tick) => <span class="ruler-tick" style={{ left: `${tick * scale()}px` }}>{defaultFormatTime(tick, false)}</span>}</For>
          </div>
          <div class="dual-gutter-head"><span class="gutter-head-label">对不上</span></div>
          <div class="dual-col-head revision">
            <span class="col-head-label">校订轨（可编辑）</span>
            <For each={ticks()}>{(tick) => <span class="ruler-tick" style={{ left: `${tick * scale()}px` }}>{defaultFormatTime(tick, false)}</span>}</For>
          </div>
        </div>

        <div class="dual-timeline" style={{ height: `${timelineHeight()}px`, width: `${timelineWidth()}px` }}>
          <svg class="dual-links" viewBox={`0 0 100 ${timelineHeight()}`} preserveAspectRatio="none" aria-hidden="true">
            <For each={props.alignment().mismatchRanges}>
              {(range) => (
                <rect
                  x="38"
                  y={range.start * scale()}
                  width="24"
                  height={Math.max((range.end - range.start) * scale(), 22)}
                  rx="5"
                  class="mismatch-rect"
                />
              )}
            </For>
            <For each={[...props.alignment().pairs.entries()]}>
              {([originalId, revisionSegment]) => {
                const original = props.originalTrack()?.segments.find((item) => item.id === originalId);
                if (!original) return null;
                const y1 = ((original.start + original.end) / 2) * scale();
                const y2 = ((revisionSegment.start + revisionSegment.end) / 2) * scale();
                return (
                  <g>
                    <circle cx="8" cy={y1} r="4" class="link-dot" />
                    <line x1="8" y1={y1} x2="92" y2={y2} class="link-line" />
                    <circle cx="92" cy={y2} r="4" class="link-dot" />
                  </g>
                );
              }}
            </For>
          </svg>

          <div class="dual-col original-col">
            <Index each={props.originalTrack()?.segments ?? []}>
              {(segment) => (
                <article
                  id={`dual-original-${segment().id}`}
                  class={`dual-block readonly ${originalMisaligned().has(segment().id) ? "misaligned" : "aligned"} ${props.focusedOriginalId() === segment().id ? "focused" : ""}`}
                  style={blockStyle(segment())}
                  onClick={() => props.onSelectOriginal(segment())}
                >
                  <div class="dual-block-rail" style={{ background: props.speakerById(segment().speakerId)?.color ?? "#64748b" }} />
                  <div class="dual-block-main">
                    <header>
                      <b>{props.speakerById(segment().speakerId)?.name ?? "未知"}</b>
                      <time>{defaultFormatTime(segment().start, false)}–{defaultFormatTime(segment().end, false)}</time>
                      <span class="lock-badge" title="原音轨只读">🔒</span>
                    </header>
                    <p class="dual-block-text">{segment().text}</p>
                    <footer>
                      <span class="dual-pills">{renderPills(segment())}</span>
                    </footer>
                    {renderTags(segment())}
                  </div>
                </article>
              )}
            </Index>
            <Show when={!props.originalTrack()?.segments.length}>
              <div class="dual-empty">原音轨还没有片段</div>
            </Show>
          </div>

          <div class="dual-col revision-col">
            <Index each={props.revisionTrack()?.segments ?? []}>
              {(segment, position) => (                <article
                  id={`dual-revision-${segment().id}`}
                  class={`dual-block editable ${revisionMisaligned().has(segment().id) ? "misaligned" : "aligned"} ${props.selectedRevisionId() === segment().id ? "focused" : ""}`}
                  style={blockStyle(segment())}
                  onClick={() => props.onSelectRevision(segment())}
                >
                  <div class="dual-block-rail" style={{ background: props.speakerById(segment().speakerId)?.color ?? "#64748b" }} />
                  <div class="dual-block-main">
                    <header>
                      <b>{position + 1}. {props.speakerById(segment().speakerId)?.name ?? "未知"}</b>
                      <time>{defaultFormatTime(segment().start, false)}–{defaultFormatTime(segment().end, false)}</time>
                      <span class="dual-block-actions">
                        <button
                          class="mini-btn"
                          title="按光标拆分（不影响原音轨）"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            event.stopPropagation();
                            const editor = editorRefs.get(`pos-${position}`);
                            props.onSplit(segment().id, editor?.selectionStart ?? Math.floor(segment().text.length / 2));
                          }}
                        >
                          ⌁
                        </button>
                        <button
                          class="mini-btn"
                          title="与下一段合并（不影响原音轨）"
                          disabled={position >= (props.revisionTrack()?.segments.length ?? 0) - 1}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => { event.stopPropagation(); props.onMerge(segment().id); }}
                        >
                          ⌄
                        </button>
                      </span>
                    </header>
                    <textarea
                      ref={(el) => { editorRefs.set(`pos-${position}`, el); queueMicrotask(() => autoResize(el)); }}
                      class="dual-block-input"
                      value={segment().text}
                      title={revisionMisaligned().has(segment().id) ? "与原音起止时间未对齐" : ""}
                      onFocus={() => props.onSelectRevision(segment())}
                      onChange={(event) => props.onEditText(segment().id, event.currentTarget.value)}
                      onInput={(event) => autoResize(event.currentTarget)}
                    />
                    <footer>
                      <span class={`confidence c${segment().confidence}`}>置信 {segment().confidence}/5</span>
                      <span class="dual-pills">{renderPills(segment())}</span>
                    </footer>
                    {renderTags(segment())}
                  </div>
                </article>
              )}
            </Index>
            <Show when={!props.revisionTrack()?.segments.length}>
              <div class="dual-empty">校订轨还没有片段</div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
