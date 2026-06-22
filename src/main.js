const { app, BrowserWindow, ipcMain, session, desktopCapturer, Notification, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');

const { loadSettings, saveSettings } = require('./config');
const store = require('./store');
const { transcribe: transcribeLocal } = require('./services/transcribe');
const { transcribe: transcribeCloud } = require('./services/transcribe_cloud');
const { summarize } = require('./services/summarize');
const { createTask, createParentTask, attachFile, getListUrl } = require('./services/clickup');
const { buildMeetingDocx } = require('./services/docgen');
const { testConnections, checkReadiness } = require('./services/diagnostics');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 640,
    minHeight: 560,
    title: 'Meeting Notes',
    backgroundColor: '#0f1115',
    show: false, // shown explicitly unless launched hidden into the tray
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In background mode, closing the window hides it to the tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting && loadSettings().runInBackground) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Enable system-audio loopback capture for getDisplayMedia() in the renderer.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Build a small tray icon (a filled accent dot) in-memory — no icon file needed.
function makeTrayImage() {
  const W = 32;
  const H = 32;
  const cx = 15.5;
  const cy = 15.5;
  const r = 15;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.hypot(x - cx, y - cy) <= r) {
        px[i] = 0x6e;
        px[i + 1] = 0xa8;
        px[i + 2] = 0xfe;
        px[i + 3] = 0xff;
      }
    }
  }
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  const idat = zlib.deflateSync(raw);
  const crc32 = (b) => {
    let c = ~0;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}

function createTray() {
  if (tray) return;
  tray = new Tray(makeTrayImage());
  tray.setToolTip('Meeting Notes');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Meeting Notes', click: () => showMainWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ])
  );
  tray.on('click', () => showMainWindow());
}

// Apply login-item + tray state from settings (called at startup and after Save).
function applyBackgroundSettings(s) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!s.autoStartLogin, args: ['--hidden'] });
  }
  if (s.runInBackground) {
    createTray();
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
}

// Single instance: if the call trigger (or the user) launches the app while it's
// already running, focus the existing one instead of opening a second copy.
// A "--hidden" relaunch (from the trigger, while already up) is ignored.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!argv.includes('--hidden')) showMainWindow();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  app.setAppUserModelId('com.meetingnotes.app'); // so Windows toasts show the app name
  const settings = loadSettings();
  createWindow();
  applyBackgroundSettings(settings);

  // Stay hidden in the tray when launched at login (or with --hidden) in background mode.
  const launchedHidden =
    process.argv.includes('--hidden') ||
    (process.platform === 'win32' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!(settings.runInBackground && launchedHidden)) {
    mainWindow.show();
  }

  startCallWatcher();
  app.on('activate', () => showMainWindow());
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // In background mode the window only hides, so this won't fire; quit otherwise.
  if (process.platform !== 'darwin') app.quit();
});

// Progress is a {stage, message} object so the renderer can drive the bar.
// stage ∈ preparing | transcribing | summarizing | saving | done | error
function sendProgress(stage, message) {
  mainWindow?.webContents.send('progress', { stage, message });
}

function notifyDone(meeting) {
  if (!Notification.isSupported()) return;
  const n = (meeting.actionItems || []).length;
  new Notification({
    title: 'Meeting Notes — summary ready',
    body: `${n} action item${n === 1 ? '' : 's'} captured.`,
  }).show();
}

// ---- Zoom/Teams call detection (Windows) ----
// Checks the Windows mic ConsentStore for an app (Zoom/Teams) currently using the
// mic (LastUsedTimeStop == 0 means in use right now). Best-effort + heuristic.
const { spawn } = require('child_process');

// Outputs two lines: (1) the app currently using the mic — "Zoom"/"Teams"/blank;
// (2) "1" if a Zoom/Teams process is running at all, else "0".
const CALL_PROBE = `
$ErrorActionPreference='SilentlyContinue'
$base='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
$apps=@()
foreach($k in (Get-ChildItem "$base\\NonPackaged")){ if((Get-ItemProperty $k.PSPath).LastUsedTimeStop -eq 0){ $apps+=$k.PSChildName } }
foreach($k in (Get-ChildItem $base | Where-Object {$_.PSChildName -ne 'NonPackaged'})){ if((Get-ItemProperty $k.PSPath).LastUsedTimeStop -eq 0){ $apps+=$k.PSChildName } }
$m=$apps | Where-Object { $_ -match 'zoom' -or $_ -match 'teams' } | Select-Object -First 1
$mic = if($m){ if($m -match 'zoom'){'Zoom'} else {'Teams'} } else { '' }
$running = if(Get-Process -Name 'Zoom','Teams','ms-teams' -ErrorAction SilentlyContinue){'1'}else{'0'}
Write-Output $mic
Write-Output $running
`;

function probeCalls() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ app: null, running: false });
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', CALL_PROBE]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve({ app: null, running: false }));
    proc.on('close', () => {
      const lines = out.split(/\r?\n/).map((l) => l.trim());
      const app = lines[0] === 'Zoom' || lines[0] === 'Teams' ? lines[0] : null;
      const running = lines.includes('1');
      resolve({ app, running });
    });
  });
}

let lastInCall = false;

function promptRecord(app) {
  mainWindow?.webContents.send('call-detected', app);
  if (Notification.isSupported()) {
    const n = new Notification({ title: `${app} call detected`, body: 'Click to record this call in Meeting Notes.' });
    n.on('click', () => showMainWindow());
    n.show();
  }
}

async function checkForCall() {
  const s = loadSettings();
  if (!s.watchCalls && !s.autoQuitNoCall) {
    lastInCall = false;
    return;
  }
  const { app: callApp, running } = await probeCalls();

  if (s.watchCalls) {
    const inCall = !!callApp;
    if (inCall && !lastInCall) promptRecord(callApp); // call started → prompt
    if (!inCall && lastInCall) mainWindow?.webContents.send('call-ended'); // call ended → dismiss banner
    lastInCall = inCall;
  }

  // Auto-quit when no call app is running — only while hidden in the tray, to avoid
  // closing a window you're actively using.
  if (s.autoQuitNoCall && s.runInBackground && !running && mainWindow && !mainWindow.isVisible()) {
    isQuitting = true;
    app.quit();
  }
}

function startCallWatcher() {
  setInterval(checkForCall, 8000);
}

// ---- IPC handlers ----

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, partial) => {
  const merged = saveSettings(partial);
  applyBackgroundSettings(merged);
  return merged;
});

// Record -> transcribe -> summarize -> save to the local meetings library.
ipcMain.handle('recording:process', async (_e, arrayBuffer) => {
  const settings = loadSettings();
  const tmpPath = path.join(os.tmpdir(), `meeting-${Date.now()}.webm`);
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
  try {
    sendProgress('preparing', 'Preparing audio…');
    const transcribe = settings.transcriptionMode === 'cloud' ? transcribeCloud : transcribeLocal;
    const transcript = await transcribe(settings, tmpPath, (msg) => sendProgress('transcribing', msg));
    sendProgress('summarizing', 'Summarizing…');
    const result = await summarize(settings, transcript);
    sendProgress('saving', 'Saving…');
    const now = new Date();
    const attendees = (result.attendees || []).filter(Boolean);
    const who = attendees.length
      ? ` with ${attendees.slice(0, 4).join(', ')}${attendees.length > 4 ? ' +others' : ''}`
      : '';
    const meeting = {
      id: `m_${Date.now()}`,
      date: now.toISOString(),
      title: `Meeting${who} — ${now.toLocaleString()}`,
      attendees,
      summary: result.summary || '',
      decisions: result.decisions || [],
      actionItems: (result.actionItems || []).map((it) => ({ ...it, done: false })),
      transcript,
    };
    store.add(meeting);

    // Auto-create ClickUp tasks when that's the destination: one parent "meeting"
    // task (with the transcript attached) + each action item as a subtask.
    if (settings.taskDestination === 'clickup' && settings.clickupKey && settings.clickupListId) {
      sendProgress('saving', 'Creating ClickUp tasks…');
      const { clickupKey: key, clickupListId: listId } = settings;
      try {
        const parent = await createParentTask(key, listId, meeting);
        meeting.clickupParentId = parent.id;
        meeting.clickupParentUrl = parent.url;
        try {
          const docBuf = await buildMeetingDocx(meeting);
          await attachFile(
            key,
            parent.id,
            docBuf,
            'meeting-notes.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          );
        } catch (e) {
          meeting.clickupAttachError = e.message;
        }
        for (const item of meeting.actionItems) {
          try {
            const task = await createTask(key, listId, item, null, parent.id); // subtask
            item.clickupUrl = task.url;
          } catch (e) {
            item.clickupError = e.message;
          }
        }
      } catch (e) {
        // Parent couldn't be created — fall back to flat tasks so nothing is lost.
        meeting.clickupParentError = e.message;
        for (const item of meeting.actionItems) {
          try {
            const task = await createTask(key, listId, item, meeting.summary);
            item.clickupUrl = task.url;
          } catch (err) {
            item.clickupError = err.message;
          }
        }
      }
      store.update(meeting.id, {
        actionItems: meeting.actionItems,
        clickupParentId: meeting.clickupParentId,
        clickupParentUrl: meeting.clickupParentUrl,
      });
    }

    sendProgress('done', 'Done');
    notifyDone(meeting);
    return { ok: true, meeting };
  } catch (err) {
    sendProgress('error', err.message);
    return { ok: false, error: err.message };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('clickup:listUrl', async () => {
  const s = loadSettings();
  try {
    return await getListUrl(s.clickupKey, s.clickupListId);
  } catch {
    return null;
  }
});

ipcMain.handle('diagnostics:test', (_e, settings) => testConnections(settings));
ipcMain.handle('readiness:check', (_e, settings) => checkReadiness(settings));

// --- In-app setup of the Zoom/Teams launch trigger (no manual PowerShell) ---
// Runs the bundled setup script elevated (one UAC prompt). The task launches the
// real exe — process.env.PORTABLE_EXECUTABLE_FILE for the portable build, else execPath.
function triggerScriptPath() {
  return path
    .join(app.getAppPath(), 'scripts', 'setup-call-trigger.ps1')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
function appExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function runTriggerSetup(enable) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Windows only.' });
    const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', triggerScriptPath(), '-ExePath', appExePath()];
    if (!enable) inner.push('-Uninstall');
    const argList = inner.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
    // Elevate via UAC and wait for the elevated script to finish.
    const cmd = `Start-Process -FilePath powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ${argList}`;
    const proc = spawn('powershell', ['-NoProfile', '-Command', cmd]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || 'Admin approval was declined or setup failed.' })
    );
  });
}

function triggerStatus() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const proc = spawn('schtasks', ['/query', '/TN', 'MeetingNotesZoom']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

ipcMain.handle('trigger:status', () => triggerStatus());
ipcMain.handle('trigger:set', (_e, enable) => runTriggerSetup(enable));

// List the models actually pulled in the local Ollama, for the Settings dropdown.
ipcMain.handle('ollama:models', async (_e, url) => {
  const base = (url || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.models || []).map((m) => m.name);
  } catch {
    return [];
  }
});

// List Claude models available to the user's Anthropic key.
ipcMain.handle('anthropic:models', async (_e, key) => {
  if (!key) return [];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  } catch {
    return [];
  }
});

// List chat-capable OpenAI models available to the user's key.
ipcMain.handle('openai:models', async (_e, key) => {
  if (!key) return [];
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o[1-9]|chatgpt)/i.test(id))
      .sort();
  } catch {
    return [];
  }
});

ipcMain.handle('clickup:create', async (_e, { item, summary, parentId }) => {
  const settings = loadSettings();
  try {
    const task = await createTask(settings.clickupKey, settings.clickupListId, item, summary, parentId);
    return { ok: true, ...task };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Meetings library ----
ipcMain.handle('meetings:list', () => store.list());
ipcMain.handle('meetings:update', (_e, { id, patch }) => store.update(id, patch));
ipcMain.handle('meetings:delete', (_e, id) => {
  store.remove(id);
  return { ok: true };
});
