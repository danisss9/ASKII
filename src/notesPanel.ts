import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { type NoteEntry, type NoteKind, searchNotes } from '@common/notes';
import {
  loadNotes,
  saveNotes,
  captureContext,
  captureScreenshot,
  classifyNoteInput,
  buildEntry,
  updateNoteText,
  snoozeNote,
} from './notes';
import { rescheduleAll, onNotesChanged } from './notesScheduler';
import { getNotePanelHtml } from './notesPanelHtml';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { startVoiceRecording, type VoiceRecording } from './voiceRecorder';
import { getExtensionTranscription } from './providers';

// ── Single-instance panel ────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;
let currentContext: vscode.ExtensionContext | undefined;
let notesChangedSub: vscode.Disposable | undefined;
let activeRecording: VoiceRecording | undefined;

export async function askiiNoteCommand(
  context: vscode.ExtensionContext,
  args?: { selectId?: string },
): Promise<void> {
  currentContext = context;

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    if (args?.selectId) {
      currentPanel.webview.postMessage({ type: 'selectEntry', id: args.selectId });
    }
    refreshList();
    return;
  }

  const nonce = randomBytes(16).toString('base64');

  const panel = vscode.window.createWebviewPanel(
    'askiiNote',
    `ASKII Note ${getRandomKaomoji()}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.globalStorageUri],
    },
  );
  panel.iconPath = vscode.Uri.parse(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
      ),
  );

  panel.webview.html = getNotePanelHtml(
    nonce,
    panel.webview,
    getRandomKaomoji(),
    getSnoozeMinutes(),
  );

  panel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(panel, context, msg));

  panel.onDidDispose(() => {
    currentPanel = undefined;
    notesChangedSub?.dispose();
    notesChangedSub = undefined;
    // Mic capture outlives the panel only until the file is finalized — then it is discarded.
    activeRecording?.cancel();
    activeRecording = undefined;
  });

  currentPanel = panel;

  notesChangedSub = onNotesChanged(() => refreshList());

  // Initial list
  refreshList();
  if (args?.selectId) {
    panel.webview.postMessage({ type: 'selectEntry', id: args.selectId });
  }
}

// ── List refresh ─────────────────────────────────────────────────────────────

// Last search/filter state so host-triggered refreshes (scheduler, submit,
// mutations) keep the webview's active view instead of resetting it.
let lastQuery = '';
let lastKinds: NoteKind[] = [];

function refreshList(query?: string, kinds?: NoteKind[]): void {
  if (!currentPanel || !currentContext) return;
  if (query !== undefined) lastQuery = query;
  if (kinds !== undefined) lastKinds = kinds;
  const all = loadNotes(currentContext);
  const stats = {
    tasksDone: all.filter((n) => n.kind === 'task' && n.done).length,
    tasksTotal: all.filter((n) => n.kind === 'task').length,
  };
  // Kind filtering happens before indexing so the search top-K cap stays correct.
  const scoped = lastKinds.length ? all.filter((n) => lastKinds.includes(n.kind)) : all;
  const results = searchNotes(lastQuery, scoped);
  const entries = results.map((r) => {
    const n = r.entry;
    let screenshotUri: string | undefined;
    if (n.screenshotPath && currentPanel) {
      screenshotUri = currentPanel.webview
        .asWebviewUri(vscode.Uri.file(n.screenshotPath))
        .toString();
    }
    return { ...n, screenshotUri };
  });
  currentPanel.webview.postMessage({ type: 'entries', entries, stats });
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleWebviewMessage(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  msg: unknown,
): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type: string; [k: string]: unknown };

  switch (m.type) {
    case 'requestList': {
      const query = typeof m.query === 'string' ? m.query : '';
      let kinds: NoteKind[] | undefined;
      if (Array.isArray(m.kinds)) {
        kinds = m.kinds.filter(
          (k): k is NoteKind => k === 'note' || k === 'task' || k === 'reminder',
        );
      }
      refreshList(query, kinds);
      break;
    }

    case 'submit': {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) break;
      const attachScreenshot = m.attachScreenshot === true;
      panel.webview.postMessage({
        type: 'status',
        status: 'thinking',
        kaomoji: getRandomThinkingKaomoji(),
      });

      const ctx = captureContext();
      let screenshotPath: string | undefined;
      if (attachScreenshot) {
        screenshotPath = await captureScreenshot(context);
      }

      let cls = await classifyNoteInput(text, ctx);
      // Clarifying-question loop (max 2 rounds)
      let rounds = 0;
      while (cls.needsClarification && cls.clarifyingQuestion && rounds < 2) {
        panel.webview.postMessage({
          type: 'clarify',
          question: cls.clarifyingQuestion,
        });
        const answer = await waitForClarifyAnswer(panel);
        if (answer === null) {
          // user cancelled the clarification — save as a plain note
          cls = {
            kind: 'note',
            priority: null,
            dueAt: null,
            tags: cls.tags,
            needsClarification: false,
            clarifyingQuestion: null,
            summary: text.slice(0, 80),
          };
          break;
        }
        const combined = `${text}\n\n[clarified: ${answer}]`;
        cls = await classifyNoteInput(combined, ctx);
        rounds++;
      }

      const entry = buildEntry(text, cls, ctx, screenshotPath);
      const notes = loadNotes(context);
      notes.push(entry);
      saveNotes(context, notes);
      rescheduleAll(notes);

      panel.webview.postMessage({ type: 'status', status: 'done', kaomoji: getRandomKaomoji() });
      refreshList();
      break;
    }

    case 'deleteEntry': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context).filter((n) => n.id !== id);
      saveNotes(context, notes);
      rescheduleAll(notes);
      refreshList();
      break;
    }

    case 'toggleTask': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context);
      const i = notes.findIndex((n) => n.id === id);
      if (i !== -1 && notes[i].kind === 'task') {
        notes[i].done = !notes[i].done;
        saveNotes(context, notes);
      }
      refreshList();
      break;
    }

    case 'updateEntry': {
      const id = typeof m.id === 'string' ? m.id : '';
      const text = typeof m.text === 'string' ? m.text : '';
      if (!id) break;
      if (updateNoteText(context, id, text)) {
        panel.webview.postMessage({ type: 'status', status: 'done', kaomoji: getRandomKaomoji() });
      }
      refreshList();
      break;
    }

    case 'reclassify': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context);
      const i = notes.findIndex((n) => n.id === id);
      if (i === -1) break;
      // Optionally apply an in-progress edit before re-running classification.
      if (typeof m.text === 'string' && m.text.trim()) notes[i].text = m.text.trim();
      const n = notes[i];
      panel.webview.postMessage({
        type: 'status',
        status: 'thinking',
        kaomoji: getRandomThinkingKaomoji(),
      });
      const cls = await classifyNoteInput(n.text, n.context ?? {});
      n.kind = cls.kind;
      n.tags = cls.tags;
      n.summary = cls.summary;
      n.priority = cls.kind === 'task' ? (cls.priority ?? 'medium') : undefined;
      n.done = cls.kind === 'task' ? (n.done ?? false) : undefined;
      n.dueAt = cls.kind === 'reminder' ? (cls.dueAt ?? undefined) : undefined;
      n.fired = cls.kind === 'reminder' ? false : undefined;
      n.missed = cls.kind === 'reminder' ? false : undefined;
      saveNotes(context, notes);
      rescheduleAll(notes);
      panel.webview.postMessage({ type: 'status', status: 'done', kaomoji: getRandomKaomoji() });
      refreshList();
      break;
    }

    case 'togglePin': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context);
      const i = notes.findIndex((n) => n.id === id);
      if (i !== -1) {
        notes[i].pinned = !notes[i].pinned;
        saveNotes(context, notes);
      }
      refreshList();
      break;
    }

    case 'snoozeReminder': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const minutes =
        typeof m.minutes === 'number' && m.minutes > 0 ? m.minutes : getSnoozeMinutes();
      if (snoozeNote(context, id, minutes)) {
        rescheduleAll(loadNotes(context));
        refreshList();
      }
      break;
    }

    case 'dismissReminder': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context);
      const i = notes.findIndex((n) => n.id === id);
      if (i !== -1 && notes[i].kind === 'reminder') {
        notes[i].fired = true;
        notes[i].missed = false;
        saveNotes(context, notes);
        rescheduleAll(notes);
        refreshList();
      }
      break;
    }

    case 'openScreenshot': {
      const p = typeof m.path === 'string' ? m.path : '';
      if (p) {
        const uri = vscode.Uri.file(p);
        await vscode.commands.executeCommand('vscode.open', uri);
      }
      break;
    }

    case 'voiceStart': {
      void beginVoiceCapture(panel, context);
      break;
    }

    case 'voiceStop': {
      void finishVoiceCapture(panel);
      break;
    }
  }
}

// ── Voice input ───────────────────────────────────────────────────────────────

async function beginVoiceCapture(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  if (activeRecording) return;
  try {
    const recording = await startVoiceRecording(context, (level) => {
      panel.webview.postMessage({ type: 'voiceLevel', level });
    });
    activeRecording = recording;
    // Duration cap reached / device vanished: wrap up like a user stop so the
    // captured audio is still transcribed instead of being dropped silently.
    recording.onAutoEnd(() => {
      if (activeRecording === recording) void finishVoiceCapture(panel);
    });
    panel.webview.postMessage({ type: 'voiceStarted' });
  } catch (err) {
    panel.webview.postMessage({
      type: 'voiceError',
      error: err instanceof Error ? err.message : 'Voice input failed to start.',
    });
  }
}

async function finishVoiceCapture(panel: vscode.WebviewPanel): Promise<void> {
  const recording = activeRecording;
  activeRecording = undefined;
  if (!recording) return;
  panel.webview.postMessage({
    type: 'status',
    status: 'thinking',
    kaomoji: `${getRandomThinkingKaomoji()} transcribing…`,
  });
  try {
    const file = await recording.stop();
    let audio: Buffer;
    try {
      audio = await fs.promises.readFile(file);
    } finally {
      void fs.promises.unlink(file).catch(() => undefined);
    }
    const text = await getExtensionTranscription(audio);
    if (!text) {
      panel.webview.postMessage({
        type: 'voiceError',
        error: 'No speech was detected in the recording.',
      });
    } else {
      panel.webview.postMessage({ type: 'voiceText', text });
    }
  } catch (err) {
    panel.webview.postMessage({
      type: 'voiceError',
      error: err instanceof Error ? err.message : 'Transcription failed.',
    });
  }
}

function waitForClarifyAnswer(panel: vscode.WebviewPanel): Promise<string | null> {
  return new Promise((resolve) => {
    const disp = panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type: string; answer?: unknown };
      if (m.type === 'clarifyAnswer') {
        disp.dispose();
        resolve(typeof m.answer === 'string' && m.answer.trim() ? m.answer.trim() : null);
      } else if (m.type === 'clarifyCancel') {
        disp.dispose();
        resolve(null);
      }
    });
  });
}

function getSnoozeMinutes(): number {
  const config = vscode.workspace.getConfiguration('askii');
  return config.get<number>('noteSnoozeMinutes') ?? 10;
}
