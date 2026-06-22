// Cloud transcription + diarization via AssemblyAI.
// Flow: upload raw audio -> request transcript (speaker_labels) -> poll until done.
// Same return shape as the local WhisperX path: a "Speaker X: ..." transcript string.
const fs = require('fs');

const BASE = 'https://api.assemblyai.com/v2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadAudio(apiKey, filePath) {
  const data = fs.readFileSync(filePath);
  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
    body: data,
  });
  if (!res.ok) throw new Error(`AssemblyAI upload failed (${res.status}): ${await res.text()}`);
  return (await res.json()).upload_url;
}

async function requestTranscript(apiKey, audioUrl) {
  const res = await fetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true }),
  });
  if (!res.ok) throw new Error(`AssemblyAI transcript request failed (${res.status}): ${await res.text()}`);
  return (await res.json()).id;
}

async function pollTranscript(apiKey, id, onProgress) {
  for (;;) {
    const res = await fetch(`${BASE}/transcript/${id}`, { headers: { authorization: apiKey } });
    if (!res.ok) throw new Error(`AssemblyAI poll failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    if (json.status === 'completed') return json;
    if (json.status === 'error') throw new Error(`AssemblyAI error: ${json.error}`);
    onProgress?.(`Transcribing in the cloud… (${json.status})`);
    await sleep(3000);
  }
}

function formatTranscript(result) {
  if (Array.isArray(result.utterances) && result.utterances.length) {
    return result.utterances.map((u) => `Speaker ${u.speaker}: ${u.text}`).join('\n');
  }
  return result.text || '';
}

async function transcribe(settings, filePath, onProgress) {
  const apiKey = settings.assemblyaiKey;
  if (!apiKey) throw new Error('Cloud mode selected but no AssemblyAI API key is set (Settings).');
  onProgress?.('Uploading audio to AssemblyAI…');
  const uploadUrl = await uploadAudio(apiKey, filePath);
  onProgress?.('Queued for cloud transcription…');
  const id = await requestTranscript(apiKey, uploadUrl);
  const result = await pollTranscript(apiKey, id, onProgress);
  return formatTranscript(result);
}

module.exports = { transcribe };
