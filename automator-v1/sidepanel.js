const $ = (id) => document.getElementById(id);
let state = null;
let availableTabs = [];
let editingAgentId = null;
let agentIdWasEdited = false;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function showMessage(text) {
  $('message').textContent = text || '';
  if (text) setTimeout(() => {
    if ($('message').textContent === text) $('message').textContent = '';
  }, 4500);
}

async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Automator request failed');
  if (response.state) {
    state = response.state;
    render();
  }
  return response;
}

function renderTabOptions(preferredTabId = null) {
  const current = preferredTabId ?? (Number($('tabSelect').value) || null);
  if (!availableTabs.length) {
    $('tabSelect').innerHTML = '<option value="">No open ChatGPT conversations found</option>';
    return;
  }
  $('tabSelect').innerHTML = availableTabs.map((tab) => {
    const marker = tab.active ? '● ' : '';
    const urlTail = (tab.conversationUrl || tab.url || '').replace('https://chatgpt.com/', '').replace('https://chat.openai.com/', '');
    return `<option value="${tab.id}">${esc(marker + tab.title)} — ${esc(urlTail || 'home')}</option>`;
  }).join('');
  if (current && availableTabs.some((tab) => tab.id === current)) $('tabSelect').value = String(current);
}

async function refreshTabs(preferredTabId = null) {
  const response = await call({ type: 'AUTOMATOR_LIST_CHATGPT_TABS' });
  availableTabs = response.tabs || [];
  renderTabOptions(preferredTabId);
}

function shortConversation(url) {
  if (!url) return 'No saved conversation';
  return url.replace(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//, '').slice(0, 56) || 'ChatGPT home';
}

function renderAgents() {
  const agents = Object.values(state?.agents || {}).sort((a, b) => {
    if (a.type === 'PM' && b.type !== 'PM') return -1;
    if (b.type === 'PM' && a.type !== 'PM') return 1;
    return a.name.localeCompare(b.name);
  });

  $('agents').innerHTML = agents.length ? agents.map((agent) => `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="role">${esc(agent.name)}</div>
          <div class="agent-id">${esc(agent.id)} · ${esc(agent.type)}</div>
        </div>
        <span class="badge ${agent.status === 'CONNECTED' ? 'good' : 'warn'}">${esc(agent.status || 'MISSING')}</span>
      </div>
      ${agent.description ? `<div class="description">${esc(agent.description)}</div>` : ''}
      <div class="muted tab-line">${esc(agent.title || 'ChatGPT')}<br>${esc(shortConversation(agent.conversationUrl))}</div>
      <div class="card-actions">
        <button data-open-agent="${esc(agent.id)}">Open</button>
        <button data-edit-agent="${esc(agent.id)}">Edit</button>
        <button data-remove-agent="${esc(agent.id)}">Remove</button>
      </div>
    </div>
  `).join('') : '<div class="empty">No agents created yet.</div>';
}

function renderGates() {
  const gates = Object.values(state?.ownerGates || {}).filter((gate) => gate.status === 'WAITING_FOR_OWNER');
  $('gates').className = gates.length ? '' : 'empty';
  $('gates').innerHTML = gates.length ? gates.map((gate) => `
    <div class="card gate">
      <div class="card-row">
        <div class="role">${esc(gate.id)}</div>
        <span class="badge warn">WAITING FOR OWNER</span>
      </div>
      <div><strong>${esc(gate.reason || 'Owner decision required')}</strong></div>
      <div class="muted">${esc(gate.instructions || '')}</div>
      ${gate.taskId ? `<div class="agent-id">Task: ${esc(gate.taskId)}</div>` : ''}
      <div class="card-actions">
        <button data-gate="${esc(gate.id)}" data-resolution="PASS">Approve / Pass</button>
        <button data-gate="${esc(gate.id)}" data-resolution="FAIL">Reject / Fail</button>
      </div>
    </div>
  `).join('') : 'No active gates.';
}

function renderTasks() {
  const tasks = Object.values(state?.tasks || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('tasks').className = tasks.length ? '' : 'empty';
  $('tasks').innerHTML = tasks.length ? tasks.slice(0, 25).map((task) => {
    const target = state.agents?.[task.assignedToAgentId];
    const requiresPmReview = task.requiresPmReviewForDownload || task.status === 'PM_REVIEW';
    const pmReviewControls = requiresPmReview ? `
      <div class="pm-review-controls">
        <div class="muted" style="color: #f59e0b; font-weight: bold;">⚠️ PM Review Required</div>
        <div class="card-actions">
          <button data-approve-download="${esc(task.id)}" style="background: #10b981;">Approve Download</button>
          <button data-reject-download="${esc(task.id)}" style="background: #ef4444;">Reject Download</button>
        </div>
      </div>
    ` : '';
    return `
      <div class="card">
        <div class="card-row">
          <span class="task-id">${esc(task.id)}</span>
          <span class="badge">${esc(task.status)}</span>
        </div>
        <div class="muted">${esc(target?.name || task.assignedToAgentId || 'Unknown agent')}</div>
        ${task.agentStatus ? `<div class="agent-id">Agent result: ${esc(task.agentStatus)}</div>` : ''}
        ${task.downloadUrl ? `<div class="muted">📎 Download: ${esc(task.downloadUrl)}</div>` : ''}
        ${pmReviewControls}
      </div>
    `;
  }).join('') : 'No tasks yet.';
}

function renderEvents() {
  const events = state?.eventLog || [];
  $('events').innerHTML = events.slice(0, 40).map((event) => `
    <div class="event">
      <div>${esc(event.type)}</div>
      <div class="event-time">${esc(new Date(event.at).toLocaleString())}</div>
    </div>
  `).join('') || '<div class="empty">No activity yet.</div>';
}

function render() {
  if (!state) return;
  const paused = Boolean(state.paused);
  $('systemStatus').textContent = paused ? 'PAUSED' : 'RUNNING';
  $('systemStatus').className = paused ? 'paused' : 'running';
  $('pauseButton').textContent = paused ? 'Resume' : 'Pause';
  renderAgents();
  renderGates();
  renderTasks();
  renderEvents();
}

function resetAgentForm() {
  editingAgentId = null;
  agentIdWasEdited = false;
  $('agentType').value = 'SPECIALIST';
  $('agentType').disabled = false;
  $('agentName').value = '';
  $('agentId').value = '';
  $('agentId').readOnly = false;
  $('agentDescription').value = '';
  $('saveAgentButton').textContent = 'Create agent';
  $('cancelEditButton').classList.add('hidden');
}

async function startEditAgent(agentId) {
  const agent = state?.agents?.[agentId];
  if (!agent) return;
  editingAgentId = agentId;
  agentIdWasEdited = true;
  $('agentType').value = agent.type;
  $('agentType').disabled = true;
  $('agentName').value = agent.name;
  $('agentId').value = agent.id;
  $('agentId').readOnly = true;
  $('agentDescription').value = agent.description || '';
  $('saveAgentButton').textContent = 'Save changes';
  $('cancelEditButton').classList.remove('hidden');
  await refreshTabs(agent.tabId);
}

async function init() {
  try {
    const response = await call({ type: 'AUTOMATOR_GET_STATE' });
    state = response.state;
    render();
    await refreshTabs();
  } catch (error) {
    showMessage(error.message);
  }
}

$('agentName').addEventListener('input', () => {
  if (agentIdWasEdited || editingAgentId || $('agentType').value === 'PM') return;
  $('agentId').value = slug($('agentName').value);
});

$('agentId').addEventListener('input', () => {
  agentIdWasEdited = true;
  $('agentId').value = slug($('agentId').value);
});

$('agentType').addEventListener('change', () => {
  if ($('agentType').value === 'PM') {
    $('agentId').value = 'pm';
    $('agentId').readOnly = true;
  } else if (!editingAgentId) {
    $('agentId').readOnly = false;
    if ($('agentId').value === 'pm') $('agentId').value = slug($('agentName').value);
  }
});

$('saveAgentButton').addEventListener('click', async () => {
  try {
    const tabId = Number($('tabSelect').value);
    await call({
      type: 'AUTOMATOR_UPSERT_AGENT',
      agent: {
        id: editingAgentId || $('agentId').value,
        type: $('agentType').value,
        name: $('agentName').value,
        description: $('agentDescription').value,
        tabId,
        isEdit: Boolean(editingAgentId)
      }
    });
    showMessage(editingAgentId ? 'Agent updated.' : 'Agent created.');
    resetAgentForm();
    await refreshTabs();
  } catch (error) {
    showMessage(error.message);
  }
});

$('cancelEditButton').addEventListener('click', () => resetAgentForm());
$('refreshTabsButton').addEventListener('click', async () => {
  try { await refreshTabs(); showMessage('ChatGPT tabs refreshed.'); }
  catch (error) { showMessage(error.message); }
});

$('pauseButton').addEventListener('click', async () => {
  try { await call({ type: 'AUTOMATOR_SET_PAUSED', paused: !state.paused }); }
  catch (error) { showMessage(error.message); }
});

$('refreshButton').addEventListener('click', async () => {
  try {
    await call({ type: 'AUTOMATOR_RECONCILE_NOW' });
    await refreshTabs();
    showMessage('Reconciled.');
  } catch (error) { showMessage(error.message); }
});

$('clearButton').addEventListener('click', async () => {
  if (!confirm('Reset all local Automator agents, tasks, gates, and logs?')) return;
  try {
    await call({ type: 'AUTOMATOR_CLEAR_DATA' });
    resetAgentForm();
    showMessage('Automator data reset.');
  } catch (error) { showMessage(error.message); }
});

document.addEventListener('click', async (event) => {
  const openAgentId = event.target?.dataset?.openAgent;
  const editAgentId = event.target?.dataset?.editAgent;
  const removeAgentId = event.target?.dataset?.removeAgent;
  const gateId = event.target?.dataset?.gate;
  const resolution = event.target?.dataset?.resolution;
  const approveDownloadTaskId = event.target?.dataset?.approveDownload;
  const rejectDownloadTaskId = event.target?.dataset?.rejectDownload;

  try {
    if (openAgentId) await call({ type: 'AUTOMATOR_OPEN_AGENT', agentId: openAgentId });
    if (editAgentId) await startEditAgent(editAgentId);
    if (removeAgentId) {
      const agent = state?.agents?.[removeAgentId];
      if (confirm(`Remove ${agent?.name || removeAgentId} from Automator?`)) {
        await call({ type: 'AUTOMATOR_REMOVE_AGENT', agentId: removeAgentId });
      }
    }
    if (gateId && resolution) {
      const comment = prompt(`Optional owner comment for ${resolution}:`, '') || '';
      await call({ type: 'AUTOMATOR_RESOLVE_GATE', gateId, resolution, comment });
    }
    // PM approval/rejection of downloads
    if (approveDownloadTaskId) {
      const task = state.tasks[approveDownloadTaskId];
      const fileId = task?.downloadFileId || null;
      const downloadUrl = task?.downloadUrl || null;
      await call({ 
        type: 'AUTOMATOR_APPROVE_DOWNLOAD', 
        taskId: approveDownloadTaskId,
        fileId,
        downloadUrl
      });
      showMessage('Download approved. Starting download...');
    }
    if (rejectDownloadTaskId) {
      const comment = prompt('Reason for rejecting download:', 'Download rejected by PM') || 'Download rejected by PM';
      await call({ 
        type: 'AUTOMATOR_UPDATE_TASK_STATUS',
        taskId: rejectDownloadTaskId,
        status: 'BLOCKED',
        note: comment
      });
      showMessage('Download rejected. Task blocked.');
    }
  } catch (error) {
    showMessage(error.message);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.automatorStateV1?.newValue) return;
  state = changes.automatorStateV1.newValue;
  render();
});

init();
