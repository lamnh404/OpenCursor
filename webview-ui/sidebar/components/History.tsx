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

/**
 * Docked conversation history. Lives beside the chat column (never over it) so the
 * user can keep browsing threads while reading; selecting a thread leaves it open.
 */
export function HistoryPanel({
  list,
  activeId,
  side,
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
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onPin?: (id: string, pinned: boolean) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onFork?: (id: string) => void;
  onSearch?: (query: string, archived: boolean, requestId: number) => void;
  results?: { requestId: number; list: ConversationSummary[] };
}) {
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
    <aside className="history-panel" data-side={side} aria-label="Conversation history"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
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
                return (
                  <div key={c.id} className={"history-item" + (c.id === activeId ? " active" : "") + (isPinned ? " pinned" : "")}>
                    <button className="hi-text" aria-label={`Open ${c.title}`} aria-current={c.id === activeId ? "true" : undefined} onClick={() => onSelect(c.id)}>
                      <span className="hi-title">{c.title}</span>
                      <span className="hi-time">{timeAgo(c.updatedAt)}</span>
                      {c.excerpt && <span className="hi-excerpt">{c.excerpt}</span>}
                    </button>
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
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
    </aside>
  );
}
