// Create ClickUp tasks from extracted action items via the ClickUp v2 REST API.
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };

function buildDescription(item, summary) {
  const lines = [];
  if (item.owner && item.owner !== 'Unassigned') lines.push(`Owner: ${item.owner}`);
  if (item.dueDate) lines.push(`Mentioned due: ${item.dueDate}`);
  lines.push('');
  lines.push('Created automatically from a meeting recording.');
  if (summary) {
    lines.push('');
    lines.push('Meeting summary:');
    lines.push(summary);
  }
  return lines.join('\n');
}

// Convert a resolved YYYY-MM-DD due date into the epoch-ms ClickUp expects.
// Uses local noon so the date doesn't shift a day across time zones.
function toEpochMs(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).getTime();
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? null : ms;
}

async function createTask(apiKey, listId, item, summary, parentId) {
  if (!apiKey) throw new Error('Missing ClickUp API token (set it in Settings).');
  if (!listId) throw new Error('Missing ClickUp List ID (set it in Settings).');

  const body = {
    name: item.task,
    description: buildDescription(item, summary),
    priority: PRIORITY[item.priority] || 3,
  };
  if (parentId) body.parent = parentId; // makes this a subtask of the meeting task
  const due = toEpochMs(item.dueDate);
  if (due) {
    body.due_date = due;
    body.due_date_time = false; // date-only, no specific time
  }

  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ClickUp task creation failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return { id: json.id, url: json.url };
}

// The overarching meeting task (parent). Holds the summary + decisions as context;
// action items become subtasks of it, and the transcript is attached to it.
function buildParentDescription(meeting) {
  const lines = [`Auto-generated from a recorded meeting (${new Date(meeting.date).toLocaleString()}).`, ''];
  if (meeting.summary) {
    lines.push('Summary:', meeting.summary, '');
  }
  if (meeting.decisions && meeting.decisions.length) {
    lines.push('Decisions:');
    meeting.decisions.forEach((d) => lines.push(`- ${d}`));
    lines.push('');
  }
  lines.push('Action items are attached below as subtasks. The full transcript is attached to this task.');
  return lines.join('\n');
}

async function createParentTask(apiKey, listId, meeting) {
  if (!apiKey) throw new Error('Missing ClickUp API token (set it in Settings).');
  if (!listId) throw new Error('Missing ClickUp List ID (set it in Settings).');
  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ name: meeting.title, description: buildParentDescription(meeting) }),
  });
  if (!res.ok) throw new Error(`ClickUp meeting task failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return { id: json.id, url: json.url };
}

// Attach a file (buffer) to a task — used for the meeting-notes .docx.
async function attachFile(apiKey, taskId, buffer, filename, mime) {
  if (!buffer || !buffer.length) return;
  const form = new FormData();
  form.append('attachment', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: 'POST',
    headers: { Authorization: apiKey }, // do NOT set content-type; fetch adds the multipart boundary
    body: form,
  });
  if (!res.ok) throw new Error(`ClickUp attachment failed (${res.status}): ${await res.text()}`);
}

// Best-effort deep link to the list in the ClickUp web app. Needs the team/
// workspace id, which we get from /team (uses the first team if there are several).
async function getListUrl(apiKey, listId) {
  if (!apiKey || !listId) return null;
  try {
    const res = await fetch('https://api.clickup.com/api/v2/team', { headers: { Authorization: apiKey } });
    if (!res.ok) return null;
    const json = await res.json();
    const teamId = json.teams && json.teams[0] && json.teams[0].id;
    if (!teamId) return null;
    return `https://app.clickup.com/${teamId}/v/li/${listId}`;
  } catch {
    return null;
  }
}

module.exports = { createTask, createParentTask, attachFile, getListUrl };
