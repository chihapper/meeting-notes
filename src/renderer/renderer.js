// Renderer: audio capture, results, Meetings library, Settings, and first-run wizard.
const $ = (id) => document.getElementById(id);

let mediaRecorder = null;
let chunks = [];
let activeStreams = [];
let audioCtx = null;
let timerInterval = null;
let startedAt = 0;
let currentMode = 'local'; // transcription mode
let currentMeeting = null; // meeting shown in the record view

// ---------- Recording ----------

async function startRecording() {
  const settings = await window.api.getSettings();
  chunks = [];
  activeStreams = [];
  $('progress').classList.add('hidden');
  $('callBanner').classList.add('hidden');

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  activeStreams.push(micStream);

  let sysStream = null;
  if (settings.captureSystemAudio) {
    try {
      sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      sysStream.getVideoTracks().forEach((t) => t.stop());
      activeStreams.push(sysStream);
    } catch {
      setStatus('System audio unavailable — recording microphone only.');
    }
  }

  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  audioCtx.createMediaStreamSource(micStream).connect(dest);
  if (sysStream && sysStream.getAudioTracks().length) {
    audioCtx.createMediaStreamSource(sysStream).connect(dest);
  }

  mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = handleRecordingStopped;
  mediaRecorder.start();

  startedAt = Date.now();
  timerInterval = setInterval(updateTimer, 250);
  setRecordingUI(true);
  setStatus(sysStream ? 'Recording (mic + system audio)…' : 'Recording (mic)…');
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(timerInterval);
  activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) audioCtx.close();
  setRecordingUI(false);
}

async function handleRecordingStopped() {
  setProgress('preparing', 'Processing…');
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const arrayBuffer = await blob.arrayBuffer();
  const result = await window.api.processRecording(arrayBuffer);
  if (!result.ok) {
    setProgress('error', `Error: ${result.error}`);
    return;
  }
  setProgress('done', 'Done — saved to Meetings.');
  const settings = await window.api.getSettings();
  currentMeeting = result.meeting;
  renderResults(result.meeting, settings.taskDestination === 'clickup');
}

// Drives the staged progress bar. stage ∈ preparing|transcribing|summarizing|saving|done|error
const STAGE = {
  preparing: { pct: 8, step: 'transcribing' },
  transcribing: { pct: 55, step: 'transcribing' },
  summarizing: { pct: 85, step: 'summarizing' },
  saving: { pct: 95, step: 'summarizing' },
  done: { pct: 100, step: 'done' },
  error: { pct: 100, step: null },
};

function setProgress(stage, message) {
  const info = STAGE[stage] || STAGE.preparing;
  const wrap = $('progress');
  wrap.classList.remove('hidden');
  $('barFill').style.width = `${info.pct}%`;
  wrap.classList.toggle('active', stage !== 'done' && stage !== 'error');
  wrap.classList.toggle('done', stage === 'done');
  wrap.classList.toggle('error', stage === 'error');
  const order = ['transcribing', 'summarizing', 'done'];
  const activeIdx = order.indexOf(info.step);
  document.querySelectorAll('.step').forEach((s) => {
    const idx = order.indexOf(s.dataset.step);
    s.classList.toggle('active', !!info.step && s.dataset.step === info.step && stage !== 'done');
    s.classList.toggle('complete', stage === 'done' || (activeIdx > -1 && idx < activeIdx));
  });
  $('firstRunHint').classList.toggle('hidden', stage !== 'transcribing');
  if (message) setStatus(message);
}

// ---------- UI helpers ----------

function setRecordingUI(recording) {
  const btn = $('recordBtn');
  btn.textContent = recording ? '■ Stop' : '● Record';
  btn.classList.toggle('recording', recording);
}

function setStatus(msg) {
  $('status').textContent = msg;
}

function setMode(mode) {
  currentMode = mode === 'cloud' ? 'cloud' : 'local';
  $('modeLocal').classList.toggle('active', currentMode === 'local');
  $('modeCloud').classList.toggle('active', currentMode === 'cloud');
}

// Gray out Record unless the active transcription + summarizer are configured.
async function updateRecordReadiness() {
  let r;
  try {
    const settings = await window.api.getSettings();
    r = await window.api.checkReadiness(settings);
  } catch {
    return;
  }
  const reasons = [];
  if (!r.transcription.ready) reasons.push(r.transcription.reason);
  if (!r.summarizer.ready) reasons.push(r.summarizer.reason);
  const btn = $('recordBtn');
  if (reasons.length) {
    btn.classList.add('disabled');
    btn.dataset.tip = reasons.join('  •  ');
  } else {
    btn.classList.remove('disabled');
    delete btn.dataset.tip;
  }
}

function updateTimer() {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  $('timer').textContent = `${mm}:${ss}`;
}

// ---------- Results (record view) ----------

function renderResults(meeting, clickup) {
  $('summary').textContent = meeting.summary || '(none)';

  const decisions = $('decisions');
  decisions.innerHTML = '';
  (meeting.decisions || []).forEach((d) => {
    const li = document.createElement('li');
    li.textContent = d;
    decisions.appendChild(li);
  });
  if (!meeting.decisions || !meeting.decisions.length) {
    decisions.innerHTML = '<li class="meta">No explicit decisions captured.</li>';
  }

  const list = $('actionItems');
  list.innerHTML = '';
  (meeting.actionItems || []).forEach((item, i) => list.appendChild(actionRow(meeting, item, i, clickup)));
  if (!meeting.actionItems || !meeting.actionItems.length) {
    list.innerHTML = '<div class="meta">No action items found.</div>';
  }

  $('pushAllBtn').classList.add('hidden'); // ClickUp push is automatic now
  $('savedNote').classList.remove('hidden');

  const linkEl = $('clickupLink');
  linkEl.innerHTML = '';
  linkEl.classList.add('hidden');
  if (clickup) {
    const addLink = (text, url) => {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'extlink';
      a.textContent = text;
      a.onclick = (e) => {
        e.preventDefault();
        window.api.openExternal(url);
      };
      linkEl.appendChild(a);
      linkEl.classList.remove('hidden');
    };
    if (meeting.clickupParentUrl) {
      addLink('Open the meeting task in ClickUp ↗', meeting.clickupParentUrl);
    } else {
      window.api.getClickupListUrl().then((url) => {
        if (url) addLink('Open the list in ClickUp ↗', url);
      });
    }
  }

  $('transcript').textContent = meeting.transcript || '';
  buildSpeakers(meeting);
  $('results').classList.remove('hidden');
}

// One action-item row. The checkbox is a persistent "done" toggle; when ClickUp
// is the destination, also shows an "Add to ClickUp" button.
function actionRow(meeting, item, index, clickup) {
  const row = document.createElement('div');
  row.className = 'action';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = !!item.done;
  check.title = 'Mark done';
  check.onchange = () => {
    meeting.actionItems[index].done = check.checked;
    taskText.classList.toggle('done', check.checked);
    window.api.updateMeeting(meeting.id, { actionItems: meeting.actionItems });
  };

  const middle = document.createElement('div');
  const taskText = document.createElement('div');
  taskText.className = 'task-text' + (item.done ? ' done' : '');
  taskText.textContent = item.task;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [];
  if (item.owner) bits.push(`Owner: ${item.owner}`);
  if (item.dueDate) bits.push(`Due: ${item.dueDate}`);
  meta.textContent = bits.join('  •  ');
  middle.appendChild(taskText);
  middle.appendChild(meta);

  const right = document.createElement('div');
  right.className = 'row';
  const badge = document.createElement('span');
  badge.className = `badge ${item.priority}`;
  badge.textContent = item.priority;
  right.appendChild(badge);
  if (clickup) {
    if (item.clickupUrl) {
      // Already auto-pushed during processing.
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'extlink pushed';
      a.textContent = '✓ In ClickUp — view ↗';
      a.onclick = (e) => {
        e.preventDefault();
        window.api.openExternal(item.clickupUrl);
      };
      right.appendChild(a);
    } else {
      // Auto-push failed (or no key) — offer a manual retry.
      const pushBtn = document.createElement('button');
      pushBtn.className = 'small pushbtn';
      pushBtn.textContent = item.clickupError ? 'Retry' : 'Add to ClickUp';
      pushBtn.onclick = () => pushOne(meeting, item, index, right, pushBtn);
      right.appendChild(pushBtn);
      if (item.clickupError) {
        const err = document.createElement('span');
        err.className = 'pusherr';
        err.textContent = item.clickupError;
        right.appendChild(err);
      }
    }
  }

  row.appendChild(check);
  row.appendChild(middle);
  row.appendChild(right);
  return row;
}

// Manual retry for an item that failed to auto-push.
async function pushOne(meeting, item, index, container, btn) {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  // Retried items stay subtasks of the meeting's parent task (if one exists).
  const res = await window.api.createClickupTask(item, null, meeting.clickupParentId);
  container.querySelectorAll('.pushed, .pusherr').forEach((n) => n.remove());
  if (res.ok) {
    item.clickupUrl = res.url || '';
    delete item.clickupError;
    if (typeof index === 'number' && meeting.actionItems[index]) {
      meeting.actionItems[index] = item;
      window.api.updateMeeting(meeting.id, { actionItems: meeting.actionItems });
    }
    btn.remove();
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'extlink pushed';
    a.textContent = res.url ? '✓ In ClickUp — view ↗' : '✓ Added';
    a.onclick = (e) => {
      e.preventDefault();
      if (res.url) window.api.openExternal(res.url);
    };
    container.appendChild(a);
  } else {
    const note = document.createElement('span');
    note.className = 'pusherr';
    note.textContent = res.error;
    btn.disabled = false;
    btn.textContent = 'Retry';
    container.appendChild(note);
  }
}

// ---------- Speaker naming ----------

function buildSpeakers(meeting) {
  const labels = [...new Set((meeting.transcript || '').match(/SPEAKER_\d+/g) || [])].sort();
  const card = $('speakersCard');
  const box = $('speakers');
  box.innerHTML = '';
  if (labels.length < 1) {
    card.classList.add('hidden');
    return;
  }
  labels.forEach((label) => {
    const row = document.createElement('div');
    row.className = 'speaker-row';
    const tag = document.createElement('span');
    tag.className = 'badge normal';
    tag.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Name (e.g. Alex)';
    input.dataset.label = label;
    row.appendChild(tag);
    row.appendChild(input);
    box.appendChild(row);
  });
  card.classList.remove('hidden');
}

async function applyNames() {
  if (!currentMeeting) return;
  const map = {};
  $('speakers').querySelectorAll('input').forEach((inp) => {
    const name = inp.value.trim();
    if (name) map[inp.dataset.label] = name;
  });
  if (!Object.keys(map).length) return;

  const sub = (text) => {
    let out = String(text == null ? '' : text);
    for (const [label, name] of Object.entries(map)) out = out.split(label).join(name);
    return out;
  };

  currentMeeting = {
    ...currentMeeting,
    transcript: sub(currentMeeting.transcript),
    summary: sub(currentMeeting.summary),
    decisions: (currentMeeting.decisions || []).map(sub),
    actionItems: (currentMeeting.actionItems || []).map((it) => ({
      ...it,
      task: sub(it.task),
      owner: sub(it.owner),
    })),
  };

  // Persist the renamed version to the library.
  await window.api.updateMeeting(currentMeeting.id, {
    transcript: currentMeeting.transcript,
    summary: currentMeeting.summary,
    decisions: currentMeeting.decisions,
    actionItems: currentMeeting.actionItems,
  });

  const settings = await window.api.getSettings();
  renderResults(currentMeeting, settings.taskDestination === 'clickup');
}

// ---------- Meetings library ----------

async function showMeetings() {
  const meetings = await window.api.listMeetings();
  const list = $('meetingsList');
  list.innerHTML = '';
  $('meetingsEmpty').classList.toggle('hidden', meetings.length > 0);
  meetings.forEach((m) => list.appendChild(meetingCard(m)));
}

function meetingCard(meeting) {
  const card = document.createElement('div');
  card.className = 'card meeting';

  const head = document.createElement('div');
  head.className = 'card-head meeting-head';
  const title = document.createElement('div');
  const open = meeting.actionItems ? meeting.actionItems.filter((a) => !a.done).length : 0;
  title.innerHTML = `<strong>${escapeHtml(meeting.title)}</strong><div class="meta">${open} open action item${open === 1 ? '' : 's'}</div>`;
  const del = document.createElement('button');
  del.className = 'small ghost';
  del.textContent = 'Delete';
  del.onclick = async (e) => {
    e.stopPropagation();
    await window.api.deleteMeeting(meeting.id);
    showMeetings();
  };
  head.appendChild(title);
  head.appendChild(del);

  const body = document.createElement('div');
  body.className = 'meeting-body hidden';

  const sum = document.createElement('p');
  sum.textContent = meeting.summary || '(no summary)';
  body.appendChild(sum);

  if (meeting.actionItems && meeting.actionItems.length) {
    const h = document.createElement('div');
    h.className = 'meta sub';
    h.textContent = 'Action items';
    body.appendChild(h);
    meeting.actionItems.forEach((item, i) => {
      const r = document.createElement('label');
      r.className = 'bullet';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = !!item.done;
      const span = document.createElement('span');
      span.className = item.done ? 'done' : '';
      const owner = item.owner && item.owner !== 'Unassigned' ? ` — ${item.owner}` : '';
      span.textContent = `${item.task}${owner}`;
      c.onchange = () => {
        meeting.actionItems[i].done = c.checked;
        span.className = c.checked ? 'done' : '';
        title.querySelector('.meta').textContent = `${meeting.actionItems.filter((a) => !a.done).length} open action items`;
        window.api.updateMeeting(meeting.id, { actionItems: meeting.actionItems });
      };
      r.appendChild(c);
      r.appendChild(span);
      body.appendChild(r);
    });
  }

  head.onclick = () => body.classList.toggle('hidden');
  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Navigation ----------

function showView(view) {
  $('recordView').classList.toggle('hidden', view !== 'record');
  $('meetingsView').classList.toggle('hidden', view !== 'meetings');
  $('navRecord').classList.toggle('active', view === 'record');
  $('navMeetings').classList.toggle('active', view === 'meetings');
  if (view === 'meetings') showMeetings();
}

// ---------- Settings ----------

function applySummarizerVisibility() {
  const mode = $('summarizerMode').value;
  $('sumOllama').classList.toggle('hidden', mode !== 'ollama');
  $('sumClaude').classList.toggle('hidden', mode !== 'claude');
  $('sumOpenai').classList.toggle('hidden', mode !== 'openai');
}

function applyDestinationVisibility() {
  $('destClickup').classList.toggle('hidden', $('taskDestination').value !== 'clickup');
}

// Fill the Model dropdown with the models actually pulled in Ollama.
// Curated fallbacks used only when the live API list is unavailable (no key yet).
const CLAUDE_FALLBACK = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-7'];
const OPENAI_FALLBACK = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o3-mini'];

// Fill a <select> with model names. Keeps the saved value selected even if the
// live list is empty/unavailable; matches "qwen3.5" to "qwen3.5:latest".
function fillSelect(id, models, selected, emptyText) {
  const sel = $(id);
  sel.innerHTML = '';
  const list = (models || []).slice();
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = selected || '';
    opt.textContent = selected || emptyText;
    sel.appendChild(opt);
    sel.value = selected || '';
    return;
  }
  let chosen = list.find((n) => n === selected || (selected && n.startsWith(`${selected}:`)));
  if (!chosen && selected) {
    list.unshift(selected);
    chosen = selected;
  }
  list.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.value = chosen || list[0];
}

async function populateOllamaModels(selected) {
  let models = [];
  try {
    models = await window.api.listOllamaModels($('ollamaUrl').value.trim() || 'http://localhost:11434');
  } catch {}
  fillSelect('ollamaModel', models, selected, 'No models — start Ollama, pull one, then click ↻');
}

async function populateAnthropicModels(selected) {
  let models = [];
  try {
    models = await window.api.listAnthropicModels($('anthropicKey').value.trim());
  } catch {}
  fillSelect('anthropicModel', models.length ? models : CLAUDE_FALLBACK, selected, 'Enter key + click ↻');
}

async function populateOpenaiModels(selected) {
  let models = [];
  try {
    models = await window.api.listOpenaiModels($('openaiKey').value.trim());
  } catch {}
  fillSelect('openaiModel', models.length ? models : OPENAI_FALLBACK, selected, 'Enter key + click ↻');
}

async function openSettings() {
  const s = await window.api.getSettings();
  $('summarizerMode').value = s.summarizerMode || 'ollama';
  $('ollamaUrl').value = s.ollamaUrl || 'http://localhost:11434';
  $('unloadOllama').checked = !!s.unloadOllama;
  $('anthropicKey').value = s.anthropicKey || '';
  $('openaiKey').value = s.openaiKey || '';
  // Seed model dropdowns with the saved value; fetch the live list for the active engine.
  await populateOllamaModels(s.ollamaModel || 'qwen3.5');
  fillSelect('anthropicModel', [], s.anthropicModel || 'claude-opus-4-8', '');
  fillSelect('openaiModel', [], s.openaiModel || 'gpt-4o-mini', '');
  if ((s.summarizerMode || 'ollama') === 'claude') await populateAnthropicModels(s.anthropicModel || 'claude-opus-4-8');
  if (s.summarizerMode === 'openai') await populateOpenaiModels(s.openaiModel || 'gpt-4o-mini');
  $('taskDestination').value = s.taskDestination || 'native';
  $('clickupKey').value = s.clickupKey || '';
  $('clickupListId').value = s.clickupListId || '';
  $('captureSystemAudio').checked = s.captureSystemAudio !== false;
  $('watchCalls').checked = !!s.watchCalls;
  $('assemblyaiKey').value = s.assemblyaiKey || '';
  $('hfToken').value = s.hfToken || '';
  $('whisperModel').value = s.whisperModel || 'medium';
  $('whisperDevice').value = s.whisperDevice || 'cuda';
  $('whisperCompute').value = s.whisperCompute || 'int8';
  $('whisperLanguage').value = s.whisperLanguage || '';
  $('pythonPath').value = s.pythonPath || 'python';
  applySummarizerVisibility();
  applyDestinationVisibility();
  $('testResults').innerHTML = '';
  $('settingsModal').classList.remove('hidden');
}

function readSettingsForm() {
  return {
    transcriptionMode: currentMode,
    summarizerMode: $('summarizerMode').value,
    ollamaUrl: $('ollamaUrl').value.trim() || 'http://localhost:11434',
    ollamaModel: $('ollamaModel').value.trim() || 'qwen3.5',
    unloadOllama: $('unloadOllama').checked,
    anthropicKey: $('anthropicKey').value.trim(),
    anthropicModel: $('anthropicModel').value.trim() || 'claude-opus-4-8',
    openaiKey: $('openaiKey').value.trim(),
    openaiModel: $('openaiModel').value.trim() || 'gpt-4o-mini',
    taskDestination: $('taskDestination').value,
    clickupKey: $('clickupKey').value.trim(),
    clickupListId: $('clickupListId').value.trim(),
    captureSystemAudio: $('captureSystemAudio').checked,
    watchCalls: $('watchCalls').checked,
    assemblyaiKey: $('assemblyaiKey').value.trim(),
    hfToken: $('hfToken').value.trim(),
    whisperModel: $('whisperModel').value.trim() || 'medium',
    whisperDevice: $('whisperDevice').value.trim() || 'cuda',
    whisperCompute: $('whisperCompute').value.trim() || 'int8',
    whisperLanguage: $('whisperLanguage').value.trim(),
    pythonPath: $('pythonPath').value.trim() || 'python',
  };
}

async function saveSettings() {
  await window.api.saveSettings(readSettingsForm());
  $('settingsModal').classList.add('hidden');
  setStatus('Settings saved.');
  updateRecordReadiness();
}

async function testConnections() {
  const btn = $('testBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  $('testResults').innerHTML = '<div class="meta">Checking your configured services…</div>';
  const r = await window.api.testConnections(readSettingsForm());
  // Only the services your current config uses are returned — render those.
  const order = [
    ['python', 'Python / WhisperX'],
    ['assemblyai', 'AssemblyAI (cloud)'],
    ['ollama', 'Ollama'],
    ['anthropic', 'Claude (Anthropic)'],
    ['openai', 'OpenAI'],
    ['clickup', 'ClickUp'],
  ];
  const rows = order.filter(([k]) => r[k]).map(([k, label]) => [label, r[k]]);
  $('testResults').innerHTML = rows
    .map(([label, res]) => {
      const cls = res.ok ? 'ok' : 'err';
      const mark = res.ok ? '✓' : '✗';
      return `<div class="test-line ${cls}"><span>${mark} ${label}</span><span>${res.msg}</span></div>`;
    })
    .join('');
  btn.disabled = false;
  btn.textContent = 'Test connections';
}

// ---------- First-run wizard ----------

function wireSegGroup(containerId, onChange) {
  const container = $(containerId);
  container.querySelectorAll('.seg').forEach((btn) => {
    btn.onclick = () => {
      container.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === btn));
      onChange(btn.dataset.val);
    };
  });
  const active = container.querySelector('.seg.active');
  return active ? active.dataset.val : null;
}

function wizardVisibility() {
  const trans = $('wzTranscription').querySelector('.seg.active').dataset.val;
  const sum = $('wzSummarizer').querySelector('.seg.active').dataset.val;
  const dest = $('wzDestination').querySelector('.seg.active').dataset.val;
  $('wzLocalNote').classList.toggle('hidden', trans !== 'local');
  $('wzHfWrap').classList.toggle('hidden', trans !== 'local');
  $('wzAaiWrap').classList.toggle('hidden', trans !== 'cloud');
  $('wzOllamaNote').classList.toggle('hidden', sum !== 'ollama');
  $('wzAnthropicWrap').classList.toggle('hidden', sum !== 'claude');
  $('wzOpenaiWrap').classList.toggle('hidden', sum !== 'openai');
  $('wzClickupWrap').classList.toggle('hidden', dest !== 'clickup');
}

async function finishWizard() {
  const trans = $('wzTranscription').querySelector('.seg.active').dataset.val;
  const sum = $('wzSummarizer').querySelector('.seg.active').dataset.val;
  const dest = $('wzDestination').querySelector('.seg.active').dataset.val;
  await window.api.saveSettings({
    setupComplete: true,
    transcriptionMode: trans,
    summarizerMode: sum,
    taskDestination: dest,
    hfToken: $('wzHfToken').value.trim(),
    assemblyaiKey: $('wzAssemblyaiKey').value.trim(),
    anthropicKey: $('wzAnthropicKey').value.trim(),
    openaiKey: $('wzOpenaiKey').value.trim(),
    clickupKey: $('wzClickupKey').value.trim(),
    clickupListId: $('wzClickupListId').value.trim(),
  });
  $('wizard').classList.add('hidden');
  setMode(trans);
  setStatus('Setup complete. Press Record to start.');
  updateRecordReadiness();
}

// ---------- Tooltips (instant, theme-matched) ----------

const tipEl = document.createElement('div');
tipEl.className = 'tooltip hidden';
document.body.appendChild(tipEl);

function showTip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let top = r.top - t.height - 8;
  if (top < 6) top = r.bottom + 8;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
  tipEl.style.top = `${top}px`;
  tipEl.style.left = `${left}px`;
}
function hideTip() {
  tipEl.classList.add('hidden');
}
document.querySelectorAll('.info').forEach((el) => {
  el.addEventListener('mouseenter', () => showTip(el));
  el.addEventListener('mouseleave', hideTip);
});

// ---------- Wiring ----------

$('recordBtn').onclick = async () => {
  const btn = $('recordBtn');
  if (btn.classList.contains('disabled')) {
    setStatus(btn.dataset.tip || 'Not set up yet — open ⚙ Settings.');
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    try {
      await startRecording();
    } catch (err) {
      setStatus(`Could not start recording: ${err.message}`);
      setRecordingUI(false);
    }
  }
};
// Show the "not set up" tooltip when the (grayed) Record button is hovered.
$('recordBtn').addEventListener('mouseenter', () => {
  if ($('recordBtn').classList.contains('disabled')) showTip($('recordBtn'));
});
$('recordBtn').addEventListener('mouseleave', hideTip);

$('modeLocal').onclick = async () => { setMode('local'); await window.api.saveSettings({ transcriptionMode: 'local' }); updateRecordReadiness(); };
$('modeCloud').onclick = async () => { setMode('cloud'); await window.api.saveSettings({ transcriptionMode: 'cloud' }); updateRecordReadiness(); };
$('applyNamesBtn').onclick = applyNames;

$('navRecord').onclick = () => showView('record');
$('navMeetings').onclick = () => showView('meetings');

$('settingsBtn').onclick = openSettings;
$('settingsCancel').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsSave').onclick = saveSettings;
$('testBtn').onclick = testConnections;
$('summarizerMode').onchange = () => {
  applySummarizerVisibility();
  const mode = $('summarizerMode').value;
  if (mode === 'ollama') populateOllamaModels($('ollamaModel').value);
  else if (mode === 'claude') populateAnthropicModels($('anthropicModel').value);
  else if (mode === 'openai') populateOpenaiModels($('openaiModel').value);
};
$('taskDestination').onchange = applyDestinationVisibility;
$('ollamaRefresh').onclick = () => populateOllamaModels($('ollamaModel').value);
$('anthropicRefresh').onclick = () => populateAnthropicModels($('anthropicModel').value);
$('openaiRefresh').onclick = () => populateOpenaiModels($('openaiModel').value);

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  };
});

// Wizard
wireSegGroup('wzTranscription', wizardVisibility);
wireSegGroup('wzSummarizer', wizardVisibility);
wireSegGroup('wzDestination', wizardVisibility);
$('wizardFinish').onclick = finishWizard;
$('wizardSkip').onclick = async () => {
  await window.api.saveSettings({ setupComplete: true });
  $('wizard').classList.add('hidden');
  setStatus('You can configure everything in ⚙ Settings.');
  updateRecordReadiness();
};

// Live progress from the backend drives the staged bar.
window.api.onProgress((p) => setProgress(p.stage, p.message));

// Zoom/Teams call detected → offer to record (unless already recording).
window.api.onCallDetected((app) => {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  $('callBannerText').textContent = `Looks like you're in a ${app} call — record it?`;
  showView('record');
  $('callBanner').classList.remove('hidden');
});
$('callRecordBtn').onclick = async () => {
  $('callBanner').classList.add('hidden');
  if (!(mediaRecorder && mediaRecorder.state === 'recording')) {
    try {
      await startRecording();
    } catch (err) {
      setStatus(`Could not start recording: ${err.message}`);
    }
  }
};
$('callDismissBtn').onclick = () => $('callBanner').classList.add('hidden');

// ---------- Startup ----------

window.api.getSettings().then((s) => {
  setMode(s.transcriptionMode || 'local');
  if (!s.setupComplete) {
    wizardVisibility();
    $('wizard').classList.remove('hidden');
    setStatus('Welcome — finish setup to begin.');
  } else {
    setStatus(currentMode === 'cloud' ? 'Ready (cloud transcription).' : 'Ready (local transcription).');
  }
  updateRecordReadiness();
});
