import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionClient } from '@shared/session-client';
import {
  ASKII_CLOUD_URL,
  PLATFORMS,
  PLATFORM_DEFAULT_MODELS,
  PROVIDER_LABELS,
  type ProviderId,
} from '@shared/providers';
import type {
  SessionEvent,
  SessionMode,
  SessionOptions,
  CreateSessionRequest,
} from '@shared/protocol';

// ── Paired device storage ────────────────────────────────────────────────────

interface PairedDevice {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
}

const DEVICES_KEY = 'askii.pairedDevices';
const SECRET_PREFIX = 'askii.pairingToken.';

async function loadDevices(context: vscode.ExtensionContext): Promise<PairedDevice[]> {
  const raw = context.globalState.get<PairedDevice[]>(DEVICES_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function saveDevices(context: vscode.ExtensionContext, devices: PairedDevice[]): Promise<void> {
  await context.globalState.update(DEVICES_KEY, devices);
}

async function storeToken(context: vscode.ExtensionContext, deviceId: string, token: string): Promise<void> {
  await context.secrets.store(SECRET_PREFIX + deviceId, token);
}

async function getToken(context: vscode.ExtensionContext, deviceId: string): Promise<string | undefined> {
  return context.secrets.get(SECRET_PREFIX + deviceId);
}

// ── Connect command ──────────────────────────────────────────────────────────

export async function askiiConnectCommand(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('askii');
  const apiKey = cfg.get<string>('askiicloudApiKey') ?? '';
  if (!apiKey) {
    const choice = await vscode.window.showErrorMessage(
      'ASKII Cloud API key is required to pair. Set it in `askii.askiicloudApiKey` first.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'askii.askiicloudApiKey');
    }
    return;
  }

  const brokerUrl = cfg.get<string>('askiicloudSessionsUrl') || ASKII_CLOUD_URL;

  // Ask the user for the pairing info displayed in the ASKII app's Settings → QR code.
  // The app calls pair() on the broker to get a deviceId + pairingToken; the
  // controller (extension/CLI) reads that from the QR and stores it here.
  const pasteInput = await vscode.window.showInputBox({
    prompt: 'Paste the pairing payload from the ASKII app (the JSON shown below the QR code), or enter the Device ID',
    placeHolder: '{"deviceId":"dev-1","pairingToken":"tok-..."} or dev-1',
  });
  if (!pasteInput) return;

  let deviceId: string;
  let pairingToken: string;
  let deviceName: string;

  const trimmed = pasteInput.trim();
  if (trimmed.startsWith('{')) {
    // JSON payload from the QR code
    try {
      const payload = JSON.parse(trimmed);
      deviceId = payload.deviceId;
      pairingToken = payload.pairingToken;
      deviceName = payload.deviceName ?? 'Android device';
      if (!deviceId || !pairingToken) throw new Error('Missing deviceId or pairingToken');
    } catch (err) {
      vscode.window.showErrorMessage(
        `ASKII: Invalid pairing payload: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    // Manual device ID entry — ask for the token separately
    deviceId = trimmed;
    const tokenInput = await vscode.window.showInputBox({
      prompt: 'Enter the pairing token (shown in the ASKII app Settings)',
      placeHolder: 'tok-...',
    });
    if (!tokenInput) return;
    pairingToken = tokenInput;
    deviceName = 'Android device';
  }

  await storeToken(context, deviceId, pairingToken);
  const devices = await loadDevices(context);
  // Avoid duplicates
  const filtered = devices.filter((d) => d.deviceId !== deviceId);
  filtered.push({
    deviceId,
    deviceName,
    pairedAt: new Date().toISOString(),
  });
  await saveDevices(context, filtered);

  vscode.window.showInformationMessage(
    `ASKII: Paired with "${deviceName}" (${deviceId}). Use "ASKII: Remote Session" to start driving it.`,
  );
}

// ── Remote session panel ─────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;
let currentContext: vscode.ExtensionContext | undefined;

export async function askiiRemoteSessionCommand(context: vscode.ExtensionContext): Promise<void> {
  currentContext = context;

  const devices = await loadDevices(context);
  if (devices.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No paired devices. Connect to an Android app first.',
      'Connect Now',
    );
    if (choice === 'Connect Now') {
      await askiiConnectCommand(context);
    }
    return;
  }

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }

  const nonce = randomBytes(16).toString('base64');
  const panel = vscode.window.createWebviewPanel(
    'askiiRemote',
    'ASKII Remote (⌐■_■)',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = vscode.Uri.parse(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
      ),
  );
  panel.webview.html = getRemoteHtml(nonce, panel.webview, devices);

  panel.webview.onDidReceiveMessage((msg) =>
    handleRemoteMessage(panel, context, msg, devices),
  );
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  currentPanel = panel;
}

// ── Message handler ──────────────────────────────────────────────────────────

async function handleRemoteMessage(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  msg: unknown,
  devices: PairedDevice[],
): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type: string; [k: string]: unknown };

  switch (m.type) {
    case 'start': {
      const deviceId = m.deviceId as string;
      const mode = m.mode as SessionMode;
      const provider = m.provider as ProviderId;
      const model = m.model as string;
      const prompt = m.prompt as string;

      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) {
        panel.webview.postMessage({ type: 'error', message: 'Device not found' });
        return;
      }
      const token = await getToken(context, deviceId);
      if (!token) {
        panel.webview.postMessage({ type: 'error', message: 'Pairing token missing' });
        return;
      }

      const cfg = vscode.workspace.getConfiguration('askii');
      const apiKey = cfg.get<string>('askiicloudApiKey') ?? '';
      const brokerUrl = cfg.get<string>('askiicloudSessionsUrl') || ASKII_CLOUD_URL;
      const client = new SessionClient({ baseUrl: brokerUrl, apiKey });

      const options: SessionOptions = { provider, model };
      const req: CreateSessionRequest = {
        deviceId,
        pairingToken: token,
        mode,
        options,
        prompt,
        apiKey,
      };

      try {
        const { sessionId } = await client.createSession(req);
        panel.webview.postMessage({ type: 'sessionStarted', sessionId });

        // Stream events
        const ac = new AbortController();
        for await (const ev of client.events(sessionId, token, ac.signal)) {
          panel.webview.postMessage({ type: 'event', event: ev });
          if (ev.type === 'done' || ev.type === 'error') break;
        }
      } catch (err) {
        panel.webview.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'reply': {
      // Forward a follow-up message to the session (handled in a later iteration
      // — the controller sends SessionCommand { type: 'reply', content } via
      // client.send(). For now the scaffold only demonstrates the initial turn.
      break;
    }
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function getRemoteHtml(nonce: string, _webview: vscode.Webview, devices: PairedDevice[]): string {
  const deviceItems = devices
    .map(
      (d) =>
        `<option value="${d.deviceId}">${d.deviceName} (${d.deviceId.slice(0, 12)})</option>`,
    )
    .join('');
  const platformItems = PLATFORMS.map(
    (p) => `<option value="${p}">${PROVIDER_LABELS[p]}</option>`,
  ).join('');
  const modeItems = [
    { id: 'ask', label: 'Ask' },
    { id: 'edit', label: 'Edit' },
    { id: 'do', label: 'Do' },
    { id: 'note', label: 'Note' },
    { id: 'browser', label: 'Browse' },
    { id: 'control', label: 'Control' },
  ]
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join('');
  const defaultModel = PLATFORM_DEFAULT_MODELS.askiicloud;

  const css = `
    body { font-family: var(--vscode-font-family, Arial, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; display: flex; flex-direction: column; height: 100vh; }
    select, input, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #555)); border-radius: 4px; padding: 4px 8px; font-family: inherit; }
    .controls { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .controls select, .controls input { min-width: 100px; }
    #prompt { flex: 1; min-height: 60px; max-height: 120px; resize: vertical; margin-bottom: 8px; }
    .btn { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 0.9em; }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    #output { flex: 1; overflow-y: auto; border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 6px; padding: 8px; font-size: 0.9em; white-space: pre-wrap; word-break: break-word; }
    .event { margin-bottom: 4px; padding: 2px 4px; border-radius: 3px; }
    .event.chunk { color: var(--vscode-textLink-foreground, #4daafc); }
    .event.action { background: var(--vscode-editor-inactiveSelectionBackground, #264f78); color: var(--vscode-foreground); }
    .event.screenshot img { max-width: 100%; border-radius: 4px; margin: 4px 0; }
    .event.error { color: var(--vscode-errorForeground, #f48771); }
    .event.done { color: var(--vscode-terminal-ansiGreen, #89d185); font-weight: bold; }
    .status { font-size: 0.8em; opacity: 0.7; margin: 4px 0; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${_webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <style>${css}</style>
</head>
<body>
  <div class="controls">
    <select id="device">${deviceItems}</select>
    <select id="mode">${modeItems}</select>
    <select id="provider">${platformItems}</select>
    <input id="model" value="${defaultModel}" placeholder="model" style="flex:1; min-width:120px" />
  </div>
  <textarea id="prompt" placeholder="Type your instruction for the Android app…"></textarea>
  <button id="sendBtn" class="btn">Start Session</button>
  <div id="output"><div class="status">Ready. Pick a device, mode, provider, model, and type your prompt.</div></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const output = document.getElementById('output');
    const sendBtn = document.getElementById('sendBtn');
    const promptEl = document.getElementById('prompt');

    sendBtn.addEventListener('click', () => {
      const msg = {
        type: 'start',
        deviceId: document.getElementById('device').value,
        mode: document.getElementById('mode').value,
        provider: document.getElementById('provider').value,
        model: document.getElementById('model').value,
        prompt: promptEl.value.trim(),
      };
      if (!msg.prompt) return;
      output.innerHTML = '<div class="status">Starting session…</div>';
      sendBtn.disabled = true;
      vscode.postMessage(msg);
    });

    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBtn.click(); }
    });

    function appendEvent(ev) {
      const div = document.createElement('div');
      div.className = 'event ' + (ev.type || '');
      if (ev.type === 'chunk') {
        div.textContent = ev.delta || '';
      } else if (ev.type === 'message') {
        div.textContent = (ev.role || '') + ': ' + (ev.content || '');
      } else if (ev.type === 'action') {
        div.textContent = 'ACTION: ' + (ev.description || JSON.stringify(ev.action));
      } else if (ev.type === 'screenshot') {
        const img = document.createElement('img');
        img.src = ev.dataUrl;
        div.appendChild(img);
      } else if (ev.type === 'error') {
        div.textContent = 'ERROR: ' + (ev.message || '');
      } else if (ev.type === 'done') {
        div.textContent = 'DONE: ' + (ev.summary || '');
        sendBtn.disabled = false;
      } else if (ev.type === 'status') {
        div.textContent = 'status: ' + (ev.status || '');
      } else if (ev.type === 'sessionStarted') {
        div.textContent = 'Session started: ' + ev.sessionId;
      } else {
        div.textContent = JSON.stringify(ev);
      }
      output.appendChild(div);
      output.scrollTop = output.scrollHeight;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'event') appendEvent(msg.event);
      else if (msg.type === 'error') {
        const div = document.createElement('div');
        div.className = 'event error';
        div.textContent = 'ERROR: ' + msg.message;
        output.appendChild(div);
        sendBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}