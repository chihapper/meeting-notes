// "Test connections" — checks the three things the app depends on, using the
// settings currently in the form (so the user can verify before saving).
const { spawn } = require('child_process');

async function testOllama(settings) {
  const base = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const want = settings.ollamaModel || 'qwen2.5';
  try {
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) return { ok: false, msg: `Ollama responded ${res.status}` };
    const json = await res.json();
    const models = (json.models || []).map((m) => m.name);
    const has = models.some((n) => n === want || n.startsWith(`${want}:`));
    return has
      ? { ok: true, msg: `Up — model "${want}" is available` }
      : { ok: false, msg: `Up, but "${want}" isn't pulled. Run: ollama pull ${want}` };
  } catch (e) {
    return { ok: false, msg: `Can't reach Ollama at ${base}. Is it running? (${e.message})` };
  }
}

async function testClickup(settings) {
  if (!settings.clickupKey) return { ok: false, msg: 'No API token set.' };
  if (!settings.clickupListId) return { ok: false, msg: 'No List ID set.' };
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${settings.clickupListId}`, {
      headers: { Authorization: settings.clickupKey },
    });
    if (res.status === 200) {
      const json = await res.json();
      return { ok: true, msg: `OK — list "${json.name || settings.clickupListId}"` };
    }
    if (res.status === 401) return { ok: false, msg: 'Token rejected (401).' };
    if (res.status === 404) return { ok: false, msg: 'List ID not found (404).' };
    return { ok: false, msg: `ClickUp responded ${res.status}` };
  } catch (e) {
    return { ok: false, msg: `Can't reach ClickUp (${e.message})` };
  }
}

async function testAssemblyai(settings) {
  if (!settings.assemblyaiKey) return { ok: false, msg: 'No API key set (only needed for Cloud mode).' };
  try {
    const res = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
      headers: { authorization: settings.assemblyaiKey },
    });
    if (res.status === 200) return { ok: true, msg: 'API key valid' };
    if (res.status === 401) return { ok: false, msg: 'API key rejected (401).' };
    return { ok: false, msg: `AssemblyAI responded ${res.status}` };
  } catch (e) {
    return { ok: false, msg: `Can't reach AssemblyAI (${e.message})` };
  }
}

async function testAnthropic(settings) {
  if (!settings.anthropicKey) return { ok: false, msg: 'No key set (only needed for Claude summarizer).' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01' },
    });
    if (res.status === 200) return { ok: true, msg: 'API key valid' };
    if (res.status === 401) return { ok: false, msg: 'API key rejected (401).' };
    return { ok: false, msg: `Anthropic responded ${res.status}` };
  } catch (e) {
    return { ok: false, msg: `Can't reach Anthropic (${e.message})` };
  }
}

async function testOpenai(settings) {
  if (!settings.openaiKey) return { ok: false, msg: 'No key set (only needed for OpenAI summarizer).' };
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${settings.openaiKey}` },
    });
    if (res.status === 200) return { ok: true, msg: 'API key valid' };
    if (res.status === 401) return { ok: false, msg: 'API key rejected (401).' };
    return { ok: false, msg: `OpenAI responded ${res.status}` };
  } catch (e) {
    return { ok: false, msg: `Can't reach OpenAI (${e.message})` };
  }
}

const STUB_RE = /was not found|Microsoft Store|App execution alias|reparse point/i;
const PYTHON_HELP =
  'Install Python from python.org (tick "Add to PATH"), or set the Python path to "py". On Windows, the bare "python" command often points to a Microsoft Store stub instead of real Python.';

function testPython(settings) {
  // Imports whisperx + torch and reports CUDA availability. Can take a few
  // seconds the first time (loads torch).
  return new Promise((resolve) => {
    const python = settings.pythonPath || 'python';
    const proc = spawn(python, ['-c', 'import whisperx, torch; print(torch.cuda.is_available())']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', () => resolve({ ok: false, msg: `Python "${python}" not found. ${PYTHON_HELP}` }));
    proc.on('close', (code) => {
      const blob = out + err;
      if (STUB_RE.test(blob)) {
        return resolve({ ok: false, msg: `"${python}" is the Windows Store stub, not real Python. ${PYTHON_HELP}` });
      }
      if (code !== 0) {
        if (/whisperx/i.test(blob) && /No module|ModuleNotFound/i.test(blob)) {
          return resolve({ ok: false, msg: 'Python works, but WhisperX isn\'t installed. Run: pip install whisperx' });
        }
        if (/torch/i.test(blob) && /No module|ModuleNotFound/i.test(blob)) {
          return resolve({ ok: false, msg: 'Python works, but PyTorch isn\'t installed (see setup: pip install torch ...).' });
        }
        return resolve({ ok: false, msg: `whisperx import failed: ${blob.trim().slice(-200)}` });
      }
      const cuda = out.trim().endsWith('True');
      resolve({
        ok: true,
        msg: cuda
          ? 'WhisperX OK — CUDA (GPU) available ✓'
          : 'WhisperX OK, but CUDA NOT detected — it will run on CPU (slow)',
      });
    });
  });
}

// ---- Fast readiness checks (no heavy torch import) used to gate the Record button ----

function quickPython(settings) {
  return new Promise((resolve) => {
    const python = settings.pythonPath || 'python';
    const proc = spawn(python, ['--version']);
    let blob = '';
    proc.stdout.on('data', (d) => (blob += d.toString()));
    proc.stderr.on('data', (d) => (blob += d.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (STUB_RE.test(blob)) return resolve(false);
      resolve(code === 0 && /Python\s+3/i.test(blob));
    });
  });
}

async function quickOllama(settings) {
  const base = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  try {
    return (await fetch(`${base}/api/tags`)).ok;
  } catch {
    return false;
  }
}

async function checkReadiness(settings) {
  let transcription;
  if (settings.transcriptionMode === 'cloud') {
    transcription = settings.assemblyaiKey
      ? { ready: true }
      : { ready: false, reason: 'Cloud transcription needs an AssemblyAI key — open Settings → Cloud.' };
  } else {
    transcription = (await quickPython(settings))
      ? { ready: true }
      : { ready: false, reason: 'Local transcription needs Python + WhisperX installed — open Settings → Local, or switch to Cloud.' };
  }

  let summarizer;
  if (settings.summarizerMode === 'claude') {
    summarizer = settings.anthropicKey
      ? { ready: true }
      : { ready: false, reason: 'Claude summarizer needs an Anthropic API key — open Settings.' };
  } else if (settings.summarizerMode === 'openai') {
    summarizer = settings.openaiKey
      ? { ready: true }
      : { ready: false, reason: 'OpenAI summarizer needs an API key — open Settings.' };
  } else {
    summarizer = (await quickOllama(settings))
      ? { ready: true }
      : { ready: false, reason: 'Ollama isn\'t reachable — install it (ollama.com) and pull a model, or pick a cloud summarizer in Settings.' };
  }

  return { transcription, summarizer };
}

// Only test the services the current configuration actually uses, so testing
// "Local" doesn't report errors for unrelated cloud services you never set up.
async function testConnections(settings) {
  const results = {};
  const jobs = [];

  if (settings.transcriptionMode === 'cloud') {
    jobs.push(testAssemblyai(settings).then((r) => (results.assemblyai = r)));
  } else {
    jobs.push(testPython(settings).then((r) => (results.python = r)));
  }

  if (settings.summarizerMode === 'claude') {
    jobs.push(testAnthropic(settings).then((r) => (results.anthropic = r)));
  } else if (settings.summarizerMode === 'openai') {
    jobs.push(testOpenai(settings).then((r) => (results.openai = r)));
  } else {
    jobs.push(testOllama(settings).then((r) => (results.ollama = r)));
  }

  if (settings.taskDestination === 'clickup') {
    jobs.push(testClickup(settings).then((r) => (results.clickup = r)));
  }

  await Promise.all(jobs);
  return results;
}

module.exports = { testConnections, checkReadiness };
