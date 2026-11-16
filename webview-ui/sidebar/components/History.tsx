/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import type { ConversationSummary, HistoryPanelSide } from "../types";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

export const HISTORY_WIDTH_DEFAULT = 280;
export const HISTORY_WIDTH_MIN = 180;
export const HISTORY_WIDTH_MAX = 640;
const RESIZE_STEP = 16;

export function clampHistoryWidth(width: number): number {
  if (!Number.isFinite(width)) return HISTORY_WIDTH_DEFAULT;
  return Math.round(Math.min(HISTORY_WIDTH_MAX, Math.max(HISTORY_WIDTH_MIN, width)));
}

/**
 * Docked conversation history. Lives beside the chat column (never over it) so the
 * user can keep browsing threads while reading; selecting a thread leaves it open.
 * The inner edge drags (or arrow-keys) to resize; double-click restores the default.
 */
export function HistoryPanel({
  list,
  activeId,
  side,
  width,
  onResize,
  onSelect,
  onDelete,
  onClose,
  onPin,
  onArchive,
  onFork,
  onSearch,
  results,
}: {
  list: ConversationSummary[];
  activeId?: string;
  side: HistoryPanelSide;
  /** Saved width in CSS pixels; the panel previews drags locally and commits on release. */
  width?: number;
  onResize?: (width: number) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onPin?: (id: string, pinned: boolean) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onFork?: (id: string) => void;
  onSearch?: (query: string, archived: boolean, requestId: number) => void;
  results?: { requestId: number; list: ConversationSummary[] };
}) {
  const [liveWidth, setLiveWidth] = React.useState(() => clampHistoryWidth(width ?? HISTORY_WIDTH_DEFAULT));
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => { setLiveWidth(clampHistoryWidth(width ?? HISTORY_WIDTH_DEFAULT)); }, [width]);
  const commitWidth = (next: number) => {
    const clamped = clampHistoryWidth(next);
    setLiveWidth(clamped);
    onResize?.(clamped);
  };
  // Dragging toward the chat grows the panel: rightward for a left panel, leftward for a right one.
  const direction = side === "right" ? -1 : 1;
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX, startWidth = liveWidth;
    let latest = startWidth;
    handle.setPointerCapture?.(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      latest = clampHistoryWidth(startWidth + (ev.clientX - startX) * direction);
      setLiveWidth(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDragging(false);
      if (latest !== startWidth) commitWidth(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = side === "right" ? "ArrowLeft" : "ArrowRight";
    const shrink = side === "right" ? "ArrowRight" : "ArrowLeft";
    const step = e.shiftKey ? RESIZE_STEP * 4 : RESIZE_STEP;
    if (e.key === grow) commitWidth(liveWidth + step);
    else if (e.key === shrink) commitWidth(liveWidth - step);
    else if (e.key === "Home") commitWidth(HISTORY_WIDTH_MIN);
    else if (e.key === "End") commitWidth(HISTORY_WIDTH_MAX);
    else return;
    e.preventDefault();
  };

  const [query, setQuery] = React.useState("");
  const [archived, setArchived] = React.useState(false);
  const [requestId, setRequestId] = React.useState(0);
  const searchRef = React.useRef(onSearch);
  searchRef.current = onSearch;

  React.useEffect(() => {
    const id = Date.now() + Math.random();
    setRequestId(id);
    const timer = setTimeout(() => searchRef.current?.(query, archived, id), 120);
    return () => clearTimeout(timer);
  }, [query, archived, list]);

  const filtered = results?.requestId === requestId ? results.list : archived ? [] : query
    ? list.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : list;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  // Archived threads never carry a pin, so the group only exists in the active view.
  const pinned = archived ? [] : filtered.filter((c) => c.pinnedAt);
  const rest = archived ? filtered : filtered.filter((c) => !c.pinnedAt);
  const groups = [
    { label: "Pinned", items: pinned },
    { label: "Today", items: rest.filter((c) => c.updatedAt >= today.getTime()) },
    { label: "Yesterday", items: rest.filter((c) => c.updatedAt >= yesterday.getTime() && c.updatedAt < today.getTime()) },
    { label: "Earlier", items: rest.filter((c) => c.updatedAt < yesterday.getTime()) },
  ];

  return (
    <aside className={"history-panel" + (dragging ? " resizing" : "")} data-side={side} aria-label="Conversation history"
      style={{ "--history-panel-width": `${liveWidth}px` } as React.CSSProperties}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="history-resizer" role="separator" aria-orientation="vertical" aria-label="Resize history panel"
        aria-valuemin={HISTORY_WIDTH_MIN} aria-valuemax={HISTORY_WIDTH_MAX} aria-valuenow={liveWidth} tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag} onKeyDown={onHandleKey} onDoubleClick={() => commitWidth(HISTORY_WIDTH_DEFAULT)} />
      <div className="history-heading">
        <span>Threads</span>
        <button className="btn-ghost" aria-pressed={archived} onClick={() => setArchived((value) => !value)}>{archived ? "Show active" : "Archived"}</button>
        <button className="history-close" title="Close history" aria-label="Close history" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <div className="history-search">
        <Icon name="search" size={14} />
        <input
          type="text"
          placeholder="Search titles and messages"
          aria-label="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="history-list">
        {filtered.length === 0 ? (
          <div className="history-empty">
            {list.length === 0 && !archived ? "No conversations yet." : "No results."}
          </div>
        ) : (
          groups.filter((group) => group.items.length > 0).map((group) => (
            <React.Fragment key={group.label}>
              <div className="history-group-label">{group.label}</div>
              {group.items.map((c) => {
                const isPinned = !!c.pinnedAt;
                // Search hits show the matching passage; otherwise remind what was asked.
                const detail = c.excerpt || (c.preview && c.preview !== c.title.replace(/…$/, "") ? c.preview : undefined);
                const tooltip = [c.title, c.preview && c.preview !== c.title ? c.preview : "", new Date(c.updatedAt).toLocaleString()].filter(Boolean).join("\n\n");
                return (
                  <div key={c.id} className={"history-item" + (c.id === activeId ? " active" : "") + (isPinned ? " pinned" : "")}>
                    <button className="hi-text" title={tooltip} aria-label={`Open ${c.title}`} aria-current={c.id === activeId ? "true" : undefined} onClick={() => onSelect(c.id)}>
                      <span className="hi-title">{c.title}</span>
                      {detail && <span className={c.excerpt ? "hi-excerpt" : "hi-excerpt hi-preview"}>{detail}</span>}
                      <span className="hi-time">{isPinned && <Icon name="pinFilled" size={10} />}{timeAgo(c.updatedAt)}</span>
                    </button>
                    <div className="hi-actions">
                    {onPin && !archived && (
                      <button className={"hi-del hi-pin" + (isPinned ? " on" : "")} title={isPinned ? "Unpin" : "Pin"} aria-label={`${isPinned ? "Unpin" : "Pin"} ${c.title}`} aria-pressed={isPinned}
                        onClick={() => onPin(c.id, !isPinned)}>
                        <Icon name={isPinned ? "pinFilled" : "pin"} size={14} />
                      </button>
                    )}
                    {onFork && <button className="hi-del" title="Fork conversation" aria-label="Fork conversation" onClick={() => onFork(c.id)}><Icon name="fork" size={14} /></button>}
                    {onArchive && <button className="hi-del" title={archived ? "Restore conversation" : "Archive conversation"} aria-label={archived ? "Restore conversation" : "Archive conversation"} onClick={() => onArchive(c.id, !archived)}>{archived ? <Icon name="reset" size={14} /> : <Icon name="archive" size={14} />}</button>}
                    <button
                      className="hi-del"
                      title="Delete conversation"
                      aria-label="Delete conversation"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
    </aside>
  );
}
