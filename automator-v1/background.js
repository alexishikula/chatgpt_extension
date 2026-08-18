const STORAGE_KEY = 'automatorStateV1';
const FILE_SIDECAR_KEY = 'automatorFileSidecarV1';
const RECONCILE_ALARM = 'automator-reconcile';
const CHATGPT_URL_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i;
const ACTIVE_TASK_STATES = new Set(['DISPATCHING', 'RUNNING', 'RESPONSE_NO_VALID_RESULT']);
const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'CANCELLED']);
const AGENT_RESULT_STATUSES = new Set([
  'COMPLETE',
  'FAILED',
  'ESCALATION_REQUIRED',
  'OWNER_ACTION_REQUIRED'
]);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per file
const MAX_TOTAL_STORAGE_BYTES = 50 * 1024 * 1024; // 50MB total

let stateMutationQueue = Promise.resolve();

const DEFAULT_STATE = {
  version: 2,
  paused: false,
  agents: {},
  tasks: {},
  ownerGates: {},
  eventLog: [],
  lastSeenByAgent: {},
  lastProcessedByAgent: {},
  fileSidecar: {}, // Stores file metadata and blobs for task deliverables
  settings: {
    autoRoute: true,
    reconcilePeriodMinutes: 1
  }
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeConversationUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!CHATGPT_URL_RE.test(parsed.href)) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

function normalizeAgentId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function normalizeState(raw) {
  const state = { ...structuredClone(DEFAULT_STATE), ...(raw || {}) };
  state.settings = { ...DEFAULT_STATE.settings, ...(raw?.settings || {}) };
  state.agents ||= {};
  state.tasks ||= {};
  state.ownerGates ||= {};
  state.eventLog ||= [];
  state.lastSeenByAgent ||= {};
  state.lastProcessedByAgent ||= {};

  // One-time migration from the original fixed-role prototype.
  if ((raw?.version || 1) < 2) {
    const migratedAgents = {};
    for (const [legacyRole, agent] of Object.entries(raw?.agents || {})) {
      const isPm = String(legacyRole).toUpperCase() === 'PM';
      const id = isPm ? 'pm' : normalizeAgentId(legacyRole);
      if (!id) continue;
      migratedAgents[id] = {
        id,
        name: isPm ? 'Project Manager' : (agent.title || legacyRole),
        description: '',
        type: isPm ? 'PM' : 'SPECIALIST',
        tabId: agent.tabId || null,
        conversationUrl: normalizeConversationUrl(agent.url),
        title: agent.title || '',
        status: agent.tabId ? 'CONNECTED' : 'MISSING',
        createdAt: agent.registeredAt || nowIso(),
        updatedAt: nowIso()
      };
    }
    state.agents = migratedAgents;
    state.tasks = {};
    state.ownerGates = {};
    state.lastSeenByAgent = {};
    state.lastProcessedByAgent = {};
    state.version = 2;
  }

  return state;
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

async function saveState(state) {
  state.version = 2;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// File Sidecar Functions for storing deliverables between agents
async function loadFileSidecar() {
  const stored = await chrome.storage.local.get(FILE_SIDECAR_KEY);
  return stored[FILE_SIDECAR_KEY] || {};
}

async function saveFileSidecar(sidecar) {
  await chrome.storage.local.set({ [FILE_SIDECAR_KEY]: sidecar });
}

async function getTotalStorageSize() {
  const sidecar = await loadFileSidecar();
  let totalBytes = 0;
  for (const entry of Object.values(sidecar)) {
    if (entry.data && typeof entry.data === 'string') {
      totalBytes += entry.data.length * 2; // UTF-16 encoding
    }
  }
  return totalBytes;
}

async function storeFileForTask(taskId, fileName, fileType, dataUrl, metadata = {}) {
  return await mutateState(async (state) => {
    const sidecar = await loadFileSidecar();
    
    // Check storage limits
    const currentSize = await getTotalStorageSize();
    const newDataSize = dataUrl.length * 2;
    if (currentSize + newDataSize > MAX_TOTAL_STORAGE_BYTES) {
      throw new Error(`Storage limit exceeded. Current: ${(currentSize / 1024 / 1024).toFixed(2)}MB, Max: ${(MAX_TOTAL_STORAGE_BYTES / 1024 / 1024)}MB`);
    }
    
    if (newDataSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large: ${(newDataSize / 1024 / 1024).toFixed(2)}MB exceeds ${(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB limit`);
    }
    
    const fileId = `${taskId}:${fileName}`;
    sidecar[fileId] = {
      taskId,
      fileName,
      fileType,
      dataUrl,
      sizeBytes: newDataSize,
      uploadedAt: nowIso(),
      uploadedByAgentId: metadata.uploadedByAgentId || null,
      sha256: metadata.sha256 || null,
      description: metadata.description || ''
    };
    
    await saveFileSidecar(sidecar);
    state.fileSidecar = sidecar;
    
    logEvent(state, 'FILE_STORED_IN_SIDECAR', {
      fileId,
      taskId,
      fileName,
      sizeBytes: newDataSize
    });
    
    return { fileId, sizeBytes: newDataSize };
  });
}

async function getFilesForTask(taskId) {
  const sidecar = await loadFileSidecar();
  const files = [];
  for (const [fileId, entry] of Object.entries(sidecar)) {
    if (entry.taskId === taskId) {
      files.push({
        fileId,
        fileName: entry.fileName,
        fileType: entry.fileType,
        sizeBytes: entry.sizeBytes,
        uploadedAt: entry.uploadedAt,
        sha256: entry.sha256,
        description: entry.description
      });
    }
  }
  return files;
}

async function getFileData(fileId) {
  const sidecar = await loadFileSidecar();
  return sidecar[fileId] || null;
}

async function deleteFileFromSidecar(fileId) {
  return await mutateState(async (state) => {
    const sidecar = await loadFileSidecar();
    if (sidecar[fileId]) {
      delete sidecar[fileId];
      await saveFileSidecar(sidecar);
      state.fileSidecar = sidecar;
      logEvent(state, 'FILE_DELETED_FROM_SIDECAR', { fileId });
    }
  });
}

async function clearTaskFiles(taskId) {
  return await mutateState(async (state) => {
    const sidecar = await loadFileSidecar();
    let deletedCount = 0;
    for (const [fileId, entry] of Object.entries(sidecar)) {
      if (entry.taskId === taskId) {
        delete sidecar[fileId];
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      await saveFileSidecar(sidecar);
      state.fileSidecar = sidecar;
      logEvent(state, 'TASK_FILES_CLEARED', { taskId, deletedCount });
    }
  });
}

function logEvent(state, type, details = {}) {
  state.eventLog.unshift({
    id: crypto.randomUUID(),
    at: nowIso(),
    type,
    details
  });
  state.eventLog = state.eventLog.slice(0, 300);
}

async function mutateState(mutator) {
  const operation = stateMutationQueue.then(async () => {
    const state = await loadState();
    await mutator(state);
    await saveState(state);
    return state;
  });
  stateMutationQueue = operation.catch(() => {});
  return operation;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    // Tabs that were already open when the extension was installed may not yet
    // have the declared content script. Inject the adapter once and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (secondError) {
      return {
        ok: false,
        error: String(secondError?.message || firstError?.message || secondError || firstError)
      };
    }
  }
}

function agentIdForTab(state, tabId) {
  return Object.entries(state.agents).find(([, agent]) => agent.tabId === tabId)?.[0] || null;
}

function getPmAgent(state) {
  return Object.values(state.agents).find((agent) => agent.type === 'PM') || null;
}

function getActiveTaskForAgent(state, agentId) {
  return Object.values(state.tasks).find(
    (task) => task.assignedToAgentId === agentId && ACTIVE_TASK_STATES.has(task.status)
  ) || null;
}

function parseProtocol(text) {
  if (!text) return { found: false, command: null, error: null };
  const patterns = [
    /<<AUTOMATOR>>\s*([\s\S]*?)\s*<<END_AUTOMATOR>>/m,
    /<AUTOMATOR>\s*([\s\S]*?)\s*<\/AUTOMATOR>/m,
    /```automator\s*([\s\S]*?)\s*```/mi
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      // Check if status needs correction even if JSON is valid
      let corrected = normalizeStatusInCommand(parsed);
      if (corrected) {
        return {
          found: true,
          command: corrected.command,
          error: corrected.error,
          raw: match[1],
          extracted: true
        };
      }
      // Check if action needs correction
      corrected = normalizeActionInCommand(parsed);
      if (corrected) {
        return {
          found: true,
          command: corrected.command,
          error: corrected.error,
          raw: match[1],
          extracted: true
        };
      }
      return { found: true, command: parsed, error: null, raw: match[1] };
    } catch (error) {
      // Try to fix malformed JSON and re-parse
      const fixed = fixMalformedJsonAndExtract(match[1]);
      if (fixed) {
        let corrected = normalizeStatusInCommand(fixed.parsed);
        if (corrected) {
          return {
            found: true,
            command: corrected.command,
            error: `Fixed JSON syntax and status: ${corrected.error}`,
            raw: fixed.raw,
            extracted: true
          };
        }
        corrected = normalizeActionInCommand(fixed.parsed);
        if (corrected) {
          return {
            found: true,
            command: corrected.command,
            error: `Fixed JSON syntax and action: ${corrected.error}`,
            raw: fixed.raw,
            extracted: true
          };
        }
        return {
          found: true,
          command: fixed.parsed,
          error: 'Fixed JSON syntax errors',
          raw: fixed.raw,
          extracted: true
        };
      }
      return {
        found: true,
        command: null,
        error: `Invalid JSON: ${String(error.message || error)}`,
        raw: match[1]
      };
    }
  }
  
  // Lenient fallback: attempt to extract intention from malformed output
  const extracted = extractIntentionFromText(text);
  if (extracted) {
    return {
      found: true,
      command: extracted.command,
      error: extracted.error,
      raw: extracted.raw,
      extracted: true
    };
  }
  
  return { found: false, command: null, error: null };
}

/**
 * Normalize common status typos in already-parsed commands.
 * Returns corrected command if status was normalized, null otherwise.
 */
function normalizeStatusInCommand(command) {
  if (!command || typeof command !== 'object') return null;
  
  const statusMap = {
    'COMPLETED': 'COMPLETE',
    'COMPLETE_TASK': 'COMPLETE',
    'FAIL': 'FAILED',
    'FAILURE': 'FAILED',
    'ESCALATE': 'ESCALATION_REQUIRED',
    'ESCALATION': 'ESCALATION_REQUIRED',
    'OWNER_ACTION': 'OWNER_ACTION_REQUIRED',
    'OWNER_APPROVAL': 'OWNER_ACTION_REQUIRED'
  };
  
  const originalStatus = String(command.status || '');
  const normalized = statusMap[originalStatus];
  
  if (normalized) {
    return {
      command: { ...command, status: normalized },
      error: `Status value corrected: "${originalStatus}" → "${normalized}"`
    };
  }
  
  return null;
}

/**
 * Normalize common action typos in already-parsed commands.
 * Returns corrected command if action was normalized, null otherwise.
 */
function normalizeActionInCommand(command) {
  if (!command || typeof command !== 'object') return null;
  
  const actionMap = {
    'TASK_RESULTS': 'TASK_RESULT',
    'RESULT': 'TASK_RESULT',
    'DISPATCH': 'DISPATCH_TASK',
    'DISPATCH_ASSIGNMENT': 'DISPATCH_TASK',
    'REQUEST_APPROVAL': 'REQUEST_OWNER_APPROVAL',
    'REQUEST_ACTION': 'REQUEST_OWNER_ACTION',
    'CANCEL': 'CANCEL_TASK',
    'COMPLETE': 'COMPLETE_TASK',
    'PAUSE': 'PAUSE_PROJECT',
    'FINISH_PROJECT': 'COMPLETE_PROJECT'
  };
  
  const originalAction = String(command.action || '');
  const normalized = actionMap[originalAction];
  
  if (normalized) {
    return {
      command: { ...command, action: normalized },
      error: `Action value corrected: "${originalAction}" → "${normalized}"`
    };
  }
  
  return null;
}

/**
 * Attempt to fix common JSON structure issues and extract fields.
 */
function fixMalformedJsonAndExtract(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Try to find and extract JSON object even without proper wrappers
  const jsonPatterns = [
    /\{[\s\S]*"action"[\s\S]*\}/,
    /\{[\s\S]*"task_id"[\s\S]*\}/,
    /\{[\s\S]*"status"[\s\S]*\}/
  ];
  
  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match) {
      let jsonStr = match[0];
      
      // Fix common JSON syntax errors
      // Missing quotes around keys
      jsonStr = jsonStr.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      
      // Trailing commas
      jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
      
      // Unquoted string values (basic cases)
      jsonStr = jsonStr.replace(/:\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*([,}\n])/g, ': "$1"$2');
      
      try {
        const parsed = JSON.parse(jsonStr);
        return { parsed, raw: jsonStr };
      } catch (_) {
        continue;
      }
    }
  }
  
  return null;
}

/**
 * Attempt to extract task result intention from unstructured or malformed text.
 * This allows the automator to recover common mistakes like:
 * - Missing protocol wrappers
 * - Typos in status values (e.g., "COMPLETED" vs "COMPLETE")
 * - Partial JSON structures
 */
function extractIntentionFromText(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Look for task_id patterns
  const taskIdMatch = text.match(/task_id["\s:=]+([A-Z0-9_-]+)/i) ||
                      text.match(/TASK_ID[:\s]+([A-Z0-9_-]+)/i);
  const taskId = taskIdMatch ? taskIdMatch[1].trim() : null;
  
  // Look for status patterns with fuzzy matching
  const statusCandidates = [
    { pattern: /status["\\s:=]+\\s*"(COMPLETE|COMPLETED)"?/i, normalize: 'COMPLETE' },
    { pattern: /status["\\s:=]+\\s*"(FAILED|FAIL)"?/i, normalize: 'FAILED' },
    { pattern: /status["\\s:=]+\\s*"(ESCALATION_REQUIRED|ESCALATE)"?/i, normalize: 'ESCALATION_REQUIRED' },
    { pattern: /status["\\s:=]+\\s*"(OWNER_ACTION_REQUIRED|OWNER_ACTION)"?/i, normalize: 'OWNER_ACTION_REQUIRED' }
  ];
  
  let status = null;
  for (const candidate of statusCandidates) {
    const match = text.match(candidate.pattern);
    if (match) {
      status = candidate.normalize;
      break;
    }
  }
  
  // Look for action patterns
  const actionCandidates = [
    { pattern: /action["\\s:=]+\\s*"?TASK_RESULT["\\s]?/i, normalize: 'TASK_RESULT' },
    { pattern: /action["\\s:=]+\\s*"?DISPATCH_TASK["\\s]?/i, normalize: 'DISPATCH_TASK' },
    { pattern: /action["\\s:=]+\\s*"?REQUEST_OWNER_APPROVAL["\\s]?/i, normalize: 'REQUEST_OWNER_APPROVAL' },
    { pattern: /action["\\s:=]+\\s*"?REQUEST_OWNER_ACTION["\\s]?/i, normalize: 'REQUEST_OWNER_ACTION' }
  ];
  
  let action = null;
  for (const candidate of actionCandidates) {
    const match = text.match(candidate.pattern);
    if (match) {
      action = candidate.normalize;
      break;
    }
  }
  
  // Look for summary or description
  const summaryMatch = text.match(/summary["\\s:=]+\\s*"([^"]+)"/i) ||
                       text.match(/description["\\s:=]+\\s*"([^"]+)"/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : null;
  
  // Extract deliverables if present
  let deliverables = null;
  const deliverablesMatch = text.match(/deliverables["\\s:=]+\\s*(\\[.*?\\]|\\{.*?\\})/is);
  if (deliverablesMatch) {
    try {
      deliverables = JSON.parse(deliverablesMatch[1]);
    } catch (_) {}
  }
  
  // Extract validation if present
  let validation = null;
  const validationMatch = text.match(/validation["\\s:=]+\\s*(\\{[^}]*\\})/is);
  if (validationMatch) {
    try {
      validation = JSON.parse(validationMatch[1]);
    } catch (_) {}
  }
  
  // For TASK_RESULT actions, we need at least task_id and status
  if (taskId && status) {
    const extractedCommand = {
      action: 'TASK_RESULT',
      task_id: taskId,
      status: status,
      summary: summary || ''
    };
    
    if (deliverables) extractedCommand.deliverables = deliverables;
    if (validation) extractedCommand.validation = validation;
    
    return {
      command: extractedCommand,
      error: 'Extracted from unstructured text (missing protocol wrapper or typos corrected)',
      raw: text.substring(0, 500) + (text.length > 500 ? '...' : '')
    };
  }
  
  // For PM actions, we need task_id and action
  if (taskId && action && action !== 'TASK_RESULT') {
    const extractedCommand = {
      action: action,
      task_id: taskId,
      summary: summary || ''
    };
    
    return {
      command: extractedCommand,
      error: 'Extracted PM action from unstructured text',
      raw: text.substring(0, 500) + (text.length > 500 ? '...' : '')
    };
  }
  
  return null;
}

function validatePmCommand(state, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return 'Command must be a JSON object.';
  const allowed = new Set([
    'DISPATCH_TASK',
    'REQUEST_OWNER_APPROVAL',
    'REQUEST_OWNER_ACTION',
    'COMPLETE_TASK',
    'CANCEL_TASK',
    'PAUSE_PROJECT',
    'COMPLETE_PROJECT'
  ]);
  if (!allowed.has(command.action)) return `Unsupported PM action: ${command.action}`;

  if (command.action === 'DISPATCH_TASK') {
    const taskId = String(command.task_id || '').trim();
    const targetAgentId = normalizeAgentId(command.target_agent_id);
    if (!taskId) return 'DISPATCH_TASK requires task_id.';
    if (!targetAgentId) return 'DISPATCH_TASK requires target_agent_id.';
    if (Object.prototype.hasOwnProperty.call(state.tasks, taskId)) return `task_id ${taskId} already exists and cannot be reused.`;
    const target = state.agents[targetAgentId];
    if (!target) return `Unknown target_agent_id: ${targetAgentId}`;
    if (target.type === 'PM') return 'PM cannot dispatch a task to itself.';
    if (getActiveTaskForAgent(state, targetAgentId)) {
      return `${targetAgentId} already has an active assignment.`;
    }
    if (command.assignment === undefined || command.assignment === null || command.assignment === '') {
      return 'DISPATCH_TASK requires assignment.';
    }
  }

  if (['COMPLETE_TASK', 'CANCEL_TASK'].includes(command.action)) {
    const taskId = String(command.task_id || '').trim();
    if (!taskId) return `${command.action} requires task_id.`;
    if (!state.tasks[taskId]) return `Unknown task_id: ${taskId}`;
  }

  if (['REQUEST_OWNER_APPROVAL', 'REQUEST_OWNER_ACTION'].includes(command.action)) {
    if (!String(command.gate_id || '').trim()) return `${command.action} requires gate_id.`;
    if (!String(command.reason || '').trim()) return `${command.action} requires reason.`;
    if (!String(command.instructions || '').trim()) return `${command.action} requires instructions.`;
    if (state.ownerGates[String(command.gate_id)]) return `gate_id ${command.gate_id} already exists.`;
  }

  return null;
}

function validateAgentResult(state, sourceAgentId, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return 'Result must be a JSON object.';
  if (command.action !== 'TASK_RESULT') return `Agents may only return action TASK_RESULT, not ${command.action || '(missing)'}.`;
  const taskId = String(command.task_id || '').trim();
  if (!taskId) return 'TASK_RESULT requires task_id.';
  const task = state.tasks[taskId];
  if (!task) return `Unknown task_id: ${taskId}`;
  if (task.assignedToAgentId !== sourceAgentId) {
    return `Task ${taskId} is assigned to ${task.assignedToAgentId}, not ${sourceAgentId}.`;
  }
  if (!AGENT_RESULT_STATUSES.has(String(command.status || ''))) {
    return `Unsupported TASK_RESULT status: ${command.status || '(missing)'}.`;
  }
  if (TERMINAL_TASK_STATES.has(task.status)) return `Task ${taskId} is already ${task.status}.`;
  return null;
}

async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id && CHATGPT_URL_RE.test(tab.url || ''))
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: tab.title || 'ChatGPT',
      url: tab.url || '',
      conversationUrl: normalizeConversationUrl(tab.url)
    }));
}

async function resolveTabForAgent(state, agentId) {
  const agent = state.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  if (agent.tabId) {
    const tab = await chrome.tabs.get(agent.tabId).catch(() => null);
    if (tab && normalizeConversationUrl(tab.url) === agent.conversationUrl) {
      agent.status = 'CONNECTED';
      agent.title = tab.title || agent.title;
      return tab;
    }
  }

  if (agent.conversationUrl) {
    const tabs = await listChatGptTabs();
    const match = tabs.find((tab) => tab.conversationUrl === agent.conversationUrl);
    if (match) {
      agent.tabId = match.id;
      agent.title = match.title;
      agent.status = 'CONNECTED';
      agent.updatedAt = nowIso();
      return await chrome.tabs.get(match.id);
    }
  }

  agent.tabId = null;
  agent.status = 'MISSING';
  throw new Error(`${agent.name || agentId} has no connected ChatGPT tab.`);
}

async function dispatchMessageToAgent(state, agentId, text, taskId = null) {
  const targetId = normalizeAgentId(agentId);
  const tab = await resolveTabForAgent(state, targetId);
  
  // If there are files in the sidecar for this task, include file metadata in the message
  let enrichedText = text;
  if (taskId) {
    const files = await getFilesForTask(taskId);
    if (files && files.length > 0) {
      const fileList = files.map(f => `- ${f.fileName} (${f.fileType}, ${(f.sizeBytes / 1024).toFixed(1)}KB)`).join('\n');
      enrichedText = text + '\n\n---\nATTACHED DELIVERABLES FROM PREVIOUS AGENT:\n' + fileList + 
                     '\n\nUse sidecar.getFileData(fileId) to retrieve each file.';
    }
  }
  
  const response = await sendToTab(tab.id, {
    type: 'AUTOMATOR_SEND_MESSAGE',
    text: enrichedText,
    taskId
  });
  logEvent(state, 'DISPATCH_MESSAGE_TO_AGENT', { 
    targetAgentId: targetId, 
    tabId: tab.id, 
    chars: text.length,
    hasFiles: taskId ? (await getFilesForTask(taskId)).length > 0 : false
  });
  if (!response?.ok) throw new Error(response?.error || `Could not send to ${targetId}`);
  return response;
}

function buildAgentAssignment(task, targetAgent) {
  const assignmentText = typeof task.assignment === 'string'
    ? task.assignment
    : JSON.stringify(task.assignment, null, 2);

  return [
    'AUTOMATOR ASSIGNMENT',
    `TASK_ID: ${task.id}`,
    `FROM: ${task.createdByAgentId}`,
    `YOUR_AGENT_ID: ${targetAgent.id}`,
    '',
    'ASSIGNMENT:',
    assignmentText,
    '',
    'When this assignment is finished, return exactly one <<AUTOMATOR>> JSON block using action TASK_RESULT and this same TASK_ID.'
  ].join('\n');
}

function buildPmResultEnvelope(sourceAgent, task, command, rawText, files = []) {
  const hasFiles = files && files.length > 0;
  const fileSection = hasFiles 
    ? [
        '',
        'ATTACHED DELIVERABLES:',
        ...files.map(f => `- ${f.fileName} (${f.fileType}, ${(f.sizeBytes / 1024).toFixed(1)}KB)`),
        '',
        'Use sidecar.getFileData(fileId) to retrieve each file.'
      ].join('\n')
    : '';
  
  return [
    'AUTOMATOR AGENT RETURN',
    `SOURCE_AGENT_ID: ${sourceAgent.id}`,
    `SOURCE_AGENT_NAME: ${sourceAgent.name}`,
    `TASK_ID: ${task.id}`,
    `AGENT_STATUS: ${command.status}`,
    hasFiles ? `DELIVERABLE_COUNT: ${files.length}` : '',
    ...fileSection ? [fileSection] : [],
    '',
    'FULL AGENT RESPONSE:',
    rawText
  ].filter(line => line !== '').join('\n');
}

function buildOwnerGateEnvelope(gate) {
  return [
    'AUTOMATOR OWNER GATE RESPONSE',
    `GATE_ID: ${gate.id}`,
    `TASK_ID: ${gate.taskId || 'NONE'}`,
    `RESULT: ${gate.resolution}`,
    `COMMENT: ${gate.comment || '(none)'}`,
    '',
    'Evaluate this owner response and decide the next project action.'
  ].join('\n');
}

function buildValidationCorrection(error, sourceType, activeTaskId = null) {
  const lines = [
    'AUTOMATOR VALIDATION ERROR',
    `Your last machine-readable output was rejected: ${error}`,
    '',
    'Return a corrected response with exactly one block:',
    '<<AUTOMATOR>>',
    '{ valid JSON }',
    '<<END_AUTOMATOR>>',
    '',
    'Do not invent a different action or identifier merely to bypass the error.'
  ];
  if (sourceType === 'SPECIALIST' && activeTaskId) {
    lines.push(`Keep TASK_ID exactly: ${activeTaskId}`);
    lines.push('Agents must use action TASK_RESULT.');
  }
  
  // Add helpful hints for common errors
  if (error.includes('status')) {
    lines.push('');
    lines.push('HINT: Allowed status values are: COMPLETE, FAILED, ESCALATION_REQUIRED, OWNER_ACTION_REQUIRED');
    lines.push('(Note: "COMPLETED" is invalid - use "COMPLETE" without the D)');
  }
  
  if (error.includes('task_id') || error.includes('TASK_RESULT requires')) {
    lines.push('');
    lines.push('HINT: Make sure to include "task_id": "<your-task-id>" in your response');
    lines.push('The task_id must match the one from your assignment exactly.');
  }
  
  if (error.includes('action') || error.includes('TASK_RESULT, not')) {
    lines.push('');
    lines.push('HINT: Agents must use "action": "TASK_RESULT" (not TASK_RESULTS, RESULT, or other variants)');
  }
  
  if (error.includes('JSON') || error.includes('Invalid JSON')) {
    lines.push('');
    lines.push('HINT: Check your JSON syntax:');
    lines.push('- All keys must be in double quotes: "key" not key');
    lines.push('- All string values must be in double quotes: "value" not value');
    lines.push('- No trailing commas after the last item in objects or arrays');
    lines.push('- Use proper escaping for quotes inside strings');
  }
  
  if (error.includes('assigned to') || error.includes('Unknown task_id')) {
    lines.push('');
    lines.push('HINT: Verify that your task_id matches an existing task assigned to you.');
    lines.push('If you see "Unknown task_id", the task may have been completed already or has a different ID.');
  }
  
  return lines.join('\n');
}

async function sendValidationCorrection(state, sourceAgentId, error) {
  const source = state.agents[sourceAgentId];
  if (!source) return;
  const activeTask = source.type === 'PM' ? null : getActiveTaskForAgent(state, sourceAgentId);
  try {
    await dispatchMessageToAgent(
      state,
      sourceAgentId,
      buildValidationCorrection(error, source.type, activeTask?.id || null),
      activeTask?.id || null
    );
    logEvent(state, 'VALIDATION_CORRECTION_SENT', { sourceAgentId, error });
  } catch (sendError) {
    logEvent(state, 'VALIDATION_CORRECTION_FAILED', {
      sourceAgentId,
      error: String(sendError.message || sendError)
    });
  }
}

async function executePmCommand(state, sourceAgentId, command) {
  switch (command.action) {
    case 'DISPATCH_TASK': {
      const taskId = String(command.task_id).trim();
      const targetAgentId = normalizeAgentId(command.target_agent_id);
      const targetAgent = state.agents[targetAgentId];
      const task = {
        id: taskId,
        createdByAgentId: sourceAgentId,
        assignedToAgentId: targetAgentId,
        returnToAgentId: sourceAgentId,
        status: 'DISPATCHING',
        agentStatus: null,
        assignment: command.assignment,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        attempts: 1
      };
      state.tasks[taskId] = task;
      logEvent(state, 'TASK_CREATED', { taskId, targetAgentId, returnToAgentId: sourceAgentId });

      try {
        await dispatchMessageToAgent(state, targetAgentId, buildAgentAssignment(task, targetAgent), taskId);
        task.status = 'RUNNING';
        task.updatedAt = nowIso();
        logEvent(state, 'TASK_DISPATCHED', { taskId, targetAgentId });
      } catch (error) {
        task.status = 'FAILED';
        task.error = String(error.message || error);
        task.updatedAt = nowIso();
        logEvent(state, 'TASK_DISPATCH_FAILED', { taskId, targetAgentId, error: task.error });
      }
      return;
    }

    case 'REQUEST_OWNER_APPROVAL':
    case 'REQUEST_OWNER_ACTION': {
      const gateId = String(command.gate_id).trim();
      const taskId = command.task_id ? String(command.task_id).trim() : null;
      state.ownerGates[gateId] = {
        id: gateId,
        type: command.action,
        status: 'WAITING_FOR_OWNER',
        reason: String(command.reason || ''),
        instructions: String(command.instructions || ''),
        taskId,
        createdByAgentId: sourceAgentId,
        createdAt: nowIso()
      };
      if (taskId && state.tasks[taskId]) {
        state.tasks[taskId].status = 'WAITING_FOR_OWNER';
        state.tasks[taskId].updatedAt = nowIso();
      }
      logEvent(state, 'OWNER_GATE_CREATED', { gateId, taskId, type: command.action });
      return;
    }

    case 'COMPLETE_TASK': {
      const taskId = String(command.task_id).trim();
      state.tasks[taskId].status = 'COMPLETED';
      state.tasks[taskId].updatedAt = nowIso();
      logEvent(state, 'TASK_COMPLETED', { taskId });
      return;
    }

    case 'CANCEL_TASK': {
      const taskId = String(command.task_id).trim();
      state.tasks[taskId].status = 'CANCELLED';
      state.tasks[taskId].updatedAt = nowIso();
      logEvent(state, 'TASK_CANCELLED', { taskId });
      return;
    }

    case 'PAUSE_PROJECT':
      state.paused = true;
      logEvent(state, 'GLOBAL_PAUSE_BY_PM', {});
      return;

    case 'COMPLETE_PROJECT':
      logEvent(state, 'PROJECT_COMPLETION_RECORDED', { note: command.summary || '' });
      return;
  }
}

async function executeAgentResult(state, sourceAgentId, command, rawText) {
  const task = state.tasks[String(command.task_id).trim()];
  const sourceAgent = state.agents[sourceAgentId];
  task.agentStatus = command.status;
  task.resultSummary = command.summary || '';
  task.fullResult = rawText;
  task.status = 'RESULT_RECEIVED';
  task.updatedAt = nowIso();
  
  // Retrieve any files stored in sidecar for this task
  const files = await getFilesForTask(task.id);
  
  logEvent(state, 'TASK_RESULT_RECEIVED', { 
    taskId: task.id, 
    sourceAgentId, 
    agentStatus: command.status,
    deliverableCount: files.length
  });

  try {
    await dispatchMessageToAgent(
      state,
      task.returnToAgentId,
      buildPmResultEnvelope(sourceAgent, task, command, rawText, files),
      task.id
    );
    task.status = 'PM_REVIEW';
    task.returnedToPmAt = nowIso();
    task.updatedAt = nowIso();
    logEvent(state, 'RESULT_RETURNED_TO_PM', {
      taskId: task.id,
      sourceAgentId,
      returnToAgentId: task.returnToAgentId,
      fileCount: files.length
    });
  } catch (error) {
    task.status = 'RESULT_RETURN_FAILED';
    task.error = String(error.message || error);
    task.updatedAt = nowIso();
    logEvent(state, 'RESULT_RETURN_TO_PM_FAILED', { taskId: task.id, error: task.error });
  }
}

async function handleAssistantOutput(tabId, payload) {
  if (!tabId || !payload?.text || payload.streaming) return;

  await mutateState(async (state) => {
    const sourceAgentId = agentIdForTab(state, tabId);
    if (!sourceAgentId) return;

    const fingerprint = payload.fingerprint || payload.text;
    state.lastSeenByAgent[sourceAgentId] = fingerprint;
    if (state.lastProcessedByAgent[sourceAgentId] === fingerprint) return;

    logEvent(state, 'ASSISTANT_OUTPUT_CAPTURED', {
      sourceAgentId,
      tabId,
      chars: payload.text.length
    });

    // Global pause holds automation without consuming the response.
    if (state.paused) {
      logEvent(state, 'OUTPUT_HELD_GLOBAL_PAUSE', { sourceAgentId });
      return;
    }

    const sourceAgent = state.agents[sourceAgentId];
    const parsed = parseProtocol(payload.text);

    if (!parsed.found) {
      if (sourceAgent?.type !== 'PM') {
        const activeTask = getActiveTaskForAgent(state, sourceAgentId);
        if (activeTask) {
          activeTask.status = 'RESPONSE_NO_VALID_RESULT';
          activeTask.updatedAt = nowIso();
          logEvent(state, 'AGENT_RESPONSE_NO_PROTOCOL', { sourceAgentId, taskId: activeTask.id });
        }
      }
      state.lastProcessedByAgent[sourceAgentId] = fingerprint;
      return;
    }

    if (parsed.error && !parsed.extracted) {
      await sendValidationCorrection(state, sourceAgentId, parsed.error);
      state.lastProcessedByAgent[sourceAgentId] = fingerprint;
      return;
    }

    const command = parsed.command;
    let validationError;
    if (sourceAgent?.type === 'PM') {
      validationError = validatePmCommand(state, command);
    } else {
      validationError = validateAgentResult(state, sourceAgentId, command);
    }

    if (validationError) {
      logEvent(state, 'INVALID_COMMAND', { sourceAgentId, error: validationError, command });
      await sendValidationCorrection(state, sourceAgentId, validationError);
      state.lastProcessedByAgent[sourceAgentId] = fingerprint;
      return;
    }

    // If we extracted/corrected the command, log it for visibility
    if (parsed.extracted) {
      logEvent(state, 'INTENTION_EXTRACTED', {
        sourceAgentId,
        correction: parsed.error,
        command: command.action
      });
    }

    if (sourceAgent?.type === 'PM') {
      await executePmCommand(state, sourceAgentId, command);
    } else {
      await executeAgentResult(state, sourceAgentId, command, payload.text);
    }

    state.lastProcessedByAgent[sourceAgentId] = fingerprint;
  });
}

async function reconcileAgentTabs() {
  const openTabs = await listChatGptTabs();
  await mutateState(async (state) => {
    for (const [agentId, agent] of Object.entries(state.agents)) {
      let match = null;
      if (agent.tabId) {
        match = openTabs.find(
          (tab) => tab.id === agent.tabId && tab.conversationUrl === agent.conversationUrl
        ) || null;
      }
      if (!match && agent.conversationUrl) {
        match = openTabs.find((tab) => tab.conversationUrl === agent.conversationUrl) || null;
      }

      if (match) {
        const changed = agent.tabId !== match.id || agent.status !== 'CONNECTED';
        agent.tabId = match.id;
        agent.title = match.title;
        agent.status = 'CONNECTED';
        agent.updatedAt = nowIso();
        if (changed) logEvent(state, 'AGENT_RECONNECTED', { agentId, tabId: match.id });
      } else if (agent.tabId || agent.status !== 'MISSING') {
        agent.tabId = null;
        agent.status = 'MISSING';
        agent.updatedAt = nowIso();
        logEvent(state, 'AGENT_TAB_MISSING', { agentId });
      }
    }
  });
}

async function reconcile() {
  await reconcileAgentTabs();
  const state = await loadState();
  for (const agent of Object.values(state.agents)) {
    if (!agent.tabId) continue;
    const response = await sendToTab(agent.tabId, { type: 'AUTOMATOR_GET_LAST_ASSISTANT' });
    if (response?.ok && response.message) {
      await handleAssistantOutput(agent.tabId, response.message);
    }
  }
}

async function ensureReconcileAlarm() {
  const alarm = await chrome.alarms.get(RECONCILE_ALARM).catch(() => null);
  if (!alarm) {
    await chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(STORAGE_KEY);
  await saveState(normalizeState(current[STORAGE_KEY]));
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await ensureReconcileAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureReconcileAlarm();
  await reconcile();
});

// Service workers are ephemeral. Check the recovery alarm whenever this worker starts.
ensureReconcileAlarm().catch(() => {});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) reconcile();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await mutateState(async (state) => {
    const agentId = agentIdForTab(state, tabId);
    if (!agentId) return;
    state.agents[agentId].tabId = null;
    state.agents[agentId].status = 'MISSING';
    state.agents[agentId].updatedAt = nowIso();
    logEvent(state, 'REGISTERED_TAB_CLOSED', { agentId, tabId });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'AUTOMATOR_ASSISTANT_OUTPUT':
        await handleAssistantOutput(sender.tab?.id, message.payload);
        sendResponse({ ok: true });
        return;

      case 'AUTOMATOR_GET_STATE':
        sendResponse({ ok: true, state: await loadState() });
        return;

      case 'AUTOMATOR_LIST_CHATGPT_TABS':
        sendResponse({ ok: true, tabs: await listChatGptTabs() });
        return;

      case 'AUTOMATOR_UPSERT_AGENT': {
        const name = String(message.agent?.name || '').trim();
        const description = String(message.agent?.description || '').trim();
        const type = message.agent?.type === 'PM' ? 'PM' : 'SPECIALIST';
        const isEdit = Boolean(message.agent?.isEdit);
        let agentId = type === 'PM' ? 'pm' : normalizeAgentId(message.agent?.id || name);
        const tabId = Number(message.agent?.tabId);
        if (!name) throw new Error('Agent name is required.');
        if (!agentId) throw new Error('Agent ID is required.');
        if (!Number.isInteger(tabId)) throw new Error('Choose a ChatGPT tab for this agent.');

        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !CHATGPT_URL_RE.test(tab.url || '')) throw new Error('Selected tab is not a ChatGPT tab.');
        const conversationUrl = normalizeConversationUrl(tab.url);
        if (!conversationUrl) throw new Error('Could not identify the ChatGPT conversation URL.');
        const conversationPath = new URL(conversationUrl).pathname;
        if (!conversationPath || conversationPath === '/') {
          throw new Error('Open an actual ChatGPT conversation first (send at least one message), then assign that conversation.');
        }
        if (type !== 'PM' && agentId === 'pm') throw new Error('The agent ID pm is reserved for the Project Manager.');

        const state = await mutateState(async (draft) => {
          const existing = draft.agents[agentId];
          if (existing && !isEdit) throw new Error(`Agent ID ${agentId} already exists. Use Edit instead.`);
          if (!existing && isEdit) throw new Error('The agent being edited no longer exists.');
          if (existing && existing.type !== type) throw new Error('Agent type cannot be changed after creation. Remove and recreate the agent instead.');
          if (type === 'PM') {
            const existingPm = getPmAgent(draft);
            if (existingPm && existingPm.id !== agentId) throw new Error('Only one PM is allowed in V1.');
          }

          for (const [otherId, other] of Object.entries(draft.agents)) {
            if (otherId !== agentId && other.conversationUrl === conversationUrl) {
              throw new Error(`That ChatGPT conversation is already assigned to ${other.name}.`);
            }
          }

          draft.agents[agentId] = {
            id: agentId,
            name,
            description,
            type,
            tabId,
            conversationUrl,
            title: tab.title || name,
            status: 'CONNECTED',
            createdAt: existing?.createdAt || nowIso(),
            updatedAt: nowIso()
          };
          logEvent(draft, existing ? 'AGENT_UPDATED' : 'AGENT_CREATED', { agentId, tabId, type });
        });
        sendResponse({ ok: true, state });
        return;
      }

      case 'AUTOMATOR_REMOVE_AGENT': {
        const agentId = normalizeAgentId(message.agentId);
        const state = await mutateState(async (draft) => {
          if (!draft.agents[agentId]) throw new Error('Agent not found.');
          const activeTask = getActiveTaskForAgent(draft, agentId);
          if (activeTask) throw new Error(`Cannot remove ${agentId} while ${activeTask.id} is active.`);
          if (draft.agents[agentId].type === 'PM') {
            const hasOpenWorkflow = Object.values(draft.tasks).some((task) => !TERMINAL_TASK_STATES.has(task.status));
            const hasOpenGate = Object.values(draft.ownerGates).some((gate) => gate.status === 'WAITING_FOR_OWNER');
            if (hasOpenWorkflow || hasOpenGate) throw new Error('Cannot remove PM while workflows or owner gates are open.');
          }
          delete draft.agents[agentId];
          delete draft.lastSeenByAgent[agentId];
          delete draft.lastProcessedByAgent[agentId];
          logEvent(draft, 'AGENT_REMOVED', { agentId });
        });
        sendResponse({ ok: true, state });
        return;
      }

      case 'AUTOMATOR_SET_PAUSED': {
        const state = await mutateState(async (draft) => {
          draft.paused = Boolean(message.paused);
          logEvent(draft, draft.paused ? 'GLOBAL_PAUSED' : 'GLOBAL_RESUMED', { source: 'OWNER_UI' });
        });
        if (!state.paused) await reconcile();
        sendResponse({ ok: true, state: await loadState() });
        return;
      }

      case 'AUTOMATOR_RESOLVE_GATE': {
        const state = await mutateState(async (draft) => {
          const gate = draft.ownerGates[message.gateId];
          if (!gate) throw new Error('Gate not found.');
          if (gate.status !== 'WAITING_FOR_OWNER') throw new Error('Gate is already resolved.');
          gate.status = 'RESOLVED';
          gate.resolution = String(message.resolution || '').toUpperCase();
          gate.comment = String(message.comment || '');
          gate.resolvedAt = nowIso();
          logEvent(draft, 'OWNER_GATE_RESOLVED', { gateId: gate.id, resolution: gate.resolution });

          const pm = getPmAgent(draft);
          if (!pm) throw new Error('PM is not configured.');
          try {
            await dispatchMessageToAgent(draft, pm.id, buildOwnerGateEnvelope(gate), gate.taskId);
            logEvent(draft, 'OWNER_GATE_RETURNED_TO_PM', { gateId: gate.id });
          } catch (error) {
            gate.returnError = String(error.message || error);
            logEvent(draft, 'OWNER_GATE_RETURN_FAILED', { gateId: gate.id, error: gate.returnError });
          }
        });
        sendResponse({ ok: true, state });
        return;
      }

      case 'AUTOMATOR_RECONCILE_NOW':
        await reconcile();
        sendResponse({ ok: true, state: await loadState() });
        return;

      case 'AUTOMATOR_OPEN_AGENT': {
        const state = await loadState();
        const agentId = normalizeAgentId(message.agentId);
        const agent = state.agents[agentId];
        if (!agent) throw new Error('Agent not found.');

        let tab = null;
        if (agent.tabId) {
          tab = await chrome.tabs.get(agent.tabId).catch(() => null);
          if (tab && normalizeConversationUrl(tab.url) !== agent.conversationUrl) tab = null;
        }
        if (!tab && agent.conversationUrl) {
          const openTabs = await listChatGptTabs();
          const match = openTabs.find((item) => item.conversationUrl === agent.conversationUrl);
          if (match) tab = await chrome.tabs.get(match.id);
        }
        if (!tab && agent.conversationUrl) {
          tab = await chrome.tabs.create({ url: agent.conversationUrl, active: true });
        }
        if (!tab) throw new Error('No saved conversation URL for this agent.');

        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        await mutateState(async (draft) => {
          if (!draft.agents[agentId]) return;
          draft.agents[agentId].tabId = tab.id;
          draft.agents[agentId].status = 'CONNECTED';
          draft.agents[agentId].title = tab.title || draft.agents[agentId].title;
          draft.agents[agentId].updatedAt = nowIso();
          logEvent(draft, 'AGENT_OPENED', { agentId, tabId: tab.id });
        });
        sendResponse({ ok: true, state: await loadState() });
        return;
      }

      case 'AUTOMATOR_CLEAR_DATA':
        await saveState(structuredClone(DEFAULT_STATE));
        sendResponse({ ok: true, state: await loadState() });
        return;

      // File Sidecar API for storing deliverables between agents
      case 'AUTOMATOR_STORE_FILE': {
        const { taskId, fileName, fileType, dataUrl, metadata } = message;
        if (!taskId || !fileName || !dataUrl) {
          throw new Error('taskId, fileName, and dataUrl are required');
        }
        try {
          const result = await storeFileForTask(taskId, fileName, fileType || 'application/octet-stream', dataUrl, metadata);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        return;
      }

      case 'AUTOMATOR_GET_FILES': {
        const { taskId } = message;
        if (!taskId) {
          throw new Error('taskId is required');
        }
        const files = await getFilesForTask(taskId);
        sendResponse({ ok: true, files });
        return;
      }

      case 'AUTOMATOR_GET_FILE_DATA': {
        const { fileId } = message;
        if (!fileId) {
          throw new Error('fileId is required');
        }
        const fileData = await getFileData(fileId);
        sendResponse({ ok: true, file: fileData });
        return;
      }

      case 'AUTOMATOR_DELETE_FILE': {
        const { fileId } = message;
        if (!fileId) {
          throw new Error('fileId is required');
        }
        await deleteFileFromSidecar(fileId);
        sendResponse({ ok: true });
        return;
      }

      case 'AUTOMATOR_CLEAR_TASK_FILES': {
        const { taskId } = message;
        if (!taskId) {
          throw new Error('taskId is required');
        }
        await clearTaskFiles(taskId);
        sendResponse({ ok: true });
        return;
      }

      case 'AUTOMATOR_GET_STORAGE_INFO': {
        const totalSize = await getTotalStorageSize();
        sendResponse({
          ok: true,
          usedBytes: totalSize,
          usedMB: (totalSize / 1024 / 1024).toFixed(2),
          maxBytes: MAX_TOTAL_STORAGE_BYTES,
          maxMB: (MAX_TOTAL_STORAGE_BYTES / 1024 / 1024).toFixed(2),
          percentUsed: ((totalSize / MAX_TOTAL_STORAGE_BYTES) * 100).toFixed(1)
        });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
