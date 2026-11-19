/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { pendingChanges, type ChangeScope, type PendingChange } from "../stores/pendingChanges";
import { computeHunks, lineEdits, mapLineForward, revertOnto, withoutHunk, type Hunk } from "../shared/lineDiff";
import { reviewMarks } from "../shared/reviewMarks";
import { safePath } from "../context/workspaceUtils";
import { createHash } from "node:crypto";

const SCHEME = "ocursor-inline-original";
const ORIGINALS = new Map<string, string>();
const originalsChanged = new vscode.EventEmitter<vscode.Uri>();

interface DiffEntry { path: string; scope?: ChangeScope; snapshotId?: string }
function snapshotId(change: PendingChange): string {
  return createHash("sha256").update(JSON.stringify([change.before, change.after, change.owner])).digest("hex");
}
function beforeUriFor(entry: DiffEntry, side = "before"): vscode.Uri {
  // Build via `from` rather than `parse`: a path like `/workspace/lib/a.ts`
  // would otherwise be parsed as an authority ("//workspace").
  const p = entry.path.replace(/\\/g, "/");
  const query = new URLSearchParams({ side, ...(entry.scope ? { conversation: entry.scope.conversationId, snapshot: entry.snapshotId! } : { overview: "all-pending" }) }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: p.startsWith("/") ? p : `/${p}`, query });
}

function fileUriFor(relPath: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.file(safePath(relPath));
  } catch {
    return undefined;
  }
}

// The review opens VS Code's normal diff editor and honours the user's own
// `diffEditor.renderSideBySide` preference; we never write editor settings.

/** Push the latest "before" text into an already-open diff without touching tabs. */
function changeForDiff(entry: DiffEntry) {
  return entry.scope ? pendingChanges.snapshots(entry.path, entry.scope).find(change => snapshotId(change) === entry.snapshotId) : pendingChanges.get(entry.path);
}
function refreshOriginal(entry: DiffEntry) {
  const change = changeForDiff(entry);
  if (!change) return false;
  // Firing makes VS Code re-read the virtual document and recompute the diff,
  // so only announce content that actually changed.
  const publish = (uri: vscode.Uri, text: string) => {
    const key = uri.toString();
    if (ORIGINALS.get(key) === text) return;
    ORIGINALS.set(key, text);
    originalsChanged.fire(uri);
  };
  publish(beforeUriFor(entry), change.before);
  if (entry.scope) publish(beforeUriFor(entry, "after"), change.after);
  return true;
}

/** Open the inline diff for a tracked change. Only ever called from an explicit user action. */
async function showInlineDiff(relPath: string, preserveFocus = true, scope?: ChangeScope) {
  const fileUri = fileUriFor(relPath);
  if (!fileUri) return;
  const entry: DiffEntry = { path: fileUri.fsPath, scope: scope ? { ...scope } : undefined };
  let label = "all pending changes";
  if (scope) {
    const snapshots = pendingChanges.snapshots(entry.path, scope);
    if (!snapshots.length) return;
    const selected = snapshots.length === 1 ? { change: snapshots[0], index: 0 } : await vscode.window.showQuickPick(snapshots.map((change, index) => ({
      label: `Edit ${index + 1}`, description: `Chat ${scope.conversationId.slice(0, 8)}${change.owner?.turnIndex === undefined ? "" : ` · turn ${change.owner.turnIndex + 1}`}`,
      detail: change.owner?.runId ? `Run ${change.owner.runId}` : undefined, change, index,
    })), { placeHolder: "Choose this conversation's edit to review" });
    if (!selected) return;
    entry.snapshotId = snapshotId(selected.change);
    label = `chat ${scope.conversationId.slice(0, 8)} · edit ${selected.index + 1}${selected.change.owner?.turnIndex === undefined ? "" : ` · turn ${selected.change.owner.turnIndex + 1}`}`;
  }
  if (!refreshOriginal(entry)) return;
  const before = beforeUriFor(entry);
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    scope ? beforeUriFor(entry, "after") : fileUri,
    `${relPath.split(/[\\/]/).pop()} (${label})`,
    { preserveFocus, preview: false, viewColumn: vscode.ViewColumn.Active }
  );
  openDiffs.set(before.toString(), entry);
}

/**
 * Open the real file (not a diff) so review happens in place: highlights and
 * per-block Accept/Reject lenses are already drawn on file editors. Scrolls to
 * the first agent block.
 */
async function openChangedFile(relPath: string) {
  const fileUri = fileUriFor(relPath);
  if (!fileUri) return;
  const document = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const change = pendingChanges.get(fileUri.fsPath);
  const first = change && !change.previewOnly ? computeHunks(change.before, change.after)[0] : undefined;
  if (!first) return;
  const lastLine = Math.max(document.lineCount - 1, 0);
  const line = Math.min(mapLineForward(change!.after, document.getText(), first.startLine), lastLine);
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Close any inline-diff tab we opened for `relPath`. */
async function closeInlineDiff(entry: DiffEntry) {
  const target = beforeUriFor(entry).toString();
  const doomed: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.original.toString() === target) doomed.push(tab);
    }
  }
  if (doomed.length) await vscode.window.tabGroups.close(doomed, true);
  ORIGINALS.delete(target);
  ORIGINALS.delete(beforeUriFor(entry, "after").toString());
}

/**
 * Inline diff for when the file is opened as a normal editor rather than
 * through the diff editor (which draws its own colours). VS Code cannot insert
 * real lines, so deleted text is drawn as struck-through red annotations.
 */
const ADDED_LINE = new vscode.ThemeColor("diffEditor.insertedLineBackground");
const ADDED_TEXT = new vscode.ThemeColor("diffEditor.insertedTextBackground");
const REMOVED_TEXT = new vscode.ThemeColor("diffEditor.removedTextBackground");
const REMOVED_FG = new vscode.ThemeColor("gitDecoration.deletedResourceForeground");
const addedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: ADDED_LINE,
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
  borderWidth: "0 0 0 3px",
  borderStyle: "solid",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});
const modifiedLineDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  borderColor: new vscode.ThemeColor("editorGutter.modifiedBackground"),
  borderWidth: "0 0 0 3px",
  borderStyle: "solid",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});
const addedWordsDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: ADDED_TEXT, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
const removedTextDecoration = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});
const reviewDecorations = [addedDecoration, modifiedLineDecoration, addedWordsDecoration, removedTextDecoration];

const MAX_REMOVED_PREVIEW = 160;
function removedPreview(lines: string[]): string {
  const text = lines.map(line => line.trim()).join("  ⏎  ");
  return text.length > MAX_REMOVED_PREVIEW ? `${text.slice(0, MAX_REMOVED_PREVIEW)}…` : text;
}
function removedHover(lines: string[]): vscode.MarkdownString {
  const fence = "`".repeat(Math.max(3, ...lines.map(line => (line.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 0))));
  return new vscode.MarkdownString(`**Removed by the agent**\n\n${fence}diff\n${lines.map(line => `- ${line}`).join("\n")}\n${fence}`);
}
function removedAttachment(text: string, spaced: boolean): vscode.ThemableDecorationAttachmentRenderOptions {
  return { contentText: text, backgroundColor: REMOVED_TEXT, color: REMOVED_FG, textDecoration: "line-through", margin: spaced ? "0 0 0 2em" : undefined };
}

/** Pending changes by editor path, rebuilt only when the pending set changes. */
let changesByPath: Map<string, PendingChange> | undefined;
function pendingByPath(): Map<string, PendingChange> {
  if (!changesByPath) {
    changesByPath = new Map();
    for (const change of pendingChanges.list()) {
      const uri = fileUriFor(change.path);
      if (uri && !changesByPath.has(uri.fsPath)) changesByPath.set(uri.fsPath, change);
    }
  }
  return changesByPath;
}

/** Map an open editor to the pending change (if any) covering its document. */
function changeForEditor(editor: vscode.TextEditor) {
  return pendingByPath().get(editor.document.uri.fsPath);
}

/** Editors we painted, so ones without a change are cleared once rather than on every refresh. */
const decorated = new WeakSet<vscode.TextEditor>();
function refreshEditor(editor: vscode.TextEditor) {
  const change = changeForEditor(editor);
  if (!change || change.previewOnly) {
    if (decorated.has(editor)) { for (const type of reviewDecorations) editor.setDecorations(type, []); decorated.delete(editor); }
    return;
  }
  decorated.add(editor);
  // Marks follow the agent's lines through the live text so the user's own
  // unrelated edits are never painted as agent changes.
  const document = editor.document;
  const marks = reviewMarks(change.before, change.after, document.getText());
  const lastLine = Math.max(document.lineCount - 1, 0);
  const lineRange = (line: number) => new vscode.Range(line, 0, line, document.lineAt(line).text.length);
  const added: vscode.Range[] = [], modified: vscode.Range[] = [], words: vscode.Range[] = [], removed: vscode.DecorationOptions[] = [];
  for (const line of marks.addedLines) if (line <= lastLine) added.push(lineRange(line));
  for (const mark of marks.modifiedLines) {
    if (mark.line > lastLine) continue;
    modified.push(lineRange(mark.line));
    for (const [start, end] of mark.added) words.push(new vscode.Range(mark.line, start, mark.line, end));
    for (const old of mark.removed) {
      removed.push({ range: new vscode.Range(mark.line, old.column, mark.line, old.column), hoverMessage: removedHover([old.text]), renderOptions: { before: removedAttachment(old.text, false) } });
    }
  }
  for (const removal of marks.removals) {
    if (removal.line > lastLine) continue;
    const end = document.lineAt(removal.line).text.length;
    const below = removal.placement === "below";
    removed.push({
      range: new vscode.Range(removal.line, below ? end : 0, removal.line, below ? end : 0),
      hoverMessage: removedHover(removal.lines),
      renderOptions: below ? { after: removedAttachment(removedPreview(removal.lines), true) } : { before: removedAttachment(`${removedPreview(removal.lines)}  `, false) },
    });
  }
  editor.setDecorations(addedDecoration, added);
  editor.setDecorations(modifiedLineDecoration, modified);
  editor.setDecorations(addedWordsDecoration, words);
  editor.setDecorations(removedTextDecoration, removed);
}

/** Lets editor title actions appear only on files with pending agent edits. */
const CHANGED_FILES_CONTEXT = "ocursor.agentChangedFiles";
let publishedContext: string | undefined;
function publishChangedFilesContext() {
  const paths = [...pendingByPath().keys()];
  const key = paths.join("\n");
  if (key === publishedContext) return;
  publishedContext = key;
  void vscode.commands.executeCommand("setContext", CHANGED_FILES_CONTEXT, paths);
}

function editorFilePath(uri?: vscode.Uri): string | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  return target?.scheme === "file" ? target.fsPath : undefined;
}

/**
 * Rejection works on disk, so unsaved typing in the file must be saved first;
 * otherwise the store would refuse to touch a dirty document.
 */
async function ensureSaved(paths: string[]): Promise<boolean> {
  const dirty = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === "file" && paths.includes(doc.uri.fsPath));
  if (!dirty.length) return true;
  const choice = await vscode.window.showWarningMessage(
    `Save your unsaved edits in ${dirty.length === 1 ? dirty[0].uri.fsPath.split(/[\\/]/).pop() : `${dirty.length} files`} before rejecting the agent's changes? Your edits are kept.`,
    { modal: true }, "Save and Reject");
  if (choice !== "Save and Reject") return false;
  for (const doc of dirty) if (!await doc.save()) return false;
  return true;
}

async function runReviewAction(action: () => Promise<void>) {
  try { await action(); }
  catch (error) { void vscode.window.showErrorMessage(`OpenCursor: ${error instanceof Error ? error.message : String(error)}`); }
}

function pendingPathFor(uri?: vscode.Uri): string | undefined {
  const file = editorFilePath(uri);
  return file ? pendingByPath().get(file)?.path : undefined;
}

/**
 * Accept/Reject links above each agent block. Block indexes match the store's
 * unscoped hunks (first original → latest agent text); the agent-side start
 * line travels with the command so a click on a stale lens is refused rather
 * than applied to a different block.
 */
const codeLensesChanged = new vscode.EventEmitter<void>();
const IS_MAC = process.platform === "darwin";
// Labels must match the `keybindings` contributed in package.json.
const KEEP_KEY = IS_MAC ? "⌘Y" : "Ctrl+Alt+Y";
const UNDO_KEY = IS_MAC ? "⌘N" : "Ctrl+Alt+N";

interface LiveBlock { hunk: Hunk; index: number; startLine: number; endLine: number }
/** Agent blocks located in the live document text (which may include the user's own edits). */
function liveBlocks(change: PendingChange, document: vscode.TextDocument): LiveBlock[] {
  const text = document.getText();
  const lastLine = Math.max(document.lineCount - 1, 0);
  return computeHunks(change.before, change.after).map((hunk, index) => {
    const startLine = Math.min(mapLineForward(change.after, text, hunk.startLine), lastLine);
    // Pure deletions have no agent lines; anchor them to the line they sit on.
    return { hunk, index, startLine, endLine: Math.min(startLine + Math.max(hunk.afterLines.length, 1) - 1, lastLine) };
  });
}

const blockLenses: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: codeLensesChanged.event,
  provideCodeLenses(document) {
    if (document.uri.scheme !== "file") return [];
    const change = pendingByPath().get(document.uri.fsPath);
    if (!change || change.previewOnly) return [];
    const blocks = liveBlocks(change, document);
    return blocks.flatMap(({ hunk, index, startLine }) => {
      const range = new vscode.Range(startLine, 0, startLine, 0);
      const args = [change.path, index, hunk.startLine];
      // CodeLens text can't be coloured, so the emoji markers carry the colour.
      const lenses = [
        new vscode.CodeLens(range, { title: `🟩 $(check) Keep ${KEEP_KEY}`, tooltip: "Keep this agent change", command: "ocursor.acceptBlock", arguments: args }),
        new vscode.CodeLens(range, { title: `🟥 $(discard) Undo ${UNDO_KEY}`, tooltip: "Undo this agent change", command: "ocursor.rejectBlock", arguments: args }),
      ];
      if (blocks.length > 1) {
        lenses.push(
          new vscode.CodeLens(range, { title: "$(arrow-down) Next", tooltip: "Go to the next agent change", command: "ocursor.nextBlock", arguments: [document.uri, index] }),
          new vscode.CodeLens(range, { title: `${index + 1}/${blocks.length}`, tooltip: "Agent changes in this file", command: "" }),
        );
      }
      return lenses;
    });
  },
};

function blockAtCursor(editor: vscode.TextEditor | undefined): { change: PendingChange; block: LiveBlock } | undefined {
  if (!editor || editor.document.uri.scheme !== "file") return undefined;
  const change = changeForEditor(editor);
  if (!change || change.previewOnly) return undefined;
  const line = editor.selection.active.line;
  const block = liveBlocks(change, editor.document).find(b => line >= b.startLine && line <= b.endLine);
  return block && { change, block };
}

/** Scopes the Keep/Undo shortcuts to the cursor sitting inside an agent block. */
const IN_BLOCK_CONTEXT = "ocursor.cursorInAgentBlock";
let publishedInBlock: boolean | undefined;
function publishCursorContext() {
  const inBlock = !!blockAtCursor(vscode.window.activeTextEditor);
  if (inBlock === publishedInBlock) return;
  publishedInBlock = inBlock;
  void vscode.commands.executeCommand("setContext", IN_BLOCK_CONTEXT, inBlock);
}

function reviewBlockAtCursor(reject: boolean) {
  const found = blockAtCursor(vscode.window.activeTextEditor);
  if (!found) return;
  return reviewBlock(found.change.path, found.block.index, found.block.hunk.startLine, reject);
}

/** Move to the agent block after `fromIndex` (or after the cursor), wrapping around. */
function revealNextBlock(uri?: vscode.Uri, fromIndex?: number) {
  const editor = uri ? vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString()) : vscode.window.activeTextEditor;
  if (!editor) return;
  const change = changeForEditor(editor);
  if (!change || change.previewOnly) return;
  const blocks = liveBlocks(change, editor.document);
  if (!blocks.length) return;
  const line = editor.selection.active.line;
  const target = fromIndex !== undefined ? blocks[(fromIndex + 1) % blocks.length] : blocks.find(b => b.startLine > line) ?? blocks[0];
  const position = new vscode.Position(target.startLine, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function blockStillCurrent(path: string, index: number, startLine: number): boolean {
  const change = pendingChanges.get(path);
  const current = change && !change.previewOnly && computeHunks(change.before, change.after)[index]?.startLine === startLine;
  if (!current) void vscode.window.showInformationMessage("OpenCursor: the agent's changes in this file were updated. Try again on the refreshed block.");
  return !!current;
}

/**
 * Undo one agent block inside an open editor's buffer. Used when the file has
 * unsaved typing: the edit is a normal undoable change to the buffer, and the
 * user's other unsaved work is left exactly as it was (still unsaved).
 */
async function undoBlockInEditor(document: vscode.TextDocument, change: PendingChange, index: number): Promise<"done" | "conflict" | "failed"> {
  const hunk = computeHunks(change.before, change.after)[index];
  if (!hunk) return "failed";
  const current = document.getText();
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? current.replace(/\r\n/g, "\n") : current;
  const merged = revertOnto(withoutHunk(change.after, hunk), change.after, normalized);
  if (merged === null) return "conflict";
  const edit = new vscode.WorkspaceEdit();
  for (const { start, end, text } of lineEdits(normalized, merged)) {
    const toOffset = (offset: number) => eol === "\r\n" ? offset + (normalized.slice(0, offset).match(/\n/g)?.length ?? 0) : offset;
    edit.replace(document.uri, new vscode.Range(document.positionAt(toOffset(start)), document.positionAt(toOffset(end))), eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
  }
  return await vscode.workspace.applyEdit(edit) ? "done" : "failed";
}

async function reviewBlock(path: string, index: number, startLine: number, reject: boolean) {
  await runReviewAction(async () => {
    if (!blockStillCurrent(path, index, startLine)) return;
    if (!reject) return pendingChanges.acceptHunk(path, index);
    const uri = fileUriFor(path);
    const document = uri && vscode.workspace.textDocuments.find(doc => doc.uri.scheme === "file" && doc.uri.fsPath === uri.fsPath);
    if (!document?.isDirty) return pendingChanges.rejectHunk(path, index);
    const change = pendingChanges.get(path)!;
    const result = await undoBlockInEditor(document, change, index);
    if (result === "conflict") throw new Error("Cannot undo this block: its lines were edited after the agent. Your text was preserved.");
    if (result === "failed") throw new Error("Could not undo this block in the editor. Your text was preserved.");
    await pendingChanges.rejectHunk(path, index, undefined, { appliedInEditor: true });
  });
}

let refreshTimer: NodeJS.Timeout | undefined;
/** Paths we currently have an inline-diff tab open for. */
const openDiffs = new Map<string, DiffEntry>();

/**
 * Never opens or focuses anything. Agent edits only refresh the content of
 * diffs the user opened themselves, close ones whose change is gone, and
 * repaint changed-line highlights in already-visible editors.
 */
async function sync() {
  for (const [key, entry] of [...openDiffs]) {
    if (!changeForDiff(entry)) {
      openDiffs.delete(key);
      await closeInlineDiff(entry);
    } else {
      // Update the virtual "before" document in place — no vscode.diff call,
      // so an edit can never pull the editor onto a diff tab.
      refreshOriginal(entry);
    }
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme === "file") refreshEditor(editor);
  }
  publishChangedFilesContext();
  publishCursorContext();
  codeLensesChanged.fire();
}

function scheduleSync() {
  changesByPath = undefined;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void sync(), 80);
}

/**
 * Typing only moves highlights in the edited document. Diff originals depend on
 * the pending snapshot, not the live text, so keystrokes never refresh them.
 */
let typingTimer: NodeJS.Timeout | undefined;
const typedDocuments = new Set<vscode.TextDocument>();
function scheduleHighlights(document: vscode.TextDocument) {
  typedDocuments.add(document);
  if (typingTimer) return;
  typingTimer = setTimeout(() => {
    typingTimer = undefined;
    const documents = new Set(typedDocuments);
    typedDocuments.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      if (documents.has(editor.document)) refreshEditor(editor);
    }
  }, 150);
}

/** Register the inline diff view, its virtual original-content provider, and highlights. */
export function registerInlineReview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: originalsChanged.event,
      provideTextDocumentContent: (uri) => ORIGINALS.get(uri.toString()) ?? "",
    }),
    vscode.commands.registerCommand("ocursor.viewDiff", async (path: string, scope?: ChangeScope) => {
      await showInlineDiff(path, false, scope);
    }),
    vscode.commands.registerCommand("ocursor.openChangedFile", (path: string) => openChangedFile(path)),
    // Editor title actions receive the editor's URI; the palette falls back to the active editor.
    vscode.commands.registerCommand("ocursor.acceptFileChanges", (uri?: vscode.Uri) => runReviewAction(async () => {
      const file = pendingPathFor(uri);
      if (file) await pendingChanges.accept(file);
    })),
    vscode.commands.registerCommand("ocursor.acceptBlock", (path: string, index: number, startLine: number) => reviewBlock(path, index, startLine, false)),
    vscode.commands.registerCommand("ocursor.rejectBlock", (path: string, index: number, startLine: number) => reviewBlock(path, index, startLine, true)),
    vscode.commands.registerCommand("ocursor.acceptBlockAtCursor", () => reviewBlockAtCursor(false)),
    vscode.commands.registerCommand("ocursor.rejectBlockAtCursor", () => reviewBlockAtCursor(true)),
    vscode.commands.registerCommand("ocursor.nextBlock", (uri?: vscode.Uri, fromIndex?: number) => revealNextBlock(uri, fromIndex)),
    vscode.window.onDidChangeTextEditorSelection(() => publishCursorContext()),
    vscode.window.onDidChangeActiveTextEditor(() => publishCursorContext()),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, blockLenses),
    codeLensesChanged,
    vscode.commands.registerCommand("ocursor.acceptAllChanges", () => runReviewAction(() => pendingChanges.acceptAll())),
    vscode.commands.registerCommand("ocursor.rejectAllChanges", () => runReviewAction(async () => {
      const paths = [...pendingByPath().keys()];
      if (!paths.length || !await ensureSaved(paths)) return;
      await pendingChanges.rejectAll();
    })),
    addedDecoration,
    originalsChanged,
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); if (typingTimer) clearTimeout(typingTimer); typingTimer = undefined; typedDocuments.clear(); publishedContext = undefined; publishedInBlock = undefined; } },
    { dispose: pendingChanges.onChange(scheduleSync) },
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.scheme === "file") refreshEditor(editor);
      }
    }),
    // Typing only refreshes highlights — re-opening diff tabs on every keystroke
    // would thrash the editor.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
      if (!pendingByPath().has(e.document.uri.fsPath)) return;
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) { scheduleHighlights(e.document); return; }
      }
    })
  );
  scheduleSync();
}
