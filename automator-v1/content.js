(() => {
  if (window.__AUTOMATOR_V1_02_LOADED__) return;
  window.__AUTOMATOR_V1_02_LOADED__ = true;
  
  // Anti-detection: Random delay with human-like variation
  const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  
  // Gaussian distribution for natural timing patterns
  function gaussianRandom(mean = 0, stdev = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mean + stdev * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  
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
  
  // Anti-detection: Simulate realistic mouse movement with Bezier curves
  function simulateMouseMovement(element) {
    const rect = element.getBoundingClientRect();
    const startX = rect.left + (Math.random() - 0.5) * 200;
    const startY = rect.top + (Math.random() - 0.5) * 200;
    const endX = rect.left + rect.width / 2;
    const endY = rect.top + rect.height / 2;
    
    const numPoints = randomDelay(5, 12);
    const points = [];
    
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const x = startX + (endX - startX) * t + gaussianRandom(0, 3);
      const y = startY + (endY - startY) * t + gaussianRandom(0, 3);
      points.push({ x, y });
    }
    
    points.forEach((point, idx) => {
      setTimeout(() => {
        element.dispatchEvent(new MouseEvent('mousemove', {
          clientX: Math.round(point.x),
          clientY: Math.round(point.y),
          bubbles: true,
          cancelable: true
        }));
      }, idx * randomDelay(20, 60));
    });
    
    return numPoints * 40;
  }
  
  // Anti-detection: Enhanced text input with proper event sequence
  function setComposerText(composer, text) {
    composer.focus();
    
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const tagName = composer.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement';
      const proto = window[tagName].prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      
      if (descriptor && descriptor.set) {
        descriptor.set.call(composer, text);
      } else {
        composer.value = text;
      }
      
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
        isComposing: false
      }));
      
      setTimeout(() => {
        composer.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }, randomDelay(30, 120));
      
      return;
    }

    composer.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    composer.appendChild(paragraph);
    
    try {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
      isComposing: false
    }));
  }
  
  // Anti-detection: Natural button click simulation
  async function clickButtonNatural(button) {
    const moveDuration = simulateMouseMovement(button);
    await new Promise(resolve => setTimeout(resolve, moveDuration + randomDelay(100, 300)));
    
    button.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    
    await new Promise(resolve => setTimeout(resolve, randomDelay(80, 250)));
    
    button.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1
    }));
    
    await new Promise(resolve => setTimeout(resolve, randomDelay(60, 180)));
    
    button.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0
    }));
    
    button.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1
    }));
  }
  
  // Main send message function with comprehensive anti-detection
  async function sendMessage(text) {
    const composer = findComposer();
    if (!composer) throw new Error('ChatGPT message composer was not found.');
    if (isStreaming()) throw new Error('ChatGPT is currently generating a response.');
    
    // Initial focus with human-like pause
    composer.focus();
    composer.click();
    await new Promise(resolve => setTimeout(resolve, randomDelay(200, 600)));
    
    // Clear existing text
    const existingText = composer.value || composer.innerText || '';
    if (existingText.trim()) {
      for (let i = 0; i < existingText.length; i++) {
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8,
          bubbles: true, cancelable: true
        }));
        await new Promise(resolve => setTimeout(resolve, randomDelay(20, 60)));
      }
    }
    
    setComposerText(composer, text);
    await new Promise(resolve => setTimeout(resolve, randomDelay(300, 800)));
    
    // Cursor positioning
    try {
      if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
        composer.selectionStart = composer.selectionEnd = composer.value.length;
      } else {
        const range = document.createRange();
        const sel = window.getSelection();
        if (composer.lastChild) {
          range.setStart(composer.lastChild, composer.lastChild.textContent?.length || 0);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch (_) {}
    
    await new Promise(resolve => setTimeout(resolve, randomDelay(150, 400)));
    
    // Find and click send button naturally
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
      await clickButtonNatural(sendButton);
      return;
    }
    
    // Fallback: Natural Enter key press
    const hasShift = Math.random() > 0.85;
    
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, shiftKey: hasShift
    }));
    await new Promise(resolve => setTimeout(resolve, randomDelay(40, 100)));
    
    composer.dispatchEvent(new KeyboardEvent('keypress', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, charCode: 13
    }));
    await new Promise(resolve => setTimeout(resolve, randomDelay(30, 80)));
    
    composer.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
  }
  
  async function announceLatest() {
    const message = getLastAssistantMessage();
    if (!message || message.streaming || message.fingerprint === lastAnnouncedFingerprint) return;
    lastAnnouncedFingerprint = message.fingerprint;
    try {
      await chrome.runtime.sendMessage({ type: 'AUTOMATOR_ASSISTANT_OUTPUT', payload: message });
    } catch (_) {}
  }
  
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(announceLatest, randomDelay(700, 1400));
  });
  
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  
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
      sendResponse({ ok: false, error: 'Unknown content-script message' });
    })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  });
  
  setTimeout(announceLatest, randomDelay(800, 2000));
})();
