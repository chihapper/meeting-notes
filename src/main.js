const { app, BrowserWindow, ipcMain, session, desktopCapturer, Notification, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { loadSettings, saveSettings } = require('./config');
const store = require('./store');
const { transcribe: transcribeLocal } = require('./services/transcribe');
const { transcribe: transcribeCloud } = require('./services/transcribe_cloud');
const { summarize } = require('./services/summarize');
const { createTask, createParentTask, attachTranscript, getListUrl } = require('./services/clickup');
const { testConnections, checkReadiness } = require('./services/diagnostics');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 640,
    minHeight: 560,
    title: 'Meeting Notes',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

app.whenReady().then(() => {
  app.setAppUserModelId('com.meetingnotes.app'); // so Windows toasts show the app name
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
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

// ---- IPC handlers ----

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, partial) => saveSettings(partial));

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
    const meeting = {
      id: `m_${Date.now()}`,
      date: now.toISOString(),
      title: `Meeting — ${now.toLocaleString()}`,
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
          await attachTranscript(key, parent.id, meeting.transcript);
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
