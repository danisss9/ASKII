import * as vscode from 'vscode';
import { getExtensionResponseWithImage } from './providers';
import { parseJsonFromModel } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import {
  buildControlSystemPrompt,
  takeScreenshot,
  describeAction,
  executeControlAction,
  getMonitors,
  getSystemInfo,
  parseControlResponse,
  checkControlDependencies,
  type ControlAction,
  type ControlHistoryEntry,
  type SystemInfo,
} from '@common/control';
import {
  buildBrowserSystemPrompt,
  parseBrowserResponse,
  describeBrowserAction,
  executeBrowserAction,
  takePageScreenshot,
  detectBrowserExecutable,
  browserLaunchArgs,
} from '@common/browser';
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

  const outputChannel = getAgentChannel('ASKII Control');
  outputChannel.appendLine(`ASKII Control started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Instruction: ${instruction}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();
  const history: ControlHistoryEntry[] = [];
  let round = 0;
  let prevScreenshot: string | undefined;
  let systemInfo: SystemInfo | undefined;

  setTaskCanceller(() => {
    abortController.abort();
    outputChannel.appendLine('Stopped by user.');
  });

  acquireTaskPanel('ASKII Control');

  let currentTask: string | null = instruction;

  while (currentTask) {
    if (currentTask !== instruction) {
      outputChannel.appendLine(`\nInstruction: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    round = 0;
    let taskComplete = false;
    let stoppedByChoice = false;
    let errorMsg: string | null = null;
    let errorLogged = false;

    try {
      while (round < maxRounds && !abortController.signal.aborted) {
        outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — taking screenshot...`);
        const roundEntry = addTimelineEntry({
          kind: 'round',
          title: `Round ${round + 1} of ${maxRounds}`,
          status: 'pending',
        });

        const {
          base64: imageBase64,
          width: screenW,
          height: screenH,
          physWidth,
          physHeight,
        } = await takeScreenshot(monitorId);

        if (!systemInfo) {
          systemInfo = await getSystemInfo(physWidth, physHeight);
        }

        const screenChanged = prevScreenshot === undefined || prevScreenshot !== imageBase64;
        if (prevScreenshot !== undefined && !screenChanged) {
          outputChannel.appendLine('Warning: screen unchanged since last action.');
        }
        prevScreenshot = imageBase64;

        updateTimelineEntry(roundEntry, {
          screenshot: `data:image/png;base64,${imageBase64}`,
          detail: screenChanged ? undefined : 'Screen unchanged since last action.',
        });

        const prompt =
          round === 0
            ? `Instruction to complete: ${currentTask}\n\nAnalyze the screenshot and determine the next action(s).`
            : `Continuing instruction: ${currentTask}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;

        outputChannel.appendLine('Asking AI...');
        const rawResponse = await getExtensionResponseWithImage(
          `${buildControlSystemPrompt(screenW, screenH, systemInfo, history)}\n\n${prompt}`,
          imageBase64,
          abortController.signal,
        );

        if (abortController.signal.aborted) {
          break;
        }

        const parsed = parseControlResponse(rawResponse);

        if (!parsed) {
          outputChannel.appendLine('Error: could not parse AI response.');
          outputChannel.appendLine(`Raw: ${rawResponse}`);
          addTimelineEntry({
            kind: 'error',
            title: 'Could not parse AI response',
            detail: timelineSnippet(rawResponse, 1000),
          });
          errorMsg = 'Could not parse AI response.';
          errorLogged = true;
          break;
        }

        if (parsed.type === 'done') {
          outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
          outputChannel.appendLine(`Reasoning: ${parsed.reasoning}`);
          updateTimelineEntry(roundEntry, { status: 'ok' });
          addTimelineEntry({
            kind: 'done',
            title: 'Task complete',
            detail: parsed.reasoning || undefined,
          });
          taskComplete = true;
          break;
        }

        updateTimelineEntry(roundEntry, { status: 'ok' });

        const { actions } = parsed;

        // Planned actions show in the timeline before the batch confirmation
        const plannedEntries = actions.map((a) =>
          addTimelineEntry({
            kind: 'action',
            title: describeAction(a as ControlAction),
            detail: a.reasoning,
            status: 'pending',
          }),
        );
        actions.forEach((a, i) => {
          const label = actions.length > 1 ? `Action ${i + 1}/${actions.length}` : 'Action';
          outputChannel.appendLine(`${label}: ${describeAction(a as ControlAction)}`);
          outputChannel.appendLine(`Reasoning: ${a.reasoning}`);
        });

        // Resolve click_text actions to coordinates via a second LLM call —
        // before the confirmation, so the user approves the actual click target
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i] as ControlAction;
          if (a.action !== 'click_text') {continue;}
          const ct = a as { action: 'click_text'; text: string; reasoning: string };
          let resolved = false;
          try {
            const resolvePrompt = `Find the EXACT pixel coordinates of the UI element whose visible text is "${ct.text}". Return ONLY valid JSON: {"x": number, "y": number}`;
            const raw = await getExtensionResponseWithImage(
              resolvePrompt,
              imageBase64,
              abortController.signal,
            );
            const coords = parseJsonFromModel(
              raw,
              (v) =>
                !!v &&
                typeof (v as { x?: unknown }).x === 'number' &&
                typeof (v as { y?: unknown }).y === 'number',
              '{',
            ) as { x: number; y: number } | undefined;
            if (coords) {
              Object.assign(a, { action: 'mouse_left_click', x: coords.x, y: coords.y });
              resolved = true;
              outputChannel.appendLine(`Resolved "${ct.text}" → (${coords.x}, ${coords.y})`);
              updateTimelineEntry(plannedEntries[i], {
                title: describeAction(a),
                detail: `Resolved "${ct.text}" → (${coords.x}, ${coords.y})`,
              });
            }
          } catch (error) {
            if (abortController.signal.aborted) {throw error;}
          }
          if (!resolved) {
            outputChannel.appendLine(`Warning: could not resolve text "${ct.text}" to coordinates`);
            addTimelineEntry({
              kind: 'info',
              title: `Could not resolve "${ct.text}" to coordinates`,
              status: 'error',
            });
          }
        }

        // Confirm
        if (!autoConfirm) {
          const batchLabel =
            actions.length === 1
              ? describeAction(actions[0] as ControlAction)
              : `${actions.length} actions`;
          const confirmTarget =
            plannedEntries.length > 0 ? plannedEntries[plannedEntries.length - 1] : roundEntry;
          const choice = await requestChoice(confirmTarget, `Execute ${batchLabel}?`, [
            'Execute',
            'Stop',
          ]);
          if (choice !== 'Execute' || abortController.signal.aborted) {
            outputChannel.appendLine('Stopped by user.');
            stoppedByChoice = true;
            for (const id of plannedEntries) {
              updateTimelineEntry(id, { status: 'skipped' });
            }
            break;
          }
          // Small delay between confirmation and execution
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        }

        // Execute sequence
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i] as ControlAction;
          if (abortController.signal.aborted) {break;}
          await executeControlAction(a, screenW, screenH, abortController.signal);
          history.push({
            round: round + 1,
            description: describeAction(a),
            reasoning: a.reasoning,
            screenChanged: true,
          });
          updateTimelineEntry(plannedEntries[i], { status: 'ok' });
        }
        outputChannel.appendLine('Done.\n');

        round++;
      }

      if (round >= maxRounds && !taskComplete && !abortController.signal.aborted) {
        outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        addTimelineEntry({
          kind: 'info',
          title: `Max rounds (${maxRounds}) reached`,
          status: 'error',
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg) {
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (!errorLogged) {
        addTimelineEntry({ kind: 'error', title: 'ASKII Control failed', detail: errorMsg });
      }
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Control failed: ${errorMsg}`);
      sweepPendingEntries();
      break;
    }
    if (abortController.signal.aborted || stoppedByChoice) {
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      break;
    }

    setTaskStatus('done', taskComplete ? 'Task complete' : `Finished after ${round} round(s)`);
    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      break;
    }
  }
}

async function runBrowserTask(task: string) {
  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = Math.max(1, config.get<number>('doMaxRounds') ?? 20);
  // Separate from doAutoConfirm: unattended mouse/keyboard/browser control is
  // a different risk than unattended file edits
  const autoConfirm = config.get<boolean>('controlAutoConfirm') ?? false;
  const headless = config.get<boolean>('browserHeadless') ?? false;
  const chromePath = config.get<string>('chromePath') || detectBrowserExecutable();

  const outputChannel = getAgentChannel('ASKII Control (Browser)');
  outputChannel.appendLine(`ASKII Control (Browser) started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Task: ${task}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();
  setTaskCanceller(() => {
    abortController.abort();
    outputChannel.appendLine('Stopped by user.');
  });

  acquireTaskPanel('ASKII Control (Browser)');

  const puppeteer = await import('puppeteer-core');
  let browser: import('puppeteer-core').Browser | undefined;
  let page: import('puppeteer-core').Page | undefined;

  let currentTask: string | null = task;

  while (currentTask) {
    if (currentTask !== task) {
      outputChannel.appendLine(`\nTask: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    let round = 0;
    let taskComplete = false;
    let stoppedByChoice = false;
    let errorMsg: string | null = null;
    let errorLogged = false;

    try {
      // Relaunch if the user closed the window (or its tab) since the last task
      if (browser && (!browser.connected || !page || page.isClosed())) {
        await browser.close().catch(() => undefined);
        browser = undefined;
        page = undefined;
      }
      if (!browser) {
        if (!chromePath) {
          throw new Error(
            'No Chromium-based browser found. Install Chrome or Edge, or set askii.chromePath to your browser executable (e.g. C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe).',
          );
        }
        outputChannel.appendLine('Launching browser...');
        outputChannel.appendLine(`Browser executable: ${chromePath}`);
        browser = await puppeteer.launch({
          headless: headless ? true : false,
          executablePath: chromePath,
          args: browserLaunchArgs(),
        });

        const [firstPage] = await browser.pages();
        await firstPage.setViewport(null);
        page = firstPage;
      }

      while (round < maxRounds && !abortController.signal.aborted) {
        outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — capturing screenshot...`);
        const roundEntry = addTimelineEntry({
          kind: 'round',
          title: `Round ${round + 1} of ${maxRounds}`,
          status: 'pending',
        });

        const imageBase64 = await takePageScreenshot(page!);
        const currentUrl = page!.url();

        outputChannel.appendLine(`Current URL: ${currentUrl}`);
        updateTimelineEntry(roundEntry, {
          screenshot: `data:image/png;base64,${imageBase64}`,
          detail: currentUrl,
        });

        const systemPrompt = buildBrowserSystemPrompt();
        const userPrompt =
          round === 0
            ? `Task: ${currentTask}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and determine the next action.`
            : `Continuing task: ${currentTask}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and return the next action or DONE.`;

        outputChannel.appendLine('Asking AI...');
        const rawResponse = await getExtensionResponseWithImage(
          `${systemPrompt}\n\n${userPrompt}`,
          imageBase64,
          abortController.signal,
        );

        if (abortController.signal.aborted) {break;}

        const parsed = parseBrowserResponse(rawResponse);

        if (!parsed) {
          outputChannel.appendLine('Error: could not parse AI response.');
          outputChannel.appendLine(`Raw: ${rawResponse}`);
          addTimelineEntry({
            kind: 'error',
            title: 'Could not parse AI response',
            detail: timelineSnippet(rawResponse, 1000),
          });
          errorMsg = 'Could not parse AI response.';
          errorLogged = true;
          break;
        }

        if (parsed.type === 'done') {
          outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
          outputChannel.appendLine(`Reasoning: ${parsed.reasoning}`);
          updateTimelineEntry(roundEntry, { status: 'ok' });
          addTimelineEntry({
            kind: 'done',
            title: 'Task complete',
            detail: parsed.reasoning || undefined,
          });
          taskComplete = true;
          break;
        }

        updateTimelineEntry(roundEntry, { status: 'ok' });

        let stopped = false;
        for (const action of parsed.actions) {
          if (abortController.signal.aborted) {
            stopped = true;
            break;
          }

          const description = describeBrowserAction(action);
          outputChannel.appendLine(`Action: ${description}`);
          outputChannel.appendLine(`Reasoning: ${action.reasoning}`);

          const actionEntry = addTimelineEntry({
            kind: 'action',
            title: description,
            detail: action.reasoning,
            status: 'pending',
          });

          if (!autoConfirm) {
            const choice = await requestChoice(actionEntry, undefined, ['Execute', 'Stop']);
            if (choice !== 'Execute' || abortController.signal.aborted) {
              outputChannel.appendLine('Stopped by user.');
              stopped = true;
              stoppedByChoice = true;
              updateTimelineEntry(actionEntry, { status: 'skipped' });
              break;
            }
          }

          try {
            await executeBrowserAction(action, page!);
            outputChannel.appendLine('Done.\n');
            updateTimelineEntry(actionEntry, { status: 'ok' });
          } catch (execErr) {
            const msg = execErr instanceof Error ? execErr.message : 'Unknown error';
            outputChannel.appendLine(`Action failed: ${msg}`);
            updateTimelineEntry(actionEntry, {
              status: 'error',
              detail: `${action.reasoning}\nFailed: ${msg}`.trim(),
            });
            vscode.window.showWarningMessage(
              `ASKII Control (Browser): ${description} failed — ${msg}`,
            );
          }
        }
        if (stopped) {break;}

        round++;
      }

      if (round >= maxRounds && !taskComplete && !abortController.signal.aborted) {
        outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        addTimelineEntry({
          kind: 'info',
          title: `Max rounds (${maxRounds}) reached`,
          status: 'error',
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg) {
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (!errorLogged) {
        addTimelineEntry({ kind: 'error', title: 'ASKII Control (Browser) failed', detail: errorMsg });
      }
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Control (Browser) failed: ${errorMsg}`);
      sweepPendingEntries();
      break;
    }
    if (abortController.signal.aborted || stoppedByChoice) {
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      break;
    }

    setTaskStatus('done', taskComplete ? 'Task complete' : `Finished after ${round} round(s)`);
    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      break;
    }
  }

  // The session is over. A headless browser is invisible and would otherwise
  // linger until VS Code exits; a visible one is left open for the user.
  if (browser && headless) {
    await browser.close().catch(() => undefined);
  }
}
