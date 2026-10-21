import * as vscode from 'vscode';
import { getExtensionResponseWithImage } from './providers';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { checkControlDependencies, getMonitors } from '@common/control';
import { browserLaunchArgs, detectBrowserExecutable } from '@common/browser';
import {
  runBrowserAgent,
  runScreenAgent,
  type ControlAgentResult,
  type ControlEvent,
  type ScreenSession,
  type VisionAsk,
} from '@common/controlAgent';
import {
  acquireTaskPanel,
  addTimelineEntry,
  beginTaskSession,
  endTaskSession,
  requestChoice,
  setTaskCanceller,
  setTaskStatus,
  sweepPendingEntries,
  updateTimelineEntry,
  waitForFollowUp,
} from './taskPanel';
import { getAgentChannel, timelineSnippet } from './commandUtils';
// ASKII Control — screen and browser agents. Loaded on first use (see
// extension.ts) so jimp, screenshot-desktop and Puppeteer stay out of activation.

export async function askiiControlCommand() {
  // First: pick what ASKII should control — the screen or the browser
  const mode = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { target: 'screen' | 'browser' }
  >(
    [
      {
        label: '$(screen-full) Screen',
        description: 'Control the whole screen with mouse & keyboard',
        target: 'screen',
      },
      {
        label: '$(browser) Browser',
        description: 'Launch and control a Chrome browser',
        target: 'browser',
      },
    ],
    { placeHolder: 'What should ASKII control?' },
  );

  if (!mode) {return;}

  // Then: ask for the task
  const instruction = await vscode.window.showInputBox({
    prompt:
      mode.target === 'browser'
        ? 'Give ASKII a browser task'
        : 'Give ASKII a screen control instruction',
    placeHolder:
      mode.target === 'browser'
        ? 'e.g., Go to https://example.com and click Learn more'
        : 'e.g., Open Notepad and type hello world',
  });

  if (!instruction) {return;}

  if (mode.target === 'browser') {
    await runBrowserTask(instruction);
    return;
  }

  await runScreenControlTask(instruction);
}

// The extension's vision call takes one prompt — the system prompt goes first
const askVision: VisionAsk = (system, prompt, image, signal) =>
  getExtensionResponseWithImage(system ? `${system}\n\n${prompt}` : prompt, image, signal);

/**
 * Maps Control agent events onto the task panel timeline and the output
 * channel. Returns the event handler and the timeline-entry lookup the
 * confirm callback needs.
 */
function controlTimeline(channel: vscode.OutputChannel, label: string) {
  const entries = new Map<number, number>();
  const emit = (event: ControlEvent): void => {
    switch (event.type) {
      case 'round-start':
        channel.appendLine(`Round ${event.round}/${event.maxRounds} — taking screenshot...`);
        entries.set(
          event.id,
          addTimelineEntry({
            kind: 'round',
            title: `Round ${event.round} of ${event.maxRounds}`,
            status: 'pending',
          }),
        );
        break;
      case 'screenshot': {
        if (event.note) {
          channel.appendLine(event.note);
        }
        channel.appendLine('Asking AI...');
        const entry = entries.get(event.id);
        if (entry !== undefined) {
          updateTimelineEntry(entry, {
            screenshot: `data:image/png;base64,${event.image}`,
            detail: event.note,
          });
        }
        break;
      }
      case 'round-end': {
        const entry = entries.get(event.id);
        if (entry !== undefined) {
          updateTimelineEntry(entry, { status: 'ok' });
        }
        break;
      }
      case 'parse-error':
        channel.appendLine('Error: could not parse AI response.');
        channel.appendLine(`Raw: ${event.raw}`);
        addTimelineEntry({
          kind: 'error',
          title: 'Could not parse AI response',
          detail: timelineSnippet(event.raw, 1000),
        });
        break;
      case 'done':
        channel.appendLine(`\nDone! ${getRandomKaomoji()}`);
        channel.appendLine(`Reasoning: ${event.reasoning}`);
        addTimelineEntry({ kind: 'done', title: 'Task complete', detail: event.reasoning || undefined });
        break;
      case 'action-planned':
        channel.appendLine(`Action: ${event.label}`);
        channel.appendLine(`Reasoning: ${event.reasoning}`);
        entries.set(
          event.id,
          addTimelineEntry({
            kind: 'action',
            title: event.label,
            detail: event.reasoning,
            status: 'pending',
          }),
        );
        break;
      case 'action-update': {
        if (event.detail) {
          channel.appendLine(event.detail);
        }
        if (event.status === 'error') {
          vscode.window.showWarningMessage(`${label}: action failed — ${event.detail ?? ''}`);
        }
        const entry = entries.get(event.id);
        if (entry !== undefined) {
          updateTimelineEntry(entry, {
            ...(event.status ? { status: event.status } : {}),
            ...(event.label ? { title: event.label } : {}),
            ...(event.detail ? { detail: event.detail } : {}),
          });
        }
        break;
      }
      case 'notice':
        channel.appendLine(`${event.level === 'warning' ? 'Warning: ' : ''}${event.message}`);
        addTimelineEntry({
          kind: 'info',
          title: event.message,
          status: event.level === 'warning' ? 'error' : undefined,
        });
        break;
      case 'max-rounds':
        channel.appendLine(`Max rounds (${event.maxRounds}) reached.`);
        addTimelineEntry({
          kind: 'info',
          title: `Max rounds (${event.maxRounds}) reached`,
          status: 'error',
        });
        break;
    }
  };
  const confirm = async ({ id, message }: { id: number; message: string }): Promise<boolean> => {
    const entry = entries.get(id);
    if (entry === undefined) {
      return false;
    }
    return (await requestChoice(entry, message, ['Execute', 'Stop'])) === 'Execute';
  };
  return { emit, confirm };
}

/**
 * Runs Control tasks (the first, then any follow-ups typed in the panel) in
 * one task-panel session. `runTask` runs one task; `prepare` runs before each
 * one (e.g. relaunching a closed browser).
 */
async function runControlSession(
  label: string,
  channelName: string,
  firstTask: string,
  runTask: (
    task: string,
    signal: AbortSignal,
    ui: ReturnType<typeof controlTimeline>,
  ) => Promise<ControlAgentResult>,
): Promise<void> {
  const channel = getAgentChannel(channelName);
  channel.appendLine(`${label} started ${getRandomThinkingKaomoji()}`);
  acquireTaskPanel(label);

  let currentTask: string | null = firstTask;
  while (currentTask) {
    channel.appendLine(`\nTask: ${currentTask}\n`);
    setTaskStatus('running', currentTask);
    const abortController = new AbortController();
    setTaskCanceller(() => {
      abortController.abort();
      channel.appendLine('Stopped by user.');
    });

    let result: ControlAgentResult | undefined;
    let errorMsg: string | null = null;
    try {
      result = await runTask(currentTask, abortController.signal, controlTimeline(channel, label));
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg || result?.outcome === 'parse-error') {
      const message = errorMsg ?? 'Could not parse AI response.';
      channel.appendLine(`Error: ${message}`);
      if (errorMsg) {
        addTimelineEntry({ kind: 'error', title: `${label} failed`, detail: message });
      }
      setTaskStatus('error', message);
      vscode.window.showErrorMessage(`${label} failed: ${message}`);
      sweepPendingEntries();
      return;
    }
    if (abortController.signal.aborted || result?.outcome === 'stopped' || result?.outcome === 'aborted') {
      channel.appendLine('Stopped by user.');
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      return;
    }

    setTaskStatus(
      'done',
      result?.outcome === 'complete' ? 'Task complete' : `Finished after ${result?.rounds ?? 0} round(s)`,
    );
    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      return;
    }
  }
}

async function runScreenControlTask(instruction: string) {
  const missingDeps = checkControlDependencies();
  if (missingDeps.length > 0) {
    vscode.window.showErrorMessage(
      `ASKII Control: missing required tools:\n${missingDeps.join('\n')}`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = Math.max(1, config.get<number>('doMaxRounds') ?? 20);
  // Separate from doAutoConfirm: unattended mouse/keyboard/browser control is
  // a different risk than unattended file edits
  const autoConfirm = config.get<boolean>('controlAutoConfirm') ?? false;

  // Monitor selection
  let monitorId: string | number | undefined;
  try {
    const monitors = await getMonitors();
    if (monitors.length > 1) {
      const pick = await vscode.window.showQuickPick(
        monitors.map((m) => ({ label: m.name, id: m.id })),
        { placeHolder: 'Select monitor to control' },
      );
      if (!pick) {return;}
      monitorId = pick.id;
    }
  } catch {
    // proceed with default monitor
  }

  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  // History and system info carry over to follow-up instructions
  const session: ScreenSession = { history: [] };
  await runControlSession('ASKII Control', 'ASKII Control', instruction, (task, signal, ui) =>
    runScreenAgent({
      task,
      maxRounds,
      signal,
      autoConfirm,
      monitorId,
      session,
      ask: askVision,
      confirm: ui.confirm,
      emit: ui.emit,
      // Focus moves back from the task panel to the target window
      afterConfirmDelayMs: 1500,
    }),
  );
}

async function runBrowserTask(task: string) {
  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = Math.max(1, config.get<number>('doMaxRounds') ?? 20);
  const autoConfirm = config.get<boolean>('controlAutoConfirm') ?? false;
  const headless = config.get<boolean>('browserHeadless') ?? false;
  const chromePath = config.get<string>('chromePath') || detectBrowserExecutable();

  const puppeteer = await import('puppeteer-core');
  let browser: import('puppeteer-core').Browser | undefined;
  let page: import('puppeteer-core').Page | undefined;
  const channel = getAgentChannel('ASKII Control (Browser)');

  try {
    await runControlSession('ASKII Control (Browser)', 'ASKII Control (Browser)', task, async (t, signal, ui) => {
      // Relaunch if the user closed the window (or its tab) since the last task
      if (browser && (!browser.connected || !page || page.isClosed())) {
        await browser.close().catch(() => undefined);
        browser = undefined;
        page = undefined;
      }
      if (!browser || !page) {
        if (!chromePath) {
          throw new Error(
            'No Chromium-based browser found. Install Chrome or Edge, or set askii.chromePath to your browser executable (e.g. C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe).',
          );
        }
        channel.appendLine(`Launching browser: ${chromePath}`);
        browser = await puppeteer.launch({
          headless: headless ? true : false,
          executablePath: chromePath,
          args: browserLaunchArgs(),
        });
        const [firstPage] = await browser.pages();
        await firstPage.setViewport(null);
        page = firstPage;
      }
      return runBrowserAgent({
        task: t,
        maxRounds,
        signal,
        autoConfirm,
        page,
        ask: askVision,
        confirm: ui.confirm,
        emit: ui.emit,
      });
    });
  } finally {
    // A headless browser is invisible and would otherwise linger until VS
    // Code exits; a visible one is left open for the user.
    if (browser && headless) {
      await browser.close().catch(() => undefined);
    }
  }
}
