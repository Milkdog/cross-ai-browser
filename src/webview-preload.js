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
  let hasImage = false;

  try {
    if (serviceId === 'chatgpt') {
      // ChatGPT: Get last assistant message - try multiple selectors
      const selectors = [
        '[data-message-author-role="assistant"]',
        '.agent-turn .markdown',
        '.assistant-message',
        '[data-testid^="conversation-turn"] .markdown'
      ];
      let lastMessage = null;
      for (const selector of selectors) {
        const messages = document.querySelectorAll(selector);
        if (messages.length > 0) {
          lastMessage = messages[messages.length - 1];
          break;
        }
      }

      if (lastMessage) {
        // Check if this message contains a generated image
        const images = lastMessage.querySelectorAll('img');
        for (const img of images) {
          const src = img.src || '';
          // DALL-E images come from OpenAI's CDN
          if (src.includes('oaidalleapi') || src.includes('openai') ||
              src.includes('dalle') || img.alt?.toLowerCase().includes('generated')) {
            hasImage = true;
            // Try to get the image prompt from alt text or nearby text
            if (img.alt && img.alt.length > 5 && !img.alt.toLowerCase().includes('image')) {
              text = `Image: ${img.alt}`;
            }
            break;
          }
        }

        // If no meaningful image alt text, check for image containers
        if (hasImage && !text) {
          text = 'Generated an image';
        }

        // Fall back to text content if no image
        if (!hasImage) {
          text = lastMessage.textContent || '';
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

// Extract a short preview of the user's last prompt
function getUserPromptPreview(maxLength = 40) {
  const serviceId = getServiceId();
  let text = '';

  try {
    if (serviceId === 'chatgpt') {
      // ChatGPT: Get last user message
      const selectors = [
        '[data-message-author-role="user"]',
        '.user-turn .markdown',
        '.user-message'
      ];
      for (const selector of selectors) {
        const messages = document.querySelectorAll(selector);
        if (messages.length > 0) {
          text = messages[messages.length - 1].textContent || '';
          if (text) break;
        }
      }
    } else if (serviceId === 'claude') {
      // Claude: Get last user message
      const selectors = [
        '[data-testid="user-message"]',
        '.font-user-message',
        '[class*="user-message"]',
        '.human-message'
      ];
      for (const selector of selectors) {
        const msgs = document.querySelectorAll(selector);
        if (msgs.length > 0) {
          text = msgs[msgs.length - 1].textContent || '';
          if (text) break;
        }
      }
    } else if (serviceId === 'gemini') {
      // Gemini: Get last user message
      const selectors = [
        '.user-message-text',
        '[class*="query-content"]',
        '.query-text'
      ];
      for (const selector of selectors) {
        const queries = document.querySelectorAll(selector);
        if (queries.length > 0) {
          text = queries[queries.length - 1].textContent || '';
          if (text) break;
        }
      }
    }
  } catch (e) {
    console.log('[CrossAI] Error getting user prompt:', e);
  }

  // Clean and truncate
  text = text.trim().replace(/\s+/g, ' ');
  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }
  return text || 'Generating response...';
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

    // Log diagnostic info every 10 seconds
    setInterval(() => {
      if (this.serviceId === 'chatgpt') {
        const stopBtn = document.querySelector('[data-testid="stop-button"]');
        const buttons = document.querySelectorAll('button[aria-label]');
        const ariaLabels = Array.from(buttons).map(b => b.getAttribute('aria-label')).filter(Boolean);
        this.log('ChatGPT diagnostic - stopBtn:', !!stopBtn, 'streaming:', this.isStreaming, 'aria-labels:', ariaLabels.slice(0, 5));
      }
    }, 10000);

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

    // Detect streaming started
    if (!wasStreaming && this.isStreaming) {
      this.log('Detected streaming started!');
      clearTimeout(this.debounceTimer);
      this.onStreamingStarted();
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

    // Method 2.5: Look for streaming/typing indicator classes
    const streamingIndicators = document.querySelectorAll(
      '[class*="streaming"], [class*="typing"], [class*="thinking"]'
    );
    for (const indicator of streamingIndicators) {
      if (indicator.offsetParent !== null) {
        this.log('Detected: streaming/typing class:', indicator.className);
        return true;
      }
    }

    // Method 3: Look for image generation loading states
    // ChatGPT shows "Creating image..." or similar during DALL-E generation
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length > 0) {
      const lastMessage = assistantMessages[assistantMessages.length - 1];
      const text = lastMessage.textContent || '';
      // Check for image generation indicators
      if (text.includes('Creating image') ||
          text.includes('Generating image') ||
          text.includes('generating your image')) {
        this.log('Detected: image generation text');
        return true;
      }

      // Check for loading spinner/animation in the last message
      const spinner = lastMessage.querySelector('[class*="spinner"], [class*="loading"], [class*="animate-spin"], svg.animate-spin');
      if (spinner) {
        this.log('Detected: loading spinner in message');
        return true;
      }
    }

    // Method 4: Look for any progress indicators
    const progressIndicators = document.querySelectorAll(
      '[role="progressbar"], ' +
      '[class*="progress"], ' +
      '[class*="loading"]:not([class*="loaded"]), ' +
      '.animate-pulse'
    );
    for (const indicator of progressIndicators) {
      // Make sure it's visible and in the main content area
      if (indicator.offsetParent !== null &&
          (indicator.closest('main') || indicator.closest('[class*="conversation"]'))) {
        this.log('Detected: progress indicator');
        return true;
      }
    }

    // Method 5: Look for button with stop icon (square SVG) that's visible
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

  onStreamingStarted() {
    this.log(`${this.serviceId} started streaming`);

    // Try to get the user's prompt to show as task description
    const taskDescription = getUserPromptPreview();

    ipcRenderer.send('ai-streaming-state', {
      serviceId: this.serviceId,
      isStreaming: true,
      taskDescription: taskDescription
    });
  }

  onStreamingComplete() {
    this.log(`${this.serviceId} finished streaming, sending notification`);

    const preview = getResponsePreview();
    this.log(`Preview: "${preview.substring(0, 50)}..."`);

    // Send streaming stopped state
    ipcRenderer.send('ai-streaming-state', {
      serviceId: this.serviceId,
      isStreaming: false,
      taskDescription: null
    });

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
