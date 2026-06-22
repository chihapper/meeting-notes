// Local transcription + diarization via WhisperX, running on the user's GPU.
// We shell out to a Python script (src/python/whisperx_transcribe.py) which
// writes the speaker-labeled transcript to a temp file we then read back.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// In a packaged build the script lives in app.asar.unpacked (see "asarUnpack"
// in package.json) so the spawned Python process — which can't read inside the
// asar archive — can actually open it. In dev this replace is a no-op.
const SCRIPT = path
  .join(__dirname, '..', 'python', 'whisperx_transcribe.py')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function transcribe(settings, audioPath, onProgress) {
  return new Promise((resolve, reject) => {
    const outPath = `${audioPath}.txt`;
    const python = settings.pythonPath || 'python';
    const env = {
      ...process.env,
      WHISPER_MODEL: settings.whisperModel || 'medium',
      WHISPER_DEVICE: settings.whisperDevice || 'cuda',
      WHISPER_COMPUTE: settings.whisperCompute || 'float16',
      WHISPER_LANGUAGE: settings.whisperLanguage || '',
      HF_TOKEN: settings.hfToken || '',
    };

    const proc = spawn(python, [SCRIPT, audioPath, outPath], { env });

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      // Surface the most recent non-empty line as a status update.
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) onProgress?.(lines[lines.length - 1]);
    });

    proc.on('error', (err) => {
      reject(new Error(
        `Could not start Python ("${python}"): ${err.message}. ` +
        `Install Python and WhisperX, or set the Python path in Settings.`
      ));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`WhisperX exited with code ${code}.\n${stderrTail.slice(-1200)}`));
        return;
      }
      try {
        const transcript = fs.readFileSync(outPath, 'utf8');
        resolve(transcript);
      } catch (e) {
        reject(new Error(`WhisperX produced no transcript: ${e.message}`));
      } finally {
        fs.unlink(outPath, () => {});
      }
    });
  });
}

module.exports = { transcribe };
