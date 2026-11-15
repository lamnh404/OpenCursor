/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryPanel } from "./History";
import type { ConversationSummary } from "../types";

let root: Root, container: HTMLDivElement;
const handlers = { onSelect: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(), onPin: vi.fn(), onArchive: vi.fn(), onFork: vi.fn() };
const now = Date.now();
const list: ConversationSummary[] = [
  { id: "pinned-old", title: "Pinned but old", updatedAt: now - 3 * 86_400_000, pinnedAt: now - 1000 },
  { id: "recent", title: "Recent thread", updatedAt: now - 60_000 },
  { id: "older", title: "Older thread", updatedAt: now - 2 * 86_400_000 },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const render = (props: Partial<React.ComponentProps<typeof HistoryPanel>> = {}) =>
  act(() => root.render(<HistoryPanel list={list} activeId="recent" side="right" {...handlers} {...props} />));
const labels = () => Array.from(container.querySelectorAll(".history-group-label")).map((el) => el.textContent);
const titles = () => Array.from(container.querySelectorAll(".hi-title")).map((el) => el.textContent);
const click = (el: Element | null) => act(() => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

it("docks on the requested side and groups pinned threads first", async () => {
  await render();
  const panel = container.querySelector<HTMLElement>(".history-panel")!;
  expect(panel.dataset.side).toBe("right");
  expect(labels()).toEqual(["Pinned", "Today", "Earlier"]);
  expect(titles()[0]).toBe("Pinned but old");
  expect(container.querySelector(".history-item.active .hi-title")?.textContent).toBe("Recent thread");
});

it("keeps the panel open after selecting a thread", async () => {
  await render();
  click(container.querySelector('[aria-label="Open Older thread"]'));
  expect(handlers.onSelect).toHaveBeenCalledWith("older");
  expect(handlers.onClose).not.toHaveBeenCalled();
});

it("pins, unpins and closes through dedicated controls", async () => {
  await render();
  click(container.querySelector('[aria-label="Pin Recent thread"]'));
  expect(handlers.onPin).toHaveBeenCalledWith("recent", true);
  click(container.querySelector('[aria-label="Unpin Pinned but old"]'));
  expect(handlers.onPin).toHaveBeenCalledWith("pinned-old", false);
  click(container.querySelector('[aria-label="Close history"]'));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("hides the pinned group while browsing archived threads", async () => {
  await render({ list: [], results: undefined });
  click(container.querySelector('[aria-pressed]'));
  expect(labels()).toEqual([]);
  expect(container.querySelector('[aria-label^="Pin "]')).toBeNull();
});
