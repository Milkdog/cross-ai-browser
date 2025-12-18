const { ipcRenderer } = require('electron');

// Detect which AI service we're on based on URL
function getServiceId() {
  const host = window.location.hostname;
  if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return null;
}

// Extract preview text from the last AI response
function getResponsePreview(maxLength = 100) {
  const serviceId = getServiceId();
  let text = '';

  try {
    if (serviceId === 'chatgpt') {
      // ChatGPT: Get last assistant message - try multiple selectors
      const selectors = [
        '[data-message-author-role="assistant"]',
        '.agent-turn .markdown',
        '.assistant-message',
        '[data-testid^="conversation-turn"] .markdown'
      ];
      for (const selector of selectors) {
        const messages = document.querySelectorAll(selector);
        if (messages.length > 0) {
          text = messages[messages.length - 1].textContent || '';
          if (text) break;
        }
      }
    } else if (serviceId === 'claude') {
      // Claude: Get last response block
      const selectors = [
        '[data-is-streaming]',
        '.font-claude-message',
        '[class*="claude-message"]',
        '.prose'
      ];
      for (const selector of selectors) {
        const msgs = document.querySelectorAll(selector);
        if (msgs.length > 0) {
          text = msgs[msgs.length - 1].textContent || '';
          if (text) break;
        }
      }
    } else if (serviceId === 'gemini') {
      // Gemini: Get last response
      const selectors = [
        '.model-response-text',
        '[class*="response-content"]',
        '.markdown-content'
      ];
      for (const selector of selectors) {
        const responses = document.querySelectorAll(selector);
        if (responses.length > 0) {
          text = responses[responses.length - 1].textContent || '';
          if (text) break;
        }
      }
    }
  } catch (e) {
    console.log('[CrossAI] Error getting preview:', e);
  }

  // Clean and truncate
  text = text.trim().replace(/\s+/g, ' ');
  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }
  return text;
}

// Streaming detection for each service
class StreamingDetector {
  constructor() {
    this.isStreaming = false;
    this.observer = null;
    this.serviceId = null;
    this.debounceTimer = null;
    this.lastStreamingState = false;
    this.debug = true; // Enable debug logging
  }

  log(...args) {
    if (this.debug) {
      console.log('[CrossAI]', ...args);
    }
  }

  init() {
    // Wait for page to fully load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setup());
    } else {
      // Small delay to ensure page is ready
      setTimeout(() => this.setup(), 500);
    }
  }

  setup() {
    this.serviceId = getServiceId();
    if (!this.serviceId) {
      this.log('Unknown service, not initializing detector');
      return;
    }

    this.log(`Initializing streaming detector for ${this.serviceId}`);
    this.log(`URL: ${window.location.href}`);

    // Start observing after a short delay to let the page settle
    setTimeout(() => this.startObserving(), 1500);
  }

  startObserving() {
    this.log('Starting DOM observation...');

    this.observer = new MutationObserver(() => {
      this.checkStreamingState();
    });

    // Observe the entire document for changes
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    // Check periodically as a fallback
    setInterval(() => this.checkStreamingState(), 1000);

    // Initial check
    this.checkStreamingState();
  }

  checkStreamingState() {
    const wasStreaming = this.isStreaming;
    this.isStreaming = this.detectStreaming();

    // Log state changes
    if (this.isStreaming !== this.lastStreamingState) {
      this.log(`Streaming state changed: ${this.lastStreamingState} -> ${this.isStreaming}`);
      this.lastStreamingState = this.isStreaming;
    }

    // Debounce the "finished" detection to avoid false positives
    if (wasStreaming && !this.isStreaming) {
      this.log('Detected streaming may have ended, waiting to confirm...');
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        // Double-check we're still not streaming
        if (!this.detectStreaming()) {
          this.log('Confirmed streaming complete!');
          this.onStreamingComplete();
        } else {
          this.log('False alarm, still streaming');
        }
      }, 1000); // Wait 1 second to confirm
    }
  }

  detectStreaming() {
    try {
      switch (this.serviceId) {
        case 'chatgpt':
          return this.detectChatGPTStreaming();
        case 'claude':
          return this.detectClaudeStreaming();
        case 'gemini':
          return this.detectGeminiStreaming();
        default:
          return false;
      }
    } catch (e) {
      this.log('Error detecting streaming:', e);
      return false;
    }
  }

  detectChatGPTStreaming() {
    // Method 1: Look for stop button by test ID (most reliable)
    const stopBtn = document.querySelector('[data-testid="stop-button"]');
    if (stopBtn) {
      this.log('Detected: stop-button testid');
      return true;
    }

    // Method 2: Look for the streaming result class
    const streamingResult = document.querySelector('.result-streaming');
    if (streamingResult) {
      this.log('Detected: result-streaming class');
      return true;
    }

    // Method 3: Look for button with stop icon (square SVG) that's visible
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      // Check if button has aria-label containing "stop"
      const ariaLabel = btn.getAttribute('aria-label') || '';
      if (ariaLabel.toLowerCase().includes('stop') && btn.offsetParent !== null) {
        this.log('Detected: button with stop aria-label');
        return true;
      }

      // Check for SVG with rect (stop icon is a square)
      const svg = btn.querySelector('svg');
      if (svg) {
        const rect = svg.querySelector('rect');
        const paths = svg.querySelectorAll('path');
        // Stop icon typically has just a rect, no complex paths
        if (rect && paths.length === 0 && btn.offsetParent !== null) {
          // Make sure the button is in the chat input area
          const isInInputArea = btn.closest('form') || btn.closest('[class*="input"]') || btn.closest('[class*="composer"]');
          if (isInInputArea) {
            this.log('Detected: stop button SVG');
            return true;
          }
        }
      }
    }

    return false;
  }

  detectClaudeStreaming() {
    // Method 1: data-is-streaming attribute (most reliable)
    const streamingEl = document.querySelector('[data-is-streaming="true"]');
    if (streamingEl) {
      this.log('Detected: data-is-streaming=true');
      return true;
    }

    // Method 2: Stop button with specific aria-label
    const stopBtn = document.querySelector('[aria-label="Stop Response"]');
    if (stopBtn && stopBtn.offsetParent !== null) {
      this.log('Detected: Stop Response button');
      return true;
    }

    // Method 3: Look for visible button with "Stop" text in the input area
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const text = btn.textContent || '';
      if ((ariaLabel.toLowerCase() === 'stop' || text.toLowerCase() === 'stop') &&
          btn.offsetParent !== null) {
        this.log('Detected: Stop button');
        return true;
      }
    }

    return false;
  }

  detectGeminiStreaming() {
    // Method 1: Stop button (most reliable)
    const stopBtn = document.querySelector('[aria-label="Stop"]');
    if (stopBtn && stopBtn.offsetParent !== null) {
      this.log('Detected: Stop button');
      return true;
    }

    // Method 2: Look for visible button with "Stop" text
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const text = btn.textContent || '';
      if ((ariaLabel.toLowerCase() === 'stop' || text.toLowerCase() === 'stop') &&
          btn.offsetParent !== null) {
        this.log('Detected: Stop button by text');
        return true;
      }
    }

    // Method 3: Look for specific Gemini streaming indicator
    // Gemini shows a loading animation while generating
    const loadingSpinner = document.querySelector('[data-test-id="loading"]');
    if (loadingSpinner) {
      this.log('Detected: loading spinner');
      return true;
    }

    return false;
  }

  onStreamingComplete() {
    this.log(`${this.serviceId} finished streaming, sending notification`);

    const preview = getResponsePreview();
    this.log(`Preview: "${preview.substring(0, 50)}..."`);

    ipcRenderer.send('ai-response-complete', {
      serviceId: this.serviceId,
      preview: preview,
      imageUrl: null
    });
  }
}

// Initialize detector
const detector = new StreamingDetector();
detector.init();

console.log('[CrossAI] Webview preload initialized for:', window.location.hostname);
