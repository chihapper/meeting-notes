// Summary + structured action items from a transcript. Three backends:
//   - 'ollama' : local model on the user's GPU (default, free)
//   - 'claude' : Anthropic API (official SDK)
//   - 'openai' : OpenAI API
// All share one schema/prompt and defensive JSON parsing.
const Anthropic = require('@anthropic-ai/sdk');

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string' },
          dueDate: { type: 'string' },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
        },
        required: ['task', 'owner', 'dueDate', 'priority'],
      },
    },
  },
  required: ['summary', 'decisions', 'actionItems'],
};

const SYSTEM = `You read meeting transcripts and extract an executive summary, the key decisions, and a clean list of action items. Be specific. Only list action items that were genuinely agreed or clearly implied — do not invent work. Attribute each action item to the speaker who owns it when the transcript makes it clear (use "Unassigned" otherwise).

For EACH action item:
- priority: infer it from the conversation. Urgency cues like "urgent", "ASAP", "critical", "blocker", or a hard same-day deadline → "urgent"; an important task or a firm near-term deadline → "high"; ordinary follow-ups → "normal"; "no rush", "eventually", "whenever", "nice to have" → "low".
- dueDate: if a deadline is stated or implied (e.g. "by Friday", "end of the week", "next Tuesday", "in two weeks", "tomorrow"), resolve it to an ABSOLUTE calendar date in YYYY-MM-DD format using the meeting date provided below. If no deadline is mentioned, use an empty string.

Respond with ONLY a single JSON object of this shape (no prose, no markdown fences):
{"summary": string, "decisions": string[], "actionItems": [{"task": string, "owner": string, "dueDate": string, "priority": "urgent"|"high"|"normal"|"low"}]}`;

const userPrompt = (transcript, today) =>
  `The meeting took place on ${today}. Resolve any relative due dates ("Friday", "next week", "tomorrow", …) to absolute YYYY-MM-DD dates relative to that.\n\nHere is the transcript. Produce the summary, decisions, and action items.\n\n---\n${transcript}\n---`;

// Extract a JSON object even if the model wrapped it in prose or a code fence.
function parseJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Could not parse the model response as JSON.');
  }
}

async function viaOllama(settings, transcript, today) {
  const base = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = settings.ollamaModel || 'qwen2.5:7b';
  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // Disable "reasoning" output — models like Qwen3.x otherwise emit a long
        // think-chain before the JSON, which is very slow (minutes) on modest GPUs.
        think: false,
        format: SCHEMA,
        ...(settings.unloadOllama ? { keep_alive: 0 } : {}),
        // num_predict bounds worst-case output length as a safety net.
        options: { temperature: 0, num_predict: 2048 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt(transcript, today) },
        ],
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach Ollama at ${base}. Is it running? (install from ollama.com). ${err.message}`);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Ollama model "${model}" not found. Run: ollama pull ${model}`);
    throw new Error(`Ollama request failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const content = json.message && json.message.content;
  if (!content) throw new Error('Ollama returned no content.');
  return parseJson(content);
}

async function viaClaude(settings, transcript, today) {
  if (!settings.anthropicKey) throw new Error('Claude selected but no Anthropic API key is set (Settings).');
  const client = new Anthropic({ apiKey: settings.anthropicKey });
  let res;
  try {
    res = await client.messages.create({
      model: settings.anthropicModel || 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt(transcript, today) }],
    });
  } catch (err) {
    throw new Error(`Claude request failed: ${err.message}`);
  }
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude returned no text content.');
  return parseJson(block.text);
}

async function viaOpenai(settings, transcript, today) {
  if (!settings.openaiKey) throw new Error('OpenAI selected but no OpenAI API key is set (Settings).');
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.openaiKey}` },
      body: JSON.stringify({
        model: settings.openaiModel || 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt(transcript, today) },
        ],
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach OpenAI. ${err.message}`);
  }
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  const content = json.choices && json.choices[0] && json.choices[0].message.content;
  if (!content) throw new Error('OpenAI returned no content.');
  return parseJson(content);
}

async function summarize(settings, transcript) {
  if (!transcript || !transcript.trim()) throw new Error('Transcript is empty — nothing to summarize.');
  const now = new Date();
  const today = `${now.toISOString().slice(0, 10)} (${now.toLocaleDateString('en-US', { weekday: 'long' })})`;
  switch (settings.summarizerMode) {
    case 'claude':
      return viaClaude(settings, transcript, today);
    case 'openai':
      return viaOpenai(settings, transcript, today);
    default:
      return viaOllama(settings, transcript, today);
  }
}

module.exports = { summarize };
