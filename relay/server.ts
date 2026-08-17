/**
 * ASKII relay — a local mock of the ASKII Cloud Sessions broker.
 *
 * Implements the same HTTP/SSE contract the production cloud exposes so the
 * extension, CLI, and Android app can develop and test remote sessions without
 * a backend:
 *
 *   POST /v1/sessions/pair                                 → PairResponse
 *   POST /v1/sessions                                      → CreateSessionResponse
 *   GET  /v1/sessions/:id/events?token=<pairingToken>      (SSE: SessionEvent)
 *   POST /v1/sessions/:id/messages?token=<pairingToken>     (SessionCommand)
 *   GET  /v1/devices/:id/commands?token=<pairingToken>      (SSE: DeviceCommand)
 *   POST /v1/devices/:id/sessions/:sid/events?token=<pairingToken>  (SessionEvent)
 *
 * The relay routes commands controller→app and events app→controller, fanning
 * out to whichever SSE subscribers are connected, and buffering anything
 * published before a subscriber connects.
 */

import express, { type Request, type Response } from 'express';

// ── Self-contained wire types (mirror shared/protocol; kept loose so this
//    package has zero cross-package compile coupling). ───────────────────────

type SessionMode = 'ask' | 'edit' | 'do' | 'note' | 'browser' | 'control';

interface PairRequest {
  deviceName: string;
  apiKey: string;
}
interface PairResponse {
  deviceId: string;
  pairingToken: string;
  expiresAt: string;
}
interface CreateSessionRequest {
  deviceId: string;
  pairingToken: string;
  mode: SessionMode;
  options: { provider: string; model: string; [k: string]: unknown };
  prompt: string;
  apiKey: string;
}

type SessionEvent = { type: string; [k: string]: unknown };
type SessionCommand = { type: 'reply' | 'confirm' | 'cancel'; [k: string]: unknown };
type DeviceCommand = { type: 'start' | 'reply' | 'confirm' | 'cancel'; sessionId?: string; mode?: SessionMode; options?: unknown; prompt?: string; content?: string; actionId?: string; decision?: 'allow' | 'deny'; reason?: string; [k: string]: unknown };

interface Device {
  deviceId: string;
  pairingToken: string;
  name: string;
  createdAt: string;
  commandQueue: DeviceCommand[];
  commandSubs: Response[];
}
interface Session {
  sessionId: string;
  deviceId: string;
  eventQueue: SessionEvent[];
  eventSubs: Response[];
}

// ── In-memory state ──────────────────────────────────────────────────────────

const devices = new Map<string, Device>();
const sessions = new Map<string, Session>();
let deviceCounter = 0;
let sessionCounter = 0;

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function beginSse(res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function notifyDevice(device: Device): void {
  if (device.commandSubs.length === 0 || device.commandQueue.length === 0) return;
  const cmds = device.commandQueue.splice(0); // drain the queue, KEEP the subscribers
  for (const res of device.commandSubs) {
    try {
      for (const cmd of cmds) sendSse(res, cmd.type, cmd);
    } catch {
      /* dead subscriber — cleaned up by the req close handler */
    }
  }
}

function notifySession(session: Session): void {
  if (session.eventSubs.length === 0 || session.eventQueue.length === 0) return;
  const events = session.eventQueue.splice(0); // drain the queue, KEEP the subscribers
  for (const res of session.eventSubs) {
    try {
      for (const ev of events) sendSse(res, ev.type as string, ev);
    } catch {
      /* dead subscriber — cleaned up by the req close handler */
    }
  }
}

function validateDevice(token: string, deviceId: string): Device | null {
  const device = devices.get(deviceId);
  if (!device || device.pairingToken !== token) return null;
  return device;
}

function isBrokerKeyOk(apiKey: string | undefined): boolean {
  const expected = process.env.ASKII_RELAY_KEY;
  if (!expected) return true; // mock is open by default
  return !!apiKey && apiKey === expected;
}

// ── App ─────────────────────────────────────────────────────────────────────

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/v1/sessions/pair', (req: Request, res: Response) => {
    const body = req.body as PairRequest | undefined;
    if (!body?.deviceName || !isBrokerKeyOk(body.apiKey)) {
      return res.status(400).json({ error: 'invalid pair request' });
    }
    const deviceId = `dev-${++deviceCounter}`;
    const pairingToken = `tok-${deviceId}-${randomToken()}`;
    const device: Device = {
      deviceId,
      pairingToken,
      name: body.deviceName,
      createdAt: new Date().toISOString(),
      commandQueue: [],
      commandSubs: [],
    };
    devices.set(deviceId, device);
    const out: PairResponse = {
      deviceId,
      pairingToken,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    };
    res.json(out);
  });

  app.post('/v1/sessions', (req: Request, res: Response) => {
    const body = req.body as CreateSessionRequest | undefined;
    if (!body?.deviceId || !body?.prompt || !body?.mode) {
      return res.status(400).json({ error: 'invalid create-session request' });
    }
    if (!isBrokerKeyOk(body.apiKey)) {
      return res.status(401).json({ error: 'invalid broker apiKey' });
    }
    const device = devices.get(body.deviceId);
    if (!device || device.pairingToken !== body.pairingToken) {
      return res.status(403).json({ error: 'device not paired or token mismatch' });
    }
    const sessionId = `ses-${++sessionCounter}`;
    const session: Session = { sessionId, deviceId: device.deviceId, eventQueue: [], eventSubs: [] };
    sessions.set(sessionId, session);

    // Tell the device to start executing.
    const startCmd: DeviceCommand = {
      type: 'start',
      sessionId,
      mode: body.mode,
      options: body.options,
      prompt: body.prompt,
    };
    device.commandQueue.push(startCmd);
    notifyDevice(device);

    // And let the controller know the session exists.
    session.eventQueue.push({ type: 'session_created', sessionId });
    notifySession(session);

    res.json({ sessionId });
  });

  app.get('/v1/sessions/:id/events', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const token = String(req.query.token ?? '');
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const device = devices.get(session.deviceId);
    if (!device || device.pairingToken !== token) {
      return res.status(403).json({ error: 'token mismatch' });
    }
    beginSse(res);
    session.eventSubs.push(res);
    notifySession(session); // flush anything already queued
    const hb = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      session.eventSubs = session.eventSubs.filter((r) => r !== res);
    });
  });

  app.post('/v1/sessions/:id/messages', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const token = String(req.query.token ?? '');
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const device = devices.get(session.deviceId);
    if (!device || device.pairingToken !== token) {
      return res.status(403).json({ error: 'token mismatch' });
    }
    const cmd = req.body as SessionCommand | undefined;
    if (!cmd?.type) return res.status(400).json({ error: 'invalid command' });

    let deviceCmd: DeviceCommand;
    if (cmd.type === 'reply') deviceCmd = { type: 'reply', sessionId, content: cmd.content as string };
    else if (cmd.type === 'confirm')
      deviceCmd = {
        type: 'confirm',
        sessionId,
        actionId: cmd.actionId as string,
        decision: cmd.decision as 'allow' | 'deny',
        reason: cmd.reason as string | undefined,
      };
    else deviceCmd = { type: 'cancel', sessionId };

    device.commandQueue.push(deviceCmd);
    notifyDevice(device);
    res.status(204).end();
  });

  app.get('/v1/devices/:id/commands', (req: Request, res: Response) => {
    const deviceId = req.params.id;
    const token = String(req.query.token ?? '');
    const device = validateDevice(token, deviceId);
    if (!device) return res.status(403).json({ error: 'device not paired or token mismatch' });
    beginSse(res);
    device.commandSubs.push(res);
    notifyDevice(device); // flush anything already queued
    const hb = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      device.commandSubs = device.commandSubs.filter((r) => r !== res);
    });
  });

  app.post('/v1/devices/:id/sessions/:sid/events', (req: Request, res: Response) => {
    const deviceId = req.params.id;
    const sid = req.params.sid;
    const token = String(req.query.token ?? '');
    const device = validateDevice(token, deviceId);
    if (!device) return res.status(403).json({ error: 'token mismatch' });
    const session = sessions.get(sid);
    if (!session || session.deviceId !== device.deviceId) {
      return res.status(404).json({ error: 'session not found for device' });
    }
    const event = req.body as SessionEvent | undefined;
    if (!event?.type) return res.status(400).json({ error: 'invalid event' });
    session.eventQueue.push(event);
    notifySession(session);
    res.status(204).end();
  });

  app.get('/v1/health', (_req: Request, res: Response) => {
    res.json({ ok: true, devices: devices.size, sessions: sessions.size });
  });

  return app;
}

/** Start the relay on the given port (0 = let the OS pick a free one). Returns the handle + chosen port. */
export function startServer(port = 0, hostname = '127.0.0.1'): Promise<{
  port: number;
  hostname: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = app.listen(port, hostname, () => {
      const addr = server.address();
      const chosen = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: chosen,
        hostname,
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

if (require.main === module) {
  const port = parseInt(process.env.PORT ?? '4242', 10);
  startServer(port).then((handle) => {
    // eslint-disable-next-line no-console
    console.log(
      `ASKII relay listening on http://${handle.hostname}:${handle.port} ( •_•)>⌐■-■ (⌐■_■)`,
    );
  });
}