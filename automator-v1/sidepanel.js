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
  const messageEl = $('message');
  messageEl.textContent = text || '';
  if (text) {
    // Add animation class for smooth entrance
    messageEl.classList.add('show');
    setTimeout(() => {
      if (messageEl.textContent === text) {
        messageEl.textContent = '';
        messageEl.classList.remove('show');
      }
    }, 4500);
  }
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
        <button data-open-agent="${esc(agent.id)}" class="btn btn-secondary btn-sm">Open</button>
        <button data-edit-agent="${esc(agent.id)}" class="btn btn-ghost btn-sm">Edit</button>
        <button data-remove-agent="${esc(agent.id)}" class="btn btn-danger btn-sm">Remove</button>
      </div>
    </div>
  `).join('') : '<div class="empty-message"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21V19C17 16.7909 15.2091 15 13 15H5C2.79086 15 1 16.7909 1 19V21"/><path d="M9 11C11.2091 11 13 9.20914 13 7C13 4.79086 11.2091 3 9 3C6.79086 3 5 4.79086 5 7C5 9.20914 6.79086 11 9 11Z"/><path d="M23 21V19C22.9993 18.1771 22.7988 17.3656 22.416 16.6347C22.0332 15.9038 21.4801 15.2756 20.8 14.8"/><path d="M16 3.13C16.8604 3.00508 17.7389 3.09901 18.5472 3.40245C19.3555 3.70589 20.0649 4.20845 20.6039 4.85947C21.1428 5.51049 21.4925 6.28713 21.6161 7.1096C21.7397 7.93207 21.6326 8.77079 21.306 9.53352"/></svg><p>No agents created yet</p></div>';
}

function renderGates() {
  const gates = Object.values(state?.ownerGates || {}).filter((gate) => gate.status === 'WAITING_FOR_OWNER');
  $('gates').className = gates.length ? '' : 'empty-state';
  $('gates').innerHTML = gates.length ? gates.map((gate) => `
    <div class="card gate">
      <div class="card-row">
        <div class="role">${esc(gate.id)}</div>
        <span class="badge warn">Waiting for Owner</span>
      </div>
      <div><strong>${esc(gate.reason || 'Owner decision required')}</strong></div>
      <div class="muted">${esc(gate.instructions || '')}</div>
      ${gate.taskId ? `<div class="agent-id">Task: ${esc(gate.taskId)}</div>` : ''}
      <div class="card-actions">
        <button data-gate="${esc(gate.id)}" data-resolution="PASS" class="btn btn-primary btn-sm" title="Approve and pass">
          <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Approve
        </button>
        <button data-gate="${esc(gate.id)}" data-resolution="FAIL" class="btn btn-danger btn-sm" title="Reject and fail">
          <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Reject
        </button>
      </div>
    </div>
  `).join('') : '<div class="empty-message"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/><path d="M12 18V12"/><path d="M12 8H12.01"/></svg><p>No active gates requiring your attention</p></div>';
}

function renderTasks() {
  const tasks = Object.values(state?.tasks || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('tasks').className = tasks.length ? '' : 'empty-state';
  $('tasks').innerHTML = tasks.length ? tasks.slice(0, 25).map((task) => {
    const target = state.agents?.[task.assignedToAgentId];
    return `
      <div class="card">
        <div class="card-row">
          <span class="task-id">${esc(task.id)}</span>
          <span class="badge info">${esc(task.status)}</span>
        </div>
        <div class="muted">${esc(target?.name || task.assignedToAgentId || 'Unknown agent')}</div>
        ${task.agentStatus ? `<div class="agent-id">Agent result: ${esc(task.agentStatus)}</div>` : ''}
      </div>
    `;
  }).join('') : '<div class="empty-message"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11L12 14L22 4"/><path d="M21 12V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H16"/></svg><p>No tasks yet</p></div>';
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
  // Hide the form after reset if it was open
  const form = $('createAgentForm');
  const createButton = $('createAgentButton');
  if (form && !form.classList.contains('hidden')) {
    form.classList.add('hidden');
    if (createButton) {
      createButton.innerHTML = `
        <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5V19"/><path d="M5 12H19"/></svg>
        Create New Agent
      `;
    }
  }
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
    // Show loading state initially
    showLoadingState();
    const response = await call({ type: 'AUTOMATOR_GET_STATE' });
    state = response.state;
    render();
    await refreshTabs();
  } catch (error) {
    showMessage(error.message);
  }
}

function showLoadingState() {
  $('agents').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p class="muted">Loading Automator...</p>
    </div>
  `;
  $('gates').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p class="muted">Loading gates...</p>
    </div>
  `;
  $('tasks').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p class="muted">Loading tasks...</p>
    </div>
  `;
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

$('refreshButton')?.addEventListener('click', async () => {
  try {
    await call({ type: 'AUTOMATOR_RECONCILE_NOW' });
    await refreshTabs();
    showMessage('Reconciled.');
  } catch (error) { showMessage(error.message); }
});

// Toggle section collapse/expand
function toggleSection(contentId, chevronId) {
  const content = $(contentId);
  const chevron = $(chevronId);
  
  if (!content || !chevron) return;
  
  const isCollapsed = content.classList.contains('collapsed');
  
  if (isCollapsed) {
    content.classList.remove('collapsed');
    chevron.classList.remove('collapsed');
  } else {
    content.classList.add('collapsed');
    chevron.classList.add('collapsed');
  }
}

// Toggle create agent form visibility
function toggleCreateAgentForm() {
  const form = $('createAgentForm');
  const createButton = $('createAgentButton');
  
  if (!form) return;
  
  const isHidden = form.classList.contains('hidden');
  
  if (isHidden) {
    form.classList.remove('hidden');
    createButton.innerHTML = `
      <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>
      Hide Form
    `;
    // Focus on first input when opening
    setTimeout(() => $('agentType')?.focus(), 100);
  } else {
    form.classList.add('hidden');
    createButton.innerHTML = `
      <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5V19"/><path d="M5 12H19"/></svg>
      Create New Agent
    `;
    resetAgentForm();
  }
}

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
