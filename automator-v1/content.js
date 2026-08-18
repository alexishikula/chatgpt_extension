(() => {
  if (window.__AUTOMATOR_V1_02_LOADED__) return;
  window.__AUTOMATOR_V1_02_LOADED__ = true;

  let debounceTimer = null;
  let lastAnnouncedFingerprint = null;

  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    'article [data-message-author-role="assistant"]'
  ];

  function hashString(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function getAssistantNodes() {
    for (const selector of assistantSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length) return nodes;
    }
    return [];
  }

  function isStreaming() {
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]'
    ];
    return stopSelectors.some((selector) => document.querySelector(selector));
  }

  function getLastAssistantMessage() {
    const nodes = getAssistantNodes();
    if (!nodes.length) return null;
    const node = nodes[nodes.length - 1];
    const text = (node.innerText || node.textContent || '').trim();
    if (!text) return null;
    const fingerprint = hashString(`${location.href}\n${text}`);
    return {
      text,
      fingerprint,
      streaming: isStreaming(),
      url: location.href,
      capturedAt: new Date().toISOString()
    };
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      'div[contenteditable="true"][data-testid="prompt-textarea"]',
      'div.ProseMirror[contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function setComposerText(composer, text) {
    composer.focus();
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    composer.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    composer.appendChild(paragraph);
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
  }

  async function sendMessage(text) {
    const composer = findComposer();
    if (!composer) throw new Error('ChatGPT message composer was not found.');
    if (isStreaming()) throw new Error('ChatGPT is currently generating a response.');

    setComposerText(composer, text);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]'
    ];
    let sendButton = null;
    for (const selector of sendSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && !candidate.disabled) {
        sendButton = candidate;
        break;
      }
    }

    if (sendButton) {
      sendButton.click();
      return;
    }

    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
  }

  async function announceLatest() {
    const message = getLastAssistantMessage();
    if (!message || message.streaming || message.fingerprint === lastAnnouncedFingerprint) return;
    lastAnnouncedFingerprint = message.fingerprint;
    try {
      await chrome.runtime.sendMessage({ type: 'AUTOMATOR_ASSISTANT_OUTPUT', payload: message });
    } catch (_) {
      // Background service worker may be restarting; reconciliation will recover later.
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(announceLatest, 900);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Helper function to convert Blob to Data URL
  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Handle file reading requests from background script
  async function handleReadFileRequest(filePath, fileName, taskId, sha256) {
    try {
      // In a browser extension context, we cannot directly access sandbox: paths
      // These paths refer to files inside the Docker container where the agent runs
      // The agent must explicitly provide file content via sidecar.storeFile() before completing
      
      // Instead, we check if the agent has already stored this file via the sidecar API
      // If not, we return an error indicating the file needs to be stored first
      const storeFileMessage = {
        type: 'AUTOMATOR_CHECK_STORED_FILE',
        taskId,
        fileName,
        filePath,
        sha256
      };
      
      // Try to get the file from sidecar storage
      const response = await chrome.runtime.sendMessage({
        type: 'AUTOMATOR_GET_FILE_DATA',
        fileId: `${taskId}:${fileName}`
      });
      
      if (response && response.ok && response.file) {
        return {
          ok: true,
          dataUrl: response.file.dataUrl,
          fileName,
          taskId,
          source: 'sidecar'
        };
      }
      
      // File not found in sidecar - agent should have stored it before completing
      throw new Error(`File not found in sidecar. Agent must call sidecar.storeFile() before completing task.`);
      
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        fileName,
        taskId
      };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === 'AUTOMATOR_GET_LAST_ASSISTANT') {
        sendResponse({ ok: true, message: getLastAssistantMessage() });
        return;
      }
      if (message?.type === 'AUTOMATOR_SEND_MESSAGE') {
        await sendMessage(String(message.text || ''));
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'AUTOMATOR_GET_PAGE_STATE') {
        sendResponse({
          ok: true,
          url: location.href,
          streaming: isStreaming(),
          hasComposer: Boolean(findComposer()),
          lastAssistant: getLastAssistantMessage()
        });
        return;
      }
      if (message?.type === 'AUTOMATOR_READ_FILE') {
        const { filePath, fileName, taskId, sha256 } = message;
        const result = await handleReadFileRequest(filePath, fileName, taskId, sha256);
        sendResponse(result);
        return;
      }
      sendResponse({ ok: false, error: 'Unknown content-script message' });
    })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  });

  setTimeout(announceLatest, 1000);
})();
