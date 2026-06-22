// Settings persistence. Keys + config live in a JSON file in the OS per-user
// app-data dir (not in the repo), so secrets never touch git.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  // Has the first-run setup wizard been completed?
  setupComplete: false,

  // Transcription: 'cloud' (AssemblyAI) or 'local' (WhisperX on the GPU).
  // Cloud is the default — local requires a Python/GPU setup most users won't do.
  transcriptionMode: 'cloud',
  assemblyaiKey: '',

  // Summarization: 'claude', 'openai', or 'ollama' (local). Cloud default.
  summarizerMode: 'claude',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.5',
  unloadOllama: false,
  anthropicKey: '',
  anthropicModel: 'claude-opus-4-8',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',

  // Action items: 'native' (kept in this app) or 'clickup'
  taskDestination: 'native',
  clickupKey: '',
  clickupListId: '',

  // Recording
  captureSystemAudio: true,

  // WhisperX (local transcription on the GPU)
  pythonPath: 'python',
  hfToken: '',
  whisperModel: 'medium',
  whisperDevice: 'cuda',
  whisperCompute: 'int8',
  whisperLanguage: '',
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { loadSettings, saveSettings, SETTINGS_PATH };
