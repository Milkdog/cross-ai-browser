/**
 * Prompt Library UI for Claude Code terminals
 *
 * Provides:
 * - Collapsible prompt library panel on right side of terminal
 * - Prompt CRUD operations (create, read, update, delete, duplicate)
 * - Drag-drop reordering within panel
 * - Drag prompt to terminal to insert as input
 * - Resizable panel width
 * - Done section for completed prompts
 * - Reusable toggle for prompts that shouldn't move to Done
 * - Favorites (pinned prompts)
 * - Labels (multiple tags per prompt)
 * - Global vs Project scope
 * - Search/filter
 */

class PromptLibrary {
  constructor() {
    this.prompts = [];
    this.labelColors = {}; // Map of label name to color index
    this.panelVisible = false;
    this.panelWidth = 300;
    this.editingPromptId = null;
    this.draggedPromptId = null;
    this.isResizing = false;
    this.doneCollapsed = false;
    this.testingCollapsed = false;
    this.reusableCollapsed = false;
    this.regularCollapsed = false;
    this.notesCollapsed = false;
    this.searchQuery = '';
    this.testingTimerInterval = null;
    this.isInlineEditing = false;
    this.preEditPanelWidth = null;

    // DOM elements (set after init)
    this.panel = null;
    this.promptsContainer = null;
    this.toggleBtn = null;
    this.resizeDivider = null;
    this.terminalContainer = null;
    this.searchInput = null;
  }

  /**
   * Create an SVG icon element
   */
  createIcon(name, size = 14) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const icons = {
      star: () => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        path.setAttribute('points', '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
        return [path];
      },
      'star-filled': () => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        path.setAttribute('points', '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
        path.setAttribute('fill', 'currentColor');
        return [path];
      },
      edit: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
        return [path1, path2];
      },
      copy: () => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '9');
        rect.setAttribute('y', '9');
        rect.setAttribute('width', '13');
        rect.setAttribute('height', '13');
        rect.setAttribute('rx', '2');
        rect.setAttribute('ry', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
        return [rect, path];
      },
      trash: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path1.setAttribute('points', '3 6 5 6 21 6');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
        return [path1, path2];
      },
      restore: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M3 3v5h5');
        return [path1, path2];
      },
      globe: () => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '10');
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path1.setAttribute('x1', '2');
        path1.setAttribute('y1', '12');
        path1.setAttribute('x2', '22');
        path1.setAttribute('y2', '12');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z');
        return [circle, path1, path2];
      },
      folder: () => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
        return [path];
      },
      refresh: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M23 4v6h-6');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M1 20v-6h6');
        const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path3.setAttribute('d', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15');
        return [path1, path2, path3];
      },
      image: () => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '3');
        rect.setAttribute('y', '3');
        rect.setAttribute('width', '18');
        rect.setAttribute('height', '18');
        rect.setAttribute('rx', '2');
        rect.setAttribute('ry', '2');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '8.5');
        circle.setAttribute('cy', '8.5');
        circle.setAttribute('r', '1.5');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path.setAttribute('points', '21 15 16 10 5 21');
        return [rect, circle, path];
      },
      plus: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path1.setAttribute('x1', '12');
        path1.setAttribute('y1', '5');
        path1.setAttribute('x2', '12');
        path1.setAttribute('y2', '19');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path2.setAttribute('x1', '5');
        path2.setAttribute('y1', '12');
        path2.setAttribute('x2', '19');
        path2.setAttribute('y2', '12');
        return [path1, path2];
      },
      x: () => {
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path1.setAttribute('x1', '18');
        path1.setAttribute('y1', '6');
        path1.setAttribute('x2', '6');
        path1.setAttribute('y2', '18');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path2.setAttribute('x1', '6');
        path2.setAttribute('y1', '6');
        path2.setAttribute('x2', '18');
        path2.setAttribute('y2', '18');
        return [path1, path2];
      }
    };

    const elements = icons[name] ? icons[name]() : [];
    elements.forEach(el => svg.appendChild(el));
    return svg;
  }

  /**
   * Initialize the prompt library
   * Call this after DOM is ready
   */
  async init() {
    // Get DOM elements
    this.panel = document.getElementById('prompt-panel');
    this.promptsContainer = document.getElementById('prompt-cards-container');
    this.toggleBtn = document.getElementById('prompt-toggle-btn');
    this.resizeDivider = document.getElementById('resize-divider');
    this.terminalContainer = document.getElementById('terminal-container');
    this.searchInput = document.getElementById('prompt-search-input');

    if (!this.panel || !this.promptsContainer || !this.toggleBtn) {
      console.error('Prompt library DOM elements not found');
      return;
    }

    // Set up event listeners
    this.setupEventListeners();

    // Load initial state
    await this.loadPanelState();
    await this.loadPrompts();

    // Listen for prompt updates from other terminals
    if (window.electronAPI?.promptLibrary?.onPromptsUpdated) {
      window.electronAPI.promptLibrary.onPromptsUpdated((data) => {
        this.prompts = data.prompts || [];
        this.renderPrompts();
      });
    }
  }

  /**
   * Set up all event listeners
   */
  setupEventListeners() {
    // Toggle button
    this.toggleBtn.addEventListener('click', () => this.togglePanel());

    // Add prompt button
    const addBtn = this.panel.querySelector('.add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.showCreateModal());
    }

    // Collapse button
    const collapseBtn = this.panel.querySelector('.collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => this.togglePanel());
    }

    // Search input
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderPrompts();
      });
    }

    // Resize divider
    if (this.resizeDivider) {
      this.setupResizing();
    }

    // Terminal drop zone for prompts
    this.setupTerminalDropZone();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to close inline editor or modal
      if (e.key === 'Escape') {
        if (this.isInlineEditing) {
          this.closeInlineEditor();
          e.stopPropagation();
          return;
        }
        this.closeModal();
      }
      // Cmd/Ctrl + Shift + P to toggle panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') {
        e.preventDefault();
        this.togglePanel();
      }
    });
  }

  /**
   * Set up panel resizing
   */
  setupResizing() {
    let startX, startWidth;

    const onMouseMove = (e) => {
      if (!this.isResizing) return;

      const dx = startX - e.clientX;
      const layoutWidth = document.getElementById('terminal-layout')?.offsetWidth || window.innerWidth;
      const maxWidth = Math.floor(layoutWidth * 0.5);
      const newWidth = Math.min(maxWidth, Math.max(200, startWidth + dx));
      this.panel.style.width = `${newWidth}px`;
      this.panelWidth = newWidth;
    };

    const onMouseUp = () => {
      if (!this.isResizing) return;

      this.isResizing = false;
      this.panel.style.transition = '';
      this.resizeDivider.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Save panel width
      this.savePanelState();

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    this.resizeDivider.addEventListener('mousedown', (e) => {
      if (!this.panelVisible) return;

      this.isResizing = true;
      startX = e.clientX;
      startWidth = this.panel.offsetWidth;

      this.panel.style.transition = 'none';
      this.resizeDivider.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Set up terminal as drop zone for prompts
   */
  setupTerminalDropZone() {
    if (!this.terminalContainer) return;

    this.terminalContainer.addEventListener('dragover', (e) => {
      if (!this.draggedPromptId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.terminalContainer.classList.add('drag-over');
    });

    this.terminalContainer.addEventListener('dragleave', (e) => {
      // Only remove if leaving the container entirely
      if (!this.terminalContainer.contains(e.relatedTarget)) {
        this.terminalContainer.classList.remove('drag-over');
      }
    });

    this.terminalContainer.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.terminalContainer.classList.remove('drag-over');

      if (!this.draggedPromptId) return;

      const prompt = this.prompts.find(p => p.id === this.draggedPromptId);
      if (prompt) {
        await this.insertPromptAsInput(prompt);

        // Mark as testing if not reusable and not already testing/done
        if (!prompt.reusable && !prompt.done && !prompt.testing) {
          await this.markPromptTesting(prompt.id);
        }
      }

      this.draggedPromptId = null;
    });
  }

  /**
   * Insert prompt content into terminal as input
   * Only sends the prompt field, not the title
   * Images are copied to clipboard and pasted so Claude Code recognizes them
   */
  async insertPromptAsInput(prompt) {
    // Get the prompt content (migrate from old format if needed)
    const promptContent = prompt.prompt || prompt.description || prompt.title || '';

    // Focus terminal first
    if (window.focusTerminal) {
      window.focusTerminal();
    }

    // For each image: copy to clipboard, then trigger paste
    const images = prompt.images || [];
    if (images.length > 0 && window.electronAPI?.promptLibrary?.copyImageToClipboard) {
      for (let i = 0; i < images.length; i++) {
        const img = images[i];

        // Copy image to system clipboard
        const success = await window.electronAPI.promptLibrary.copyImageToClipboard(img.id);
        if (success) {
          // Small delay to ensure clipboard is ready
          await new Promise(resolve => setTimeout(resolve, 100));

          // Trigger paste via the exposed terminal function
          if (window.triggerPaste) {
            await window.triggerPaste();
          }

          // Wait for paste to be processed before next image
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }

    // Then send the prompt text
    if (promptContent && window.electronAPI?.sendInput) {
      window.electronAPI.sendInput(promptContent);
    }
  }

  /**
   * Mark a prompt as testing
   */
  async markPromptTesting(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.markAsTesting) {
        await window.electronAPI.promptLibrary.markAsTesting(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to mark prompt testing:', err);
    }
  }

  /**
   * Mark a prompt as done (from testing or active)
   */
  async markPromptDone(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.markAsDone) {
        await window.electronAPI.promptLibrary.markAsDone(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to mark prompt done:', err);
    }
  }

  /**
   * Restore a prompt from done or testing
   */
  async restorePrompt(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.restorePrompt) {
        await window.electronAPI.promptLibrary.restorePrompt(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to restore prompt:', err);
    }
  }

  /**
   * Toggle reusable flag on a prompt
   */
  async toggleReusable(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.toggleReusable) {
        await window.electronAPI.promptLibrary.toggleReusable(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to toggle reusable:', err);
    }
  }

  /**
   * Toggle favorite flag on a prompt
   */
  async toggleFavorite(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.toggleFavorite) {
        await window.electronAPI.promptLibrary.toggleFavorite(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  }

  /**
   * Clear all done prompts
   */
  async clearDonePrompts() {
    const donePrompts = this.prompts.filter(p => p.done);
    if (donePrompts.length === 0) return;

    if (!confirm(`Clear ${donePrompts.length} completed prompt(s)?`)) {
      return;
    }

    try {
      if (window.electronAPI?.promptLibrary?.clearDonePrompts) {
        await window.electronAPI.promptLibrary.clearDonePrompts();
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to clear done prompts:', err);
    }
  }

  /**
   * Load panel state from storage
   */
  async loadPanelState() {
    try {
      if (window.electronAPI?.promptLibrary?.getPanelState) {
        const state = await window.electronAPI.promptLibrary.getPanelState();
        this.panelVisible = state?.visible || false;
        this.panelWidth = state?.width || 300;

        this.updatePanelVisibility();
      }
    } catch (err) {
      console.error('Failed to load panel state:', err);
    }
  }

  /**
   * Save panel state to storage
   */
  savePanelState() {
    try {
      if (window.electronAPI?.promptLibrary?.setPanelState) {
        window.electronAPI.promptLibrary.setPanelState({
          visible: this.panelVisible,
          width: this.panelWidth
        });
      }
    } catch (err) {
      console.error('Failed to save panel state:', err);
    }
  }

  /**
   * Load prompts from storage
   */
  async loadPrompts() {
    try {
      if (window.electronAPI?.promptLibrary?.getPrompts) {
        this.prompts = await window.electronAPI.promptLibrary.getPrompts();
      }
      // Also load label colors
      if (window.electronAPI?.promptLibrary?.getLabelColors) {
        this.labelColors = await window.electronAPI.promptLibrary.getLabelColors();
      }
      this.renderPrompts();
    } catch (err) {
      console.error('Failed to load prompts:', err);
      this.prompts = [];
      this.renderPrompts();
    }
  }

  /**
   * Toggle panel visibility
   */
  togglePanel() {
    if (this.isInlineEditing) {
      this.closeInlineEditor();
      return;
    }
    this.panelVisible = !this.panelVisible;
    this.updatePanelVisibility();
    this.savePanelState();
  }

  /**
   * Update panel visibility in DOM
   */
  updatePanelVisibility() {
    if (this.panelVisible) {
      this.panel.classList.remove('collapsed');
      this.panel.style.width = `${this.panelWidth}px`;
      this.toggleBtn.classList.add('panel-visible');
      this.toggleBtn.textContent = 'Prompts';
      if (this.resizeDivider) {
        this.resizeDivider.style.display = 'block';
      }
    } else {
      this.panel.classList.add('collapsed');
      this.toggleBtn.classList.remove('panel-visible');
      this.toggleBtn.textContent = 'Prompts';
      if (this.resizeDivider) {
        this.resizeDivider.style.display = 'none';
      }
    }
  }

  /**
   * Get display title for a prompt
   * Uses title if set, otherwise first line of prompt
   */
  getDisplayTitle(prompt) {
    if (prompt.title) {
      return prompt.title;
    }
    // Use first line of prompt content
    const content = prompt.prompt || prompt.description || '';
    const firstLine = content.split('\n')[0].trim();
    return firstLine.slice(0, 50) + (firstLine.length > 50 ? '...' : '');
  }

  /**
   * Get display description for a prompt
   * Shows prompt content if title is set, otherwise shows remaining content
   */
  getDisplayDescription(prompt) {
    const content = prompt.prompt || prompt.description || '';
    if (prompt.title) {
      // Show full prompt as description preview
      return content.slice(0, 100) + (content.length > 100 ? '...' : '');
    }
    // Show remaining content after first line
    const lines = content.split('\n');
    if (lines.length > 1) {
      const rest = lines.slice(1).join('\n').trim();
      return rest.slice(0, 100) + (rest.length > 100 ? '...' : '');
    }
    return '';
  }

  /**
   * Get all unique labels from existing prompts
   */
  getAllLabels() {
    const labelSet = new Set();
    this.prompts.forEach(prompt => {
      (prompt.labels || []).forEach(label => labelSet.add(label));
    });
    return Array.from(labelSet).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  /**
   * Get the background color for a label
   * @param {string} labelName - Label name
   * @returns {string} CSS color value
   */
  getLabelBgColor(labelName) {
    const colorIndex = this.labelColors[labelName] !== undefined ? this.labelColors[labelName] : 0;
    // Use CSS variables if available, otherwise fall back to hardcoded values
    const style = getComputedStyle(document.documentElement);
    const cssVar = style.getPropertyValue(`--color-label-colors-${colorIndex}`).trim();
    if (cssVar) return cssVar;
    // Fallback colors matching design-tokens.js
    const fallbackColors = [
      '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e', '#ef4444',
      '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
    ];
    return fallbackColors[colorIndex % fallbackColors.length];
  }

  /**
   * Get the text color for a label (for contrast)
   * @param {string} labelName - Label name
   * @returns {string} CSS color value
   */
  getLabelTextColor(labelName) {
    const colorIndex = this.labelColors[labelName] !== undefined ? this.labelColors[labelName] : 0;
    // Use CSS variables if available
    const style = getComputedStyle(document.documentElement);
    const cssVar = style.getPropertyValue(`--color-label-textColors-${colorIndex}`).trim();
    if (cssVar) return cssVar;
    // Fallback - dark text for yellow and cyan, white for others
    const fallbackTextColors = [
      '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
      '#ffffff', '#1a1a20', '#ffffff', '#ffffff', '#1a1a20', '#ffffff'
    ];
    return fallbackTextColors[colorIndex % fallbackTextColors.length];
  }

  /**
   * Filter prompts based on search query
   */
  filterPrompts(prompts) {
    if (!this.searchQuery) return prompts;

    return prompts.filter(p => {
      const title = (p.title || '').toLowerCase();
      const content = (p.prompt || p.description || '').toLowerCase();
      const labels = (p.labels || []).map(l => l.toLowerCase());
      return title.includes(this.searchQuery) ||
             content.includes(this.searchQuery) ||
             labels.some(l => l.includes(this.searchQuery));
    });
  }

  /**
   * Format elapsed time in human-readable format
   * @param {number} startTime - Timestamp when testing started
   * @returns {string} Formatted time like "2d 5h", "1h 53m", or "5m"
   */
  formatElapsedTime(startTime) {
    const elapsed = Date.now() - startTime;
    const minutes = Math.floor(elapsed / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const remainingMinutes = minutes % 60;

    if (days > 0) {
      return `${days}d ${remainingHours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${minutes}m`;
  }

  /**
   * Render all prompts using safe DOM methods
   * Section order: Reusable (Global, Project) -> Regular -> Testing -> Done
   * Favorites sort to top within each section
   */
  renderPrompts() {
    if (!this.promptsContainer) return;

    // Clear any existing timer
    if (this.testingTimerInterval) {
      clearInterval(this.testingTimerInterval);
      this.testingTimerInterval = null;
    }

    // Clear container
    this.promptsContainer.textContent = '';

    // Apply search filter
    const filteredPrompts = this.filterPrompts(this.prompts);

    // Notes are a distinct item type and get their own section — no lifecycle states.
    const isNote = (p) => p.type === 'note';
    const notes = filteredPrompts.filter(isNote);

    // Prompt-type items split by lifecycle.
    const promptItems = filteredPrompts.filter(p => !isNote(p));
    // Reusable prompts never go to testing/done - combine global and project, global first
    const reusablePrompts = promptItems.filter(p => p.reusable);
    // Non-reusable prompts can be in regular, testing, or done
    const regularPrompts = promptItems.filter(p => !p.reusable && !p.done && !p.testing);
    const testingPrompts = promptItems.filter(p => !p.reusable && p.testing && !p.done);
    const donePrompts = promptItems.filter(p => !p.reusable && p.done);

    // Sort reusable: global first, then favorites, then by order
    reusablePrompts.sort((a, b) => {
      // Global prompts first
      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;
      // Then favorites
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    });

    // Sort other groups: favorites first, then by order
    const sortWithFavoritesFirst = (a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    };

    regularPrompts.sort(sortWithFavoritesFirst);

    // Sort notes: global first, then favorites, then by order (mirrors reusable order)
    notes.sort((a, b) => {
      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    });

    // Sort testing prompts by testingStartedAt descending (newest first), favorites first
    testingPrompts.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (b.testingStartedAt || 0) - (a.testingStartedAt || 0);
    });

    // Sort done prompts by doneAt descending (newest first)
    donePrompts.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

    // Empty state
    if (filteredPrompts.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'prompt-empty-state';

      const icon = document.createElement('div');
      icon.className = 'prompt-empty-icon';
      icon.textContent = '📋';

      const text = document.createElement('div');
      text.className = 'prompt-empty-text';
      text.textContent = this.searchQuery
        ? 'No prompts match your search.'
        : 'No prompts yet. Click + to add a prompt.';

      emptyState.appendChild(icon);
      emptyState.appendChild(text);
      this.promptsContainer.appendChild(emptyState);
      return;
    }

    // 0. Render Notes section first
    if (notes.length > 0) {
      const section = this.createSection('NOTES', notes, this.notesCollapsed, (collapsed) => {
        this.notesCollapsed = collapsed;
      }, 'notes');
      this.promptsContainer.appendChild(section);
    }

    // 1. Render Reusable section (global prompts first, then project)
    if (reusablePrompts.length > 0) {
      const section = this.createSection('REUSABLE', reusablePrompts, this.reusableCollapsed, (collapsed) => {
        this.reusableCollapsed = collapsed;
      }, 'reusable');
      this.promptsContainer.appendChild(section);
    }

    // 2. Render Regular section (non-reusable, active prompts)
    if (regularPrompts.length > 0) {
      const section = this.createSection('PROMPTS', regularPrompts, this.regularCollapsed, (collapsed) => {
        this.regularCollapsed = collapsed;
      }, 'regular');
      this.promptsContainer.appendChild(section);
    }

    // 4. Render Testing section
    if (testingPrompts.length > 0) {
      const testingSection = this.createTestingSection(testingPrompts);
      this.promptsContainer.appendChild(testingSection);
    }

    // 5. Render Done section
    if (donePrompts.length > 0) {
      const doneSection = this.createDoneSection(donePrompts);
      this.promptsContainer.appendChild(doneSection);
    }

    // Set up prompt event listeners
    this.setupPromptEventListeners();

    // Set up timer to update testing elapsed times
    if (testingPrompts.length > 0) {
      this.testingTimerInterval = setInterval(() => {
        this.updateTestingTimers();
      }, 60000); // Update every minute
    }
  }

  /**
   * Update all testing timer displays
   */
  updateTestingTimers() {
    const timerElements = this.promptsContainer.querySelectorAll('.prompt-testing-timer');
    timerElements.forEach(timerEl => {
      const startTime = parseInt(timerEl.dataset.startTime, 10);
      if (startTime) {
        timerEl.textContent = this.formatElapsedTime(startTime);
      }
    });
  }

  /**
   * Create a collapsible section
   * @param {string} title - Section title
   * @param {Array} prompts - Prompts in this section
   * @param {boolean} collapsed - Initial collapsed state
   * @param {Function} onToggle - Callback when toggled
   * @param {string} sectionType - Type identifier for styling (reusable-global, reusable-project, regular)
   */
  createSection(title, prompts, collapsed, onToggle, sectionType = '') {
    const section = document.createElement('div');
    section.className = 'prompt-section' + (sectionType ? ` prompt-section-${sectionType}` : '');

    // Header
    const header = document.createElement('div');
    header.className = 'prompt-section-header';

    const toggle = document.createElement('button');
    toggle.className = 'prompt-section-toggle';
    toggle.textContent = collapsed ? '▶' : '▼';

    const titleEl = document.createElement('span');
    titleEl.className = 'prompt-section-title';
    titleEl.textContent = `${title} (${prompts.length})`;

    header.appendChild(toggle);
    header.appendChild(titleEl);

    // Cards container
    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'prompt-section-cards';
    cardsDiv.dataset.sectionType = sectionType;
    if (collapsed) {
      cardsDiv.style.display = 'none';
    }

    prompts.forEach(prompt => {
      const promptEl = this.createPromptElement(prompt);
      cardsDiv.appendChild(promptEl);
    });

    section.appendChild(header);
    section.appendChild(cardsDiv);

    // Toggle event
    header.addEventListener('click', () => {
      const newCollapsed = !collapsed;
      collapsed = newCollapsed;
      toggle.textContent = newCollapsed ? '▶' : '▼';
      cardsDiv.style.display = newCollapsed ? 'none' : 'block';
      onToggle(newCollapsed);
    });

    return section;
  }

  /**
   * Create the Testing section
   */
  createTestingSection(testingPrompts) {
    const section = document.createElement('div');
    section.className = 'prompt-testing-section';

    // Header
    const header = document.createElement('div');
    header.className = 'prompt-testing-header';

    const toggle = document.createElement('button');
    toggle.className = 'prompt-testing-toggle';
    toggle.textContent = this.testingCollapsed ? '▶' : '▼';

    const title = document.createElement('span');
    title.className = 'prompt-testing-title';
    title.textContent = `Testing (${testingPrompts.length})`;

    header.appendChild(toggle);
    header.appendChild(title);

    // Cards container
    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'prompt-testing-cards';
    if (this.testingCollapsed) {
      cardsDiv.style.display = 'none';
    }

    testingPrompts.forEach(prompt => {
      const promptEl = this.createTestingPromptElement(prompt);
      cardsDiv.appendChild(promptEl);
    });

    section.appendChild(header);
    section.appendChild(cardsDiv);

    // Toggle event
    header.addEventListener('click', () => {
      this.testingCollapsed = !this.testingCollapsed;
      toggle.textContent = this.testingCollapsed ? '▶' : '▼';
      cardsDiv.style.display = this.testingCollapsed ? 'none' : 'block';
    });

    return section;
  }

  /**
   * Create a testing prompt element with timer and Pass/Retry buttons
   */
  createTestingPromptElement(prompt) {
    const promptEl = document.createElement('div');
    promptEl.className = 'prompt-card testing';
    promptEl.dataset.promptId = prompt.id;
    promptEl.draggable = true; // Allow re-dragging to test again

    // Timer row at top
    const timerRow = document.createElement('div');
    timerRow.className = 'prompt-testing-timer-row';

    const timerIcon = document.createElement('span');
    timerIcon.className = 'prompt-testing-icon';
    timerIcon.textContent = '⏱';

    const timer = document.createElement('span');
    timer.className = 'prompt-testing-timer';
    timer.dataset.startTime = prompt.testingStartedAt || Date.now();
    timer.textContent = this.formatElapsedTime(prompt.testingStartedAt || Date.now());

    timerRow.appendChild(timerIcon);
    timerRow.appendChild(timer);
    promptEl.appendChild(timerRow);

    // Title or content preview
    if (prompt.title) {
      const title = document.createElement('div');
      title.className = 'prompt-card-title';
      title.textContent = prompt.title;
      promptEl.appendChild(title);

      const content = prompt.prompt || prompt.description || '';
      if (content) {
        const desc = document.createElement('div');
        desc.className = 'prompt-card-description';
        desc.textContent = content.slice(0, 80) + (content.length > 80 ? '...' : '');
        promptEl.appendChild(desc);
      }
    } else {
      const content = prompt.prompt || prompt.description || '';
      if (content) {
        const desc = document.createElement('div');
        desc.className = 'prompt-card-description prompt-card-description-only';
        desc.textContent = content.slice(0, 120) + (content.length > 120 ? '...' : '');
        promptEl.appendChild(desc);
      }
    }

    // Action buttons: Pass and Retry
    const actions = document.createElement('div');
    actions.className = 'prompt-card-actions prompt-testing-actions';

    const passBtn = document.createElement('button');
    passBtn.className = 'prompt-card-action pass';
    passBtn.title = 'Mark as done';
    const checkIcon = document.createElement('span');
    checkIcon.textContent = '✓';
    passBtn.appendChild(checkIcon);
    const passLabel = document.createElement('span');
    passLabel.textContent = 'Pass';
    passBtn.appendChild(passLabel);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'prompt-card-action retry';
    retryBtn.title = 'Return to active';
    const retryIcon = document.createElement('span');
    retryIcon.textContent = '↩';
    retryBtn.appendChild(retryIcon);
    const retryLabel = document.createElement('span');
    retryLabel.textContent = 'Retry';
    retryBtn.appendChild(retryLabel);

    actions.appendChild(passBtn);
    actions.appendChild(retryBtn);
    promptEl.appendChild(actions);

    return promptEl;
  }

  /**
   * Create the Done section
   */
  createDoneSection(donePrompts) {
    const section = document.createElement('div');
    section.className = 'prompt-done-section';

    // Header
    const header = document.createElement('div');
    header.className = 'prompt-done-header';

    const toggle = document.createElement('button');
    toggle.className = 'prompt-done-toggle';
    toggle.textContent = this.doneCollapsed ? '▶' : '▼';

    const title = document.createElement('span');
    title.className = 'prompt-done-title';
    title.textContent = `Done (${donePrompts.length})`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'prompt-done-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear all completed prompts';

    header.appendChild(toggle);
    header.appendChild(title);
    header.appendChild(clearBtn);

    // Cards container
    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'prompt-done-cards';
    if (this.doneCollapsed) {
      cardsDiv.style.display = 'none';
    }

    donePrompts.forEach(prompt => {
      const promptEl = this.createPromptElement(prompt, true);
      cardsDiv.appendChild(promptEl);
    });

    section.appendChild(header);
    section.appendChild(cardsDiv);

    // Event listeners
    header.addEventListener('click', (e) => {
      if (e.target === clearBtn) return;
      this.doneCollapsed = !this.doneCollapsed;
      toggle.textContent = this.doneCollapsed ? '▶' : '▼';
      cardsDiv.style.display = this.doneCollapsed ? 'none' : 'block';
    });

    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearDonePrompts();
    });

    return section;
  }

  /**
   * Create a prompt DOM element safely
   */
  createPromptElement(prompt, isDone = false) {
    const isNote = prompt.type === 'note';
    const promptEl = document.createElement('div');
    promptEl.className = 'prompt-card'
      + (isDone ? ' done' : '')
      + (prompt.reusable ? ' compact' : '')
      + (isNote ? ' note' : '');
    promptEl.dataset.promptId = prompt.id;
    promptEl.dataset.type = prompt.type || 'prompt';
    // Notes can never be dragged to the terminal.
    promptEl.draggable = !isDone && !isNote;

    // For reusable prompts, show scope icon inline with first text
    if (prompt.reusable && !isDone) {
      // Create a row with scope icon and content
      const headerRow = document.createElement('div');
      headerRow.className = 'prompt-card-header-row';

      // Scope icon
      const scopeIcon = document.createElement('span');
      scopeIcon.className = 'prompt-scope-icon ' + (prompt.scope === 'global' ? 'global' : 'project');
      scopeIcon.title = prompt.scope === 'global' ? 'Global' : 'Project';
      scopeIcon.appendChild(this.createIcon(prompt.scope === 'global' ? 'globe' : 'folder', 14));
      headerRow.appendChild(scopeIcon);

      // Title or content preview inline
      const textContent = document.createElement('div');
      textContent.className = 'prompt-card-inline-content';

      if (prompt.title) {
        const title = document.createElement('span');
        title.className = 'prompt-card-inline-title';
        title.textContent = prompt.title;
        textContent.appendChild(title);
      } else {
        const content = prompt.prompt || prompt.description || '';
        const preview = document.createElement('span');
        preview.className = 'prompt-card-inline-preview';
        preview.textContent = content.slice(0, 60) + (content.length > 60 ? '...' : '');
        textContent.appendChild(preview);
      }

      // Badges (favorite, images) inline
      if (prompt.isFavorite) {
        const favBadge = document.createElement('span');
        favBadge.className = 'prompt-badge favorite';
        favBadge.title = 'Favorite';
        favBadge.appendChild(this.createIcon('star-filled', 12));
        textContent.appendChild(favBadge);
      }

      const imageCount = (prompt.images || []).length;
      if (imageCount > 0) {
        const imgBadge = document.createElement('span');
        imgBadge.className = 'prompt-badge images';
        imgBadge.title = `${imageCount} image${imageCount > 1 ? 's' : ''} attached`;
        imgBadge.appendChild(this.createIcon('image', 12));
        const countSpan = document.createElement('span');
        countSpan.className = 'prompt-badge-count';
        countSpan.textContent = imageCount;
        imgBadge.appendChild(countSpan);
        textContent.appendChild(imgBadge);
      }

      headerRow.appendChild(textContent);
      promptEl.appendChild(headerRow);
    } else {
      // Non-reusable prompts: original layout with badges on top
      const badges = document.createElement('div');
      badges.className = 'prompt-card-badges';

      if (prompt.isFavorite && !isDone) {
        const favBadge = document.createElement('span');
        favBadge.className = 'prompt-badge favorite';
        favBadge.title = 'Favorite';
        favBadge.appendChild(this.createIcon('star-filled', 12));
        badges.appendChild(favBadge);
      }

      // Image count badge
      const imageCount = (prompt.images || []).length;
      if (imageCount > 0) {
        const imgBadge = document.createElement('span');
        imgBadge.className = 'prompt-badge images';
        imgBadge.title = `${imageCount} image${imageCount > 1 ? 's' : ''} attached`;
        imgBadge.appendChild(this.createIcon('image', 12));
        const countSpan = document.createElement('span');
        countSpan.className = 'prompt-badge-count';
        countSpan.textContent = imageCount;
        imgBadge.appendChild(countSpan);
        badges.appendChild(imgBadge);
      }

      if (badges.children.length > 0) {
        promptEl.appendChild(badges);
      }

      // If prompt has an explicit title, show title + description
      // If no title, show only description-style text (more content visible)
      if (prompt.title) {
        const title = document.createElement('div');
        title.className = 'prompt-card-title';
        title.textContent = prompt.title;
        promptEl.appendChild(title);

        // Description preview
        const content = prompt.prompt || prompt.description || '';
        if (content) {
          const desc = document.createElement('div');
          desc.className = 'prompt-card-description';
          desc.textContent = content.slice(0, 100) + (content.length > 100 ? '...' : '');
          promptEl.appendChild(desc);
        }
      } else {
        // No title - show prompt content in description style (more visible)
        const content = prompt.prompt || prompt.description || '';
        if (content) {
          const desc = document.createElement('div');
          desc.className = 'prompt-card-description prompt-card-description-only';
          desc.textContent = content.slice(0, 200) + (content.length > 200 ? '...' : '');
          promptEl.appendChild(desc);
        }
      }
    }

    // Labels
    const promptLabels = prompt.labels || [];
    if (promptLabels.length > 0 && !isDone) {
      const labelsDiv = document.createElement('div');
      labelsDiv.className = 'prompt-card-labels';
      promptLabels.forEach(label => {
        const labelTag = document.createElement('span');
        labelTag.className = 'prompt-card-label';
        labelTag.textContent = label;
        // Apply label colors
        labelTag.style.backgroundColor = this.getLabelBgColor(label);
        labelTag.style.color = this.getLabelTextColor(label);
        labelsDiv.appendChild(labelTag);
      });
      promptEl.appendChild(labelsDiv);
    }

    // Bottom action bar (visible on hover)
    const actions = document.createElement('div');
    actions.className = 'prompt-card-actions';

    if (isDone) {
      // Done prompts: restore and delete
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'prompt-card-action restore';
      restoreBtn.title = 'Restore';
      restoreBtn.appendChild(this.createIcon('restore', 14));
      const restoreLabel = document.createElement('span');
      restoreLabel.textContent = 'Restore';
      restoreBtn.appendChild(restoreLabel);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'prompt-card-action delete';
      deleteBtn.title = 'Delete';
      deleteBtn.appendChild(this.createIcon('trash', 14));
      const deleteLabel = document.createElement('span');
      deleteLabel.textContent = 'Delete';
      deleteBtn.appendChild(deleteLabel);

      actions.appendChild(restoreBtn);
      actions.appendChild(deleteBtn);
    } else {
      // Active prompts: favorite, duplicate, delete
      const favoriteBtn = document.createElement('button');
      favoriteBtn.className = 'prompt-card-action favorite-toggle' + (prompt.isFavorite ? ' active' : '');
      favoriteBtn.title = prompt.isFavorite ? 'Unfavorite' : 'Favorite';
      favoriteBtn.appendChild(this.createIcon(prompt.isFavorite ? 'star-filled' : 'star', 14));
      const favLabel = document.createElement('span');
      favLabel.textContent = prompt.isFavorite ? 'Unfav' : 'Favorite';
      favoriteBtn.appendChild(favLabel);

      const duplicateBtn = document.createElement('button');
      duplicateBtn.className = 'prompt-card-action duplicate';
      duplicateBtn.title = 'Duplicate';
      duplicateBtn.appendChild(this.createIcon('copy', 14));
      const dupLabel = document.createElement('span');
      dupLabel.textContent = 'Copy';
      duplicateBtn.appendChild(dupLabel);

      // Convert between Prompt and Note
      const convertBtn = document.createElement('button');
      convertBtn.className = 'prompt-card-action convert';
      convertBtn.title = isNote ? 'Convert to Prompt' : 'Convert to Note';
      const convertLabel = document.createElement('span');
      convertLabel.textContent = isNote ? '→ Prompt' : '→ Note';
      convertBtn.appendChild(convertLabel);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'prompt-card-action delete';
      deleteBtn.title = 'Delete';
      deleteBtn.appendChild(this.createIcon('trash', 14));
      const delLabel = document.createElement('span');
      delLabel.textContent = 'Delete';
      deleteBtn.appendChild(delLabel);

      actions.appendChild(favoriteBtn);
      actions.appendChild(duplicateBtn);
      actions.appendChild(convertBtn);
      actions.appendChild(deleteBtn);
    }

    promptEl.appendChild(actions);

    return promptEl;
  }

  /**
   * Set up event listeners for prompts
   */
  setupPromptEventListeners() {
    const prompts = this.promptsContainer.querySelectorAll('.prompt-card');

    prompts.forEach(promptEl => {
      const promptId = promptEl.dataset.promptId;
      const isDone = promptEl.classList.contains('done');
      const isTesting = promptEl.classList.contains('testing');

      if (isDone) {
        // Done prompt listeners
        const restoreBtn = promptEl.querySelector('.restore');
        if (restoreBtn) {
          restoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.restorePrompt(promptId);
          });
        }

        const deleteBtn = promptEl.querySelector('.delete');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deletePrompt(promptId);
          });
        }
        return;
      }

      if (isTesting) {
        // Testing prompt listeners
        const passBtn = promptEl.querySelector('.pass');
        if (passBtn) {
          passBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.markPromptDone(promptId);
          });
        }

        const retryBtn = promptEl.querySelector('.retry');
        if (retryBtn) {
          retryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.restorePrompt(promptId);
          });
        }

        // Click on card to edit
        promptEl.addEventListener('click', (e) => {
          if (e.target.closest('.prompt-card-actions')) return;
          if (e.target.closest('.prompt-testing-timer-row')) return;
          this.showEditModal(promptId);
        });

        // Drag events for testing prompts (to re-test)
        promptEl.addEventListener('dragstart', (e) => {
          this.draggedPromptId = promptId;
          promptEl.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData('text/plain', promptId);
        });

        promptEl.addEventListener('dragend', () => {
          promptEl.classList.remove('dragging');
          this.draggedPromptId = null;
          this.terminalContainer?.classList.remove('drag-over');
        });

        return;
      }

      // Active prompt listeners
      const favoriteBtn = promptEl.querySelector('.favorite-toggle');
      if (favoriteBtn) {
        favoriteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFavorite(promptId);
        });
      }

      const duplicateBtn = promptEl.querySelector('.duplicate');
      if (duplicateBtn) {
        duplicateBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.duplicatePrompt(promptId);
        });
      }

      const convertBtn = promptEl.querySelector('.convert');
      if (convertBtn) {
        convertBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.convertPromptType(promptId);
        });
      }

      const deleteBtn = promptEl.querySelector('.delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deletePrompt(promptId);
        });
      }

      // Click anywhere on card to edit
      promptEl.addEventListener('click', (e) => {
        // Don't trigger if clicking on action buttons
        if (e.target.closest('.prompt-card-actions')) return;
        this.showEditModal(promptId);
      });

      // Drag events for reordering and terminal drop
      promptEl.addEventListener('dragstart', (e) => {
        this.draggedPromptId = promptId;
        promptEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', promptId);
      });

      promptEl.addEventListener('dragend', () => {
        promptEl.classList.remove('dragging');
        this.draggedPromptId = null;
        this.terminalContainer?.classList.remove('drag-over');

        // Remove all drag-over indicators
        prompts.forEach(p => {
          p.classList.remove('drag-over-top', 'drag-over-bottom');
        });
      });

      // Drag over for reordering
      promptEl.addEventListener('dragover', (e) => {
        if (!this.draggedPromptId || this.draggedPromptId === promptId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const rect = promptEl.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        // Clear previous indicators
        prompts.forEach(p => {
          p.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        if (e.clientY < midY) {
          promptEl.classList.add('drag-over-top');
        } else {
          promptEl.classList.add('drag-over-bottom');
        }
      });

      promptEl.addEventListener('dragleave', () => {
        promptEl.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      promptEl.addEventListener('drop', (e) => {
        e.preventDefault();
        promptEl.classList.remove('drag-over-top', 'drag-over-bottom');

        if (!this.draggedPromptId || this.draggedPromptId === promptId) return;

        const rect = promptEl.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midY;

        this.reorderPrompt(this.draggedPromptId, promptId, insertBefore);
      });
    });
  }

  /**
   * Show create prompt modal (now uses inline editor)
   */
  showCreateModal() {
    this.editingPromptId = null;
    this.showInlineEditor('New Item', '', '', [], [], false, false, 'project', 'prompt');
  }

  /**
   * Show edit prompt modal (now uses inline editor)
   */
  showEditModal(promptId) {
    const prompt = this.prompts.find(p => p.id === promptId);
    if (!prompt) return;

    this.editingPromptId = promptId;
    const promptContent = prompt.prompt || prompt.description || '';
    const type = prompt.type === 'note' ? 'note' : 'prompt';
    this.showInlineEditor(
      type === 'note' ? 'Edit Note' : 'Edit Prompt',
      promptContent,
      prompt.title || '',
      prompt.labels || [],
      prompt.images || [],
      prompt.reusable || false,
      prompt.isFavorite || false,
      prompt.scope || 'project',
      type
    );
  }

  /**
   * Build the labels form group with autocomplete
   * @returns {{ element: HTMLElement, getCurrentLabels: () => string[] }}
   */
  buildLabelsFormGroup(initialLabels) {
    let currentLabels = [...(initialLabels || [])];

    const labelsGroup = document.createElement('div');
    labelsGroup.className = 'prompt-form-group';

    const labelsLabel = document.createElement('label');
    labelsLabel.className = 'prompt-form-label';
    labelsLabel.textContent = 'Labels';

    const labelsContainer = document.createElement('div');
    labelsContainer.className = 'prompt-labels-container';

    const labelsTagsDiv = document.createElement('div');
    labelsTagsDiv.className = 'prompt-labels-tags';

    const labelsInputWrapper = document.createElement('div');
    labelsInputWrapper.className = 'prompt-labels-input-wrapper';

    const labelsInput = document.createElement('input');
    labelsInput.type = 'text';
    labelsInput.className = 'prompt-labels-input';
    labelsInput.placeholder = 'Type label and press Enter...';
    labelsInput.maxLength = 30;

    const suggestionsDropdown = document.createElement('div');
    suggestionsDropdown.className = 'prompt-labels-suggestions';

    let highlightedIndex = -1;

    const renderLabelTags = () => {
      labelsTagsDiv.textContent = '';
      currentLabels.forEach((label, index) => {
        const tag = document.createElement('span');
        tag.className = 'prompt-label-tag';
        tag.textContent = label;
        tag.style.backgroundColor = this.getLabelBgColor(label);
        tag.style.color = this.getLabelTextColor(label);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'prompt-label-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.style.color = this.getLabelTextColor(label);
        removeBtn.addEventListener('click', () => {
          currentLabels.splice(index, 1);
          renderLabelTags();
        });

        tag.appendChild(removeBtn);
        labelsTagsDiv.appendChild(tag);
      });
    };

    const getFilteredSuggestions = (query) => {
      const allLabels = this.getAllLabels();
      const q = query.toLowerCase();
      return allLabels.filter(label =>
        label.toLowerCase().includes(q) && !currentLabels.includes(label)
      );
    };

    const renderSuggestions = (suggestions) => {
      suggestionsDropdown.textContent = '';
      highlightedIndex = -1;
      if (suggestions.length === 0) {
        suggestionsDropdown.classList.remove('visible');
        return;
      }
      suggestions.forEach((label, index) => {
        const item = document.createElement('div');
        item.className = 'prompt-labels-suggestion';
        item.dataset.index = index;
        const query = labelsInput.value.trim().toLowerCase();
        const labelLower = label.toLowerCase();
        const matchStart = labelLower.indexOf(query);
        if (matchStart >= 0 && query) {
          const before = label.slice(0, matchStart);
          const match = label.slice(matchStart, matchStart + query.length);
          const after = label.slice(matchStart + query.length);
          if (before) item.appendChild(document.createTextNode(before));
          const matchSpan = document.createElement('span');
          matchSpan.className = 'match';
          matchSpan.textContent = match;
          item.appendChild(matchSpan);
          if (after) item.appendChild(document.createTextNode(after));
        } else {
          item.textContent = label;
        }
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          addLabel(label);
        });
        suggestionsDropdown.appendChild(item);
      });
      suggestionsDropdown.classList.add('visible');
    };

    const updateHighlight = () => {
      const items = suggestionsDropdown.querySelectorAll('.prompt-labels-suggestion');
      items.forEach((item, index) => {
        item.classList.toggle('highlighted', index === highlightedIndex);
      });
      if (highlightedIndex >= 0 && items[highlightedIndex]) {
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
      }
    };

    const addLabel = (label) => {
      if (label && !currentLabels.includes(label) && currentLabels.length < 5) {
        currentLabels.push(label);
        labelsInput.value = '';
        suggestionsDropdown.classList.remove('visible');
        renderLabelTags();
      }
    };

    labelsInput.addEventListener('input', () => {
      const query = labelsInput.value.trim();
      if (query) {
        renderSuggestions(getFilteredSuggestions(query));
      } else {
        suggestionsDropdown.classList.remove('visible');
      }
    });

    labelsInput.addEventListener('keydown', (e) => {
      const suggestions = getFilteredSuggestions(labelsInput.value.trim());
      const isDropdownVisible = suggestionsDropdown.classList.contains('visible');
      if (e.key === 'ArrowDown' && isDropdownVisible) {
        e.preventDefault();
        highlightedIndex = Math.min(highlightedIndex + 1, suggestions.length - 1);
        updateHighlight();
      } else if (e.key === 'ArrowUp' && isDropdownVisible) {
        e.preventDefault();
        highlightedIndex = Math.max(highlightedIndex - 1, 0);
        updateHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isDropdownVisible && highlightedIndex >= 0 && suggestions[highlightedIndex]) {
          addLabel(suggestions[highlightedIndex]);
        } else {
          addLabel(labelsInput.value.trim());
        }
      } else if (e.key === 'Escape') {
        suggestionsDropdown.classList.remove('visible');
      }
    });

    labelsInput.addEventListener('blur', () => {
      setTimeout(() => suggestionsDropdown.classList.remove('visible'), 150);
    });

    labelsInput.addEventListener('focus', () => {
      const query = labelsInput.value.trim();
      if (query) {
        renderSuggestions(getFilteredSuggestions(query));
      }
    });

    labelsInputWrapper.appendChild(labelsInput);
    labelsInputWrapper.appendChild(suggestionsDropdown);
    labelsContainer.appendChild(labelsTagsDiv);
    labelsContainer.appendChild(labelsInputWrapper);
    labelsGroup.appendChild(labelsLabel);
    labelsGroup.appendChild(labelsContainer);
    renderLabelTags();

    return { element: labelsGroup, getCurrentLabels: () => [...currentLabels] };
  }

  /**
   * Build the images form group with thumbnails, drag-drop, paste
   * @param {HTMLElement} pasteTarget - Element to attach paste listener to
   * @returns {{ element: HTMLElement, getCurrentImages: () => Array }}
   */
  buildImagesFormGroup(initialImages, pasteTarget) {
    let currentImages = [...(initialImages || [])];

    const imagesGroup = document.createElement('div');
    imagesGroup.className = 'prompt-form-group';

    const imagesLabelRow = document.createElement('div');
    imagesLabelRow.className = 'prompt-images-label-row';

    const imagesLabel = document.createElement('label');
    imagesLabel.className = 'prompt-form-label';
    imagesLabel.textContent = 'Images';

    const addImageBtn = document.createElement('button');
    addImageBtn.type = 'button';
    addImageBtn.className = 'prompt-add-image-btn';
    addImageBtn.title = 'Add images';
    addImageBtn.appendChild(this.createIcon('plus', 14));
    const addImageText = document.createElement('span');
    addImageText.textContent = 'Add';
    addImageBtn.appendChild(addImageText);

    imagesLabelRow.appendChild(imagesLabel);
    imagesLabelRow.appendChild(addImageBtn);

    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'prompt-images-container';

    const imagesThumbnails = document.createElement('div');
    imagesThumbnails.className = 'prompt-images-thumbnails';

    const imagesDropZone = document.createElement('div');
    imagesDropZone.className = 'prompt-images-drop-zone';
    imagesDropZone.textContent = 'Drop images here, paste, or click Add';

    const renderImageThumbnails = async () => {
      imagesThumbnails.textContent = '';
      if (currentImages.length === 0) {
        imagesDropZone.style.display = 'block';
        imagesThumbnails.style.display = 'none';
        return;
      }
      imagesDropZone.style.display = 'none';
      imagesThumbnails.style.display = 'flex';
      for (const img of currentImages) {
        const thumb = document.createElement('div');
        thumb.className = 'prompt-image-thumb';
        const imgEl = document.createElement('img');
        let thumbnailLoaded = false;
        if (window.electronAPI?.promptLibrary?.getImageThumbnail) {
          try {
            const dataUrl = await window.electronAPI.promptLibrary.getImageThumbnail(img.id);
            if (dataUrl) { imgEl.src = dataUrl; thumbnailLoaded = true; }
          } catch (err) { console.error('Failed to load thumbnail:', err); }
        }
        if (!thumbnailLoaded) thumb.classList.add('thumbnail-error');
        imgEl.alt = img.filename || 'Image';
        imgEl.title = img.filename || 'Image';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'prompt-image-remove';
        removeBtn.title = 'Remove image';
        removeBtn.appendChild(this.createIcon('x', 12));
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const idx = currentImages.findIndex(i => i.id === img.id);
          if (idx !== -1) { currentImages.splice(idx, 1); await renderImageThumbnails(); }
        });
        thumb.appendChild(imgEl);
        thumb.appendChild(removeBtn);
        imagesThumbnails.appendChild(thumb);
      }
    };

    const addImageFromPath = async (filePath) => {
      if (currentImages.length >= 10) { alert('Maximum of 10 images per prompt'); return; }
      if (window.electronAPI?.promptLibrary?.addImage) {
        const result = await window.electronAPI.promptLibrary.addImage(filePath);
        if (result.success && result.image) { currentImages.push(result.image); await renderImageThumbnails(); }
        else if (result.error) { alert('Failed to add image: ' + result.error); }
      }
    };

    const addImageFromDataUrl = async (dataUrl) => {
      if (currentImages.length >= 10) { alert('Maximum of 10 images per prompt'); return; }
      if (window.electronAPI?.promptLibrary?.addImageFromDataUrl) {
        const result = await window.electronAPI.promptLibrary.addImageFromDataUrl(dataUrl);
        if (result.success && result.image) { currentImages.push(result.image); await renderImageThumbnails(); }
        else if (result.error) { alert('Failed to add image: ' + result.error); }
      }
    };

    addImageBtn.addEventListener('click', async () => {
      if (window.electronAPI?.promptLibrary?.pickImageFiles) {
        const result = await window.electronAPI.promptLibrary.pickImageFiles();
        if (!result.canceled && result.filePaths) {
          for (const filePath of result.filePaths) { await addImageFromPath(filePath); }
        }
      }
    });

    imagesContainer.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); imagesContainer.classList.add('drag-over'); });
    imagesContainer.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); imagesContainer.classList.remove('drag-over'); });
    imagesContainer.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); imagesContainer.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      for (const file of files) { if (file.type.startsWith('image/')) { await addImageFromPath(file.path); } }
    });

    if (pasteTarget) {
      pasteTarget.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onload = async () => { await addImageFromDataUrl(reader.result); };
              reader.readAsDataURL(blob);
            }
            break;
          }
        }
      });
    }

    imagesContainer.appendChild(imagesThumbnails);
    imagesContainer.appendChild(imagesDropZone);
    imagesGroup.appendChild(imagesLabelRow);
    imagesGroup.appendChild(imagesContainer);
    renderImageThumbnails();

    return { element: imagesGroup, getCurrentImages: () => [...currentImages] };
  }

  /**
   * Build the options row (reusable, favorite, scope)
   * The reusable row is hidden for notes (they can't be reusable).
   * @returns {{ element: HTMLElement, getValues: () => { reusable: boolean, favorite: boolean, scope: string }, setType: (type: string) => void }}
   */
  buildOptionsRow(isReusable, isFavorite, scope, initialType = 'prompt') {
    let currentType = initialType === 'note' ? 'note' : 'prompt';
    const optionsRow = document.createElement('div');
    optionsRow.className = 'prompt-form-options';

    const reusableGroup = document.createElement('div');
    reusableGroup.className = 'prompt-form-checkbox';
    const reusableInput = document.createElement('input');
    reusableInput.type = 'checkbox';
    reusableInput.id = 'prompt-reusable-input';
    reusableInput.checked = isReusable;
    const reusableLabel = document.createElement('label');
    reusableLabel.htmlFor = 'prompt-reusable-input';
    reusableLabel.textContent = 'Reusable';
    reusableGroup.appendChild(reusableInput);
    reusableGroup.appendChild(reusableLabel);

    const favoriteGroup = document.createElement('div');
    favoriteGroup.className = 'prompt-form-checkbox';
    const favoriteInput = document.createElement('input');
    favoriteInput.type = 'checkbox';
    favoriteInput.id = 'prompt-favorite-input';
    favoriteInput.checked = isFavorite;
    const favoriteLabel = document.createElement('label');
    favoriteLabel.htmlFor = 'prompt-favorite-input';
    favoriteLabel.textContent = 'Favorite';
    favoriteGroup.appendChild(favoriteInput);
    favoriteGroup.appendChild(favoriteLabel);

    const scopeGroup = document.createElement('div');
    scopeGroup.className = 'prompt-form-scope-group';
    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'prompt-form-scope-label';
    scopeLabel.htmlFor = 'prompt-scope-select';
    scopeLabel.textContent = 'Scope:';
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'prompt-form-input prompt-form-select prompt-scope-select';
    scopeSelect.id = 'prompt-scope-select';
    const projectOption = document.createElement('option');
    projectOption.value = 'project';
    projectOption.textContent = 'Project';
    if (scope === 'project') projectOption.selected = true;
    const globalOption = document.createElement('option');
    globalOption.value = 'global';
    globalOption.textContent = 'Global';
    if (scope === 'global') globalOption.selected = true;
    scopeSelect.appendChild(projectOption);
    scopeSelect.appendChild(globalOption);

    const updateReusableForScope = () => {
      // Notes can never be reusable — hide the row entirely.
      if (currentType === 'note') {
        reusableGroup.style.display = 'none';
        reusableInput.checked = false;
        return;
      }
      reusableGroup.style.display = '';
      if (scopeSelect.value === 'global') {
        reusableInput.checked = true;
        reusableInput.disabled = true;
        reusableGroup.classList.add('disabled');
        reusableGroup.title = 'Global prompts are always reusable';
      } else {
        reusableInput.disabled = false;
        reusableGroup.classList.remove('disabled');
        reusableGroup.title = '';
      }
    };
    scopeSelect.addEventListener('change', updateReusableForScope);
    updateReusableForScope();

    scopeGroup.appendChild(scopeLabel);
    scopeGroup.appendChild(scopeSelect);
    optionsRow.appendChild(reusableGroup);
    optionsRow.appendChild(favoriteGroup);
    optionsRow.appendChild(scopeGroup);

    return {
      element: optionsRow,
      getValues: () => ({
        // Notes can never be reusable regardless of checkbox state.
        reusable: currentType === 'note' ? false : reusableInput.checked,
        favorite: favoriteInput.checked,
        scope: scopeSelect.value
      }),
      setType: (type) => {
        currentType = type === 'note' ? 'note' : 'prompt';
        updateReusableForScope();
      }
    };
  }

  /**
   * Build the type selector (Prompt / Note toggle at the top of the editor).
   * @returns {{ element: HTMLElement, getType: () => string, onChange: (cb: (type: string) => void) => void }}
   */
  buildTypeSelector(initialType = 'prompt') {
    let currentType = initialType === 'note' ? 'note' : 'prompt';
    const listeners = [];

    const wrapper = document.createElement('div');
    wrapper.className = 'prompt-form-type-selector';

    const makeBtn = (value, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prompt-form-type-btn' + (currentType === value ? ' active' : '');
      btn.dataset.typeValue = value;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (currentType === value) return;
        currentType = value;
        wrapper.querySelectorAll('.prompt-form-type-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.typeValue === value);
        });
        listeners.forEach(fn => { try { fn(currentType); } catch {} });
      });
      return btn;
    };

    wrapper.appendChild(makeBtn('prompt', 'Prompt'));
    wrapper.appendChild(makeBtn('note', 'Note'));

    return {
      element: wrapper,
      getType: () => currentType,
      onChange: (cb) => { if (typeof cb === 'function') listeners.push(cb); }
    };
  }

  /**
   * Show inline editor inside the prompt panel
   */
  showInlineEditor(editorTitle, promptContent, promptTitle, labels, images, isReusable, isFavorite, scope, type = 'prompt') {
    // Close any existing inline editor first
    const existingEditor = this.panel.querySelector('.prompt-inline-editor');
    if (existingEditor) existingEditor.remove();

    this.isInlineEditing = true;
    this.preEditPanelWidth = this.panelWidth;

    // Auto-open panel if collapsed
    if (!this.panelVisible) {
      this.panelVisible = true;
      this.updatePanelVisibility();
      this.savePanelState();
    }

    // Widen panel for editing, capped at 50% of layout
    const layoutWidth = document.getElementById('terminal-layout')?.offsetWidth || window.innerWidth;
    const maxWidth = Math.floor(layoutWidth * 0.5);
    const editWidth = Math.min(maxWidth, Math.max(this.panelWidth, 450));
    this.panel.style.width = `${editWidth}px`;
    this.panelWidth = editWidth;
    this.panel.classList.add('editing');

    // Hide normal panel content
    const searchContainer = document.getElementById('prompt-search-container');
    const cardsContainer = document.getElementById('prompt-cards-container');
    const panelHeader = document.getElementById('prompt-panel-header');
    if (searchContainer) searchContainer.style.display = 'none';
    if (cardsContainer) cardsContainer.style.display = 'none';
    if (panelHeader) panelHeader.style.display = 'none';

    // Create inline editor
    const editor = document.createElement('div');
    editor.className = 'prompt-inline-editor';

    // Header with back button
    const header = document.createElement('div');
    header.className = 'inline-editor-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'inline-editor-back';
    backBtn.title = 'Back to prompts';
    // Left arrow icon
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('width', '16');
    arrowSvg.setAttribute('height', '16');
    arrowSvg.setAttribute('viewBox', '0 0 24 24');
    arrowSvg.setAttribute('fill', 'none');
    arrowSvg.setAttribute('stroke', 'currentColor');
    arrowSvg.setAttribute('stroke-width', '2');
    arrowSvg.setAttribute('stroke-linecap', 'round');
    arrowSvg.setAttribute('stroke-linejoin', 'round');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    arrowPath.setAttribute('points', '15 18 9 12 15 6');
    arrowSvg.appendChild(arrowPath);
    backBtn.appendChild(arrowSvg);

    const titleEl = document.createElement('span');
    titleEl.className = 'inline-editor-title';
    titleEl.textContent = editorTitle;

    header.appendChild(backBtn);
    header.appendChild(titleEl);

    // Scrollable body
    const body = document.createElement('div');
    body.className = 'inline-editor-body';

    // Title input
    const titleGroup = document.createElement('div');
    titleGroup.className = 'prompt-form-group';
    const titleLabel = document.createElement('label');
    titleLabel.className = 'prompt-form-label';
    titleLabel.textContent = 'Title (optional)';
    const titleHint = document.createElement('span');
    titleHint.className = 'prompt-form-hint';
    titleHint.textContent = 'Display name only';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'prompt-form-input';
    titleInput.placeholder = 'Display name...';
    titleInput.maxLength = 100;
    titleInput.value = promptTitle;
    titleGroup.appendChild(titleLabel);
    titleGroup.appendChild(titleHint);
    titleGroup.appendChild(titleInput);

    // Prompt textarea
    const promptGroup = document.createElement('div');
    promptGroup.className = 'prompt-form-group';
    promptGroup.style.flex = '1';
    promptGroup.style.display = 'flex';
    promptGroup.style.flexDirection = 'column';
    const promptLabel = document.createElement('label');
    promptLabel.className = 'prompt-form-label';
    promptLabel.textContent = 'Prompt';
    const promptInput = document.createElement('textarea');
    promptInput.className = 'prompt-form-input prompt-form-textarea';
    promptInput.placeholder = 'Enter the prompt to send to Claude...';
    promptInput.maxLength = 20000;
    promptInput.value = promptContent;
    promptGroup.appendChild(promptLabel);
    promptGroup.appendChild(promptInput);

    // Type selector (Prompt / Note)
    const typeHelper = this.buildTypeSelector(type);

    // Build helpers (labels, images, options)
    const labelsHelper = this.buildLabelsFormGroup(labels);
    const imagesHelper = this.buildImagesFormGroup(images, editor);
    const optionsHelper = this.buildOptionsRow(isReusable, isFavorite, scope, typeHelper.getType());

    body.appendChild(typeHelper.element);
    body.appendChild(titleGroup);
    body.appendChild(promptGroup);
    body.appendChild(labelsHelper.element);
    body.appendChild(imagesHelper.element);
    body.appendChild(optionsHelper.element);

    // When the user switches type, update the header/prompt label + options visibility.
    const applyTypeChange = (t) => {
      const isNote = t === 'note';
      if (editorTitle === 'New Item' || editorTitle === 'Edit Prompt' || editorTitle === 'Edit Note') {
        titleEl.textContent = this.editingPromptId
          ? (isNote ? 'Edit Note' : 'Edit Prompt')
          : (isNote ? 'New Note' : 'New Prompt');
      }
      promptLabel.textContent = isNote ? 'Content' : 'Prompt';
      promptInput.placeholder = isNote
        ? 'Note content — saved commands, snippets, reference...'
        : 'Enter the prompt to send to Claude...';
      optionsHelper.setType(t);
    };
    typeHelper.onChange(applyTypeChange);
    applyTypeChange(typeHelper.getType());

    // Footer with save/cancel
    const footer = document.createElement('div');
    footer.className = 'inline-editor-footer';

    // Left group: Save & Send
    const footerLeft = document.createElement('div');
    footerLeft.className = 'inline-editor-footer-left';

    const saveAndSendBtn = document.createElement('button');
    saveAndSendBtn.className = 'prompt-modal-btn save-and-send';
    saveAndSendBtn.title = 'Save prompt, send to terminal, and move to Testing';

    const saveAndSendIcon = document.createElement('span');
    saveAndSendIcon.className = 'save-and-send-icon';
    saveAndSendIcon.textContent = '←';
    const saveAndSendLabel = document.createElement('span');
    saveAndSendLabel.textContent = 'Save & Send';
    saveAndSendBtn.appendChild(saveAndSendIcon);
    saveAndSendBtn.appendChild(saveAndSendLabel);

    footerLeft.appendChild(saveAndSendBtn);

    // Right group: Cancel + Save
    const footerRight = document.createElement('div');
    footerRight.className = 'inline-editor-footer-right';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-modal-btn cancel';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'prompt-modal-btn primary';
    saveBtn.textContent = 'Save';

    footerRight.appendChild(cancelBtn);
    footerRight.appendChild(saveBtn);

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);

    // Assemble editor
    editor.appendChild(header);
    editor.appendChild(body);
    editor.appendChild(footer);

    // Insert into panel
    this.panel.appendChild(editor);

    // Focus textarea
    promptInput.focus();

    // Wire up events
    backBtn.addEventListener('click', () => this.closeInlineEditor());
    cancelBtn.addEventListener('click', () => this.closeInlineEditor());

    const doSave = async () => {
      const newPromptContent = promptInput.value.trim();
      const newTitle = titleInput.value.trim() || null;
      const newLabels = labelsHelper.getCurrentLabels();
      const newImages = imagesHelper.getCurrentImages();
      const opts = optionsHelper.getValues();
      const newType = typeHelper.getType();

      if (!newPromptContent) {
        promptInput.focus();
        return;
      }

      await this.savePrompt(newPromptContent, newTitle, newLabels, newImages, opts.reusable, opts.favorite, opts.scope, newType);
    };

    saveBtn.addEventListener('click', doSave);

    // Save & Send: save, then send to terminal and mark as testing
    const doSaveAndSend = async () => {
      const newPromptContent = promptInput.value.trim();
      const newTitle = titleInput.value.trim() || null;
      const newLabels = labelsHelper.getCurrentLabels();
      const newImages = imagesHelper.getCurrentImages();
      const opts = optionsHelper.getValues();
      const newType = typeHelper.getType();

      if (!newPromptContent) {
        promptInput.focus();
        return;
      }
      // Notes never get sent to the terminal; treat this as a plain save.
      if (newType === 'note') {
        await this.savePrompt(newPromptContent, newTitle, newLabels, newImages, opts.reusable, opts.favorite, opts.scope, newType);
        return;
      }

      try {
        let savedPrompt;
        if (this.editingPromptId) {
          await window.electronAPI.promptLibrary.updatePrompt(this.editingPromptId, {
            prompt: newPromptContent,
            title: newTitle,
            labels: newLabels,
            images: newImages,
            reusable: opts.reusable,
            isFavorite: opts.favorite,
            scope: opts.scope,
            type: newType
          });
          savedPrompt = { id: this.editingPromptId, prompt: newPromptContent, title: newTitle, images: newImages, reusable: opts.reusable };
        } else {
          savedPrompt = await window.electronAPI.promptLibrary.createPrompt({
            prompt: newPromptContent,
            title: newTitle,
            labels: newLabels,
            images: newImages,
            reusable: opts.reusable,
            isFavorite: opts.favorite,
            scope: opts.scope,
            type: newType
          });
        }

        this.closeModal();

        if (savedPrompt) {
          // Send to terminal
          await this.insertPromptAsInput(savedPrompt);

          // Mark as testing (unless reusable)
          if (!savedPrompt.reusable) {
            await this.markPromptTesting(savedPrompt.id);
          } else {
            await this.loadPrompts();
          }
        } else {
          await this.loadPrompts();
        }
      } catch (err) {
        console.error('Failed to save & send prompt:', err);
        alert('Failed to save & send prompt: ' + err.message);
      }
    };

    saveAndSendBtn.addEventListener('click', doSaveAndSend);

    // Cmd+Enter to save
    promptInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        doSave();
      }
    });

    // Update save button state
    const updateSaveBtn = () => {
      const hasContent = !!promptInput.value.trim();
      const isNoteType = typeHelper.getType() === 'note';
      saveBtn.disabled = !hasContent;
      // Notes can't be sent to the terminal — hide Save & Send for them.
      saveAndSendBtn.style.display = isNoteType ? 'none' : '';
      saveAndSendBtn.disabled = !hasContent || isNoteType;
    };
    promptInput.addEventListener('input', updateSaveBtn);
    typeHelper.onChange(updateSaveBtn);
    updateSaveBtn();
  }

  /**
   * Close the inline editor and restore panel
   */
  closeInlineEditor() {
    const editor = this.panel.querySelector('.prompt-inline-editor');
    if (editor) editor.remove();

    // Restore panel width
    if (this.preEditPanelWidth !== null) {
      this.panelWidth = this.preEditPanelWidth;
      this.panel.style.width = `${this.panelWidth}px`;
      this.preEditPanelWidth = null;
    }
    this.panel.classList.remove('editing');

    // Show normal panel content
    const searchContainer = document.getElementById('prompt-search-container');
    const cardsContainer = document.getElementById('prompt-cards-container');
    const panelHeader = document.getElementById('prompt-panel-header');
    if (searchContainer) searchContainer.style.display = '';
    if (cardsContainer) cardsContainer.style.display = '';
    if (panelHeader) panelHeader.style.display = '';

    this.isInlineEditing = false;
    this.editingPromptId = null;
  }

  /**
   * Show modal dialog using safe DOM methods
   */
  showModal(modalTitle, promptContent, promptTitle, labels, images, isReusable, isFavorite, scope) {
    // Remove existing modal element if any (but don't clear editingPromptId)
    const existingModal = document.querySelector('.prompt-modal-overlay');
    if (existingModal) {
      existingModal.remove();
    }

    // Track current labels and images in the modal
    let currentLabels = [...(labels || [])];
    let currentImages = [...(images || [])];

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'prompt-modal-overlay';

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'prompt-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'prompt-modal-header';

    const headerTitle = document.createElement('h3');
    headerTitle.textContent = modalTitle;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'prompt-modal-close';
    closeBtn.textContent = '×';

    header.appendChild(headerTitle);
    header.appendChild(closeBtn);

    // Body - two column layout
    const body = document.createElement('div');
    body.className = 'prompt-modal-body';

    // Left column - Prompt textarea
    const leftColumn = document.createElement('div');
    leftColumn.className = 'prompt-modal-left';

    const promptGroup = document.createElement('div');
    promptGroup.className = 'prompt-form-group';

    const promptLabel = document.createElement('label');
    promptLabel.className = 'prompt-form-label';
    promptLabel.textContent = 'Prompt';

    const promptInput = document.createElement('textarea');
    promptInput.className = 'prompt-form-input prompt-form-textarea';
    promptInput.id = 'prompt-content-input';
    promptInput.placeholder = 'Enter the prompt to send to Claude...';
    promptInput.maxLength = 20000;
    promptInput.value = promptContent;

    promptGroup.appendChild(promptLabel);
    promptGroup.appendChild(promptInput);
    leftColumn.appendChild(promptGroup);

    // Right column - Metadata sidebar
    const rightColumn = document.createElement('div');
    rightColumn.className = 'prompt-modal-right';

    // Title field (optional, for display only)
    const titleGroup = document.createElement('div');
    titleGroup.className = 'prompt-form-group';

    const titleLabel = document.createElement('label');
    titleLabel.className = 'prompt-form-label';
    titleLabel.textContent = 'Title (optional)';

    const titleHint = document.createElement('span');
    titleHint.className = 'prompt-form-hint';
    titleHint.textContent = 'Display name only';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'prompt-form-input';
    titleInput.id = 'prompt-title-input';
    titleInput.placeholder = 'Display name...';
    titleInput.maxLength = 100;
    titleInput.value = promptTitle;

    titleGroup.appendChild(titleLabel);
    titleGroup.appendChild(titleHint);
    titleGroup.appendChild(titleInput);

    // Labels input (multi-select tags) with autocomplete
    const labelsGroup = document.createElement('div');
    labelsGroup.className = 'prompt-form-group';

    const labelsLabel = document.createElement('label');
    labelsLabel.className = 'prompt-form-label';
    labelsLabel.textContent = 'Labels';

    const labelsContainer = document.createElement('div');
    labelsContainer.className = 'prompt-labels-container';

    const labelsTagsDiv = document.createElement('div');
    labelsTagsDiv.className = 'prompt-labels-tags';

    // Wrapper for input + suggestions dropdown
    const labelsInputWrapper = document.createElement('div');
    labelsInputWrapper.className = 'prompt-labels-input-wrapper';

    const labelsInput = document.createElement('input');
    labelsInput.type = 'text';
    labelsInput.className = 'prompt-labels-input';
    labelsInput.placeholder = 'Type label and press Enter...';
    labelsInput.maxLength = 30;

    // Suggestions dropdown
    const suggestionsDropdown = document.createElement('div');
    suggestionsDropdown.className = 'prompt-labels-suggestions';

    let highlightedIndex = -1;

    // Function to render label tags
    const renderLabelTags = () => {
      labelsTagsDiv.textContent = '';
      currentLabels.forEach((label, index) => {
        const tag = document.createElement('span');
        tag.className = 'prompt-label-tag';
        tag.textContent = label;
        // Apply label colors
        tag.style.backgroundColor = this.getLabelBgColor(label);
        tag.style.color = this.getLabelTextColor(label);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'prompt-label-remove';
        removeBtn.textContent = '×';
        removeBtn.style.color = this.getLabelTextColor(label); // Match text color
        removeBtn.addEventListener('click', () => {
          currentLabels.splice(index, 1);
          renderLabelTags();
        });

        tag.appendChild(removeBtn);
        labelsTagsDiv.appendChild(tag);
      });
    };

    // Get filtered suggestions based on input
    const getFilteredSuggestions = (query) => {
      const allLabels = this.getAllLabels();
      const q = query.toLowerCase();
      return allLabels.filter(label =>
        label.toLowerCase().includes(q) && !currentLabels.includes(label)
      );
    };

    // Render suggestions dropdown
    const renderSuggestions = (suggestions) => {
      suggestionsDropdown.textContent = '';
      highlightedIndex = -1;

      if (suggestions.length === 0) {
        suggestionsDropdown.classList.remove('visible');
        return;
      }

      suggestions.forEach((label, index) => {
        const item = document.createElement('div');
        item.className = 'prompt-labels-suggestion';
        item.dataset.index = index;

        // Highlight matching part
        const query = labelsInput.value.trim().toLowerCase();
        const labelLower = label.toLowerCase();
        const matchStart = labelLower.indexOf(query);

        if (matchStart >= 0 && query) {
          const before = label.slice(0, matchStart);
          const match = label.slice(matchStart, matchStart + query.length);
          const after = label.slice(matchStart + query.length);

          if (before) item.appendChild(document.createTextNode(before));
          const matchSpan = document.createElement('span');
          matchSpan.className = 'match';
          matchSpan.textContent = match;
          item.appendChild(matchSpan);
          if (after) item.appendChild(document.createTextNode(after));
        } else {
          item.textContent = label;
        }

        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // Prevent blur before click registers
          addLabel(label);
        });

        suggestionsDropdown.appendChild(item);
      });

      suggestionsDropdown.classList.add('visible');
    };

    // Update highlighted suggestion
    const updateHighlight = (suggestions) => {
      const items = suggestionsDropdown.querySelectorAll('.prompt-labels-suggestion');
      items.forEach((item, index) => {
        item.classList.toggle('highlighted', index === highlightedIndex);
      });
      // Scroll highlighted item into view
      if (highlightedIndex >= 0 && items[highlightedIndex]) {
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
      }
    };

    // Add a label and reset input
    const addLabel = (label) => {
      if (label && !currentLabels.includes(label) && currentLabels.length < 5) {
        currentLabels.push(label);
        labelsInput.value = '';
        suggestionsDropdown.classList.remove('visible');
        renderLabelTags();
      }
    };

    // Handle input for autocomplete
    labelsInput.addEventListener('input', () => {
      const query = labelsInput.value.trim();
      if (query) {
        const suggestions = getFilteredSuggestions(query);
        renderSuggestions(suggestions);
      } else {
        suggestionsDropdown.classList.remove('visible');
      }
    });

    // Handle keyboard navigation
    labelsInput.addEventListener('keydown', (e) => {
      const suggestions = getFilteredSuggestions(labelsInput.value.trim());
      const isDropdownVisible = suggestionsDropdown.classList.contains('visible');

      if (e.key === 'ArrowDown' && isDropdownVisible) {
        e.preventDefault();
        highlightedIndex = Math.min(highlightedIndex + 1, suggestions.length - 1);
        updateHighlight(suggestions);
      } else if (e.key === 'ArrowUp' && isDropdownVisible) {
        e.preventDefault();
        highlightedIndex = Math.max(highlightedIndex - 1, 0);
        updateHighlight(suggestions);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isDropdownVisible && highlightedIndex >= 0 && suggestions[highlightedIndex]) {
          addLabel(suggestions[highlightedIndex]);
        } else {
          addLabel(labelsInput.value.trim());
        }
      } else if (e.key === 'Escape') {
        suggestionsDropdown.classList.remove('visible');
      }
    });

    // Hide suggestions on blur (with delay to allow click)
    labelsInput.addEventListener('blur', () => {
      setTimeout(() => {
        suggestionsDropdown.classList.remove('visible');
      }, 150);
    });

    // Show suggestions on focus if there's input
    labelsInput.addEventListener('focus', () => {
      const query = labelsInput.value.trim();
      if (query) {
        const suggestions = getFilteredSuggestions(query);
        renderSuggestions(suggestions);
      }
    });

    labelsInputWrapper.appendChild(labelsInput);
    labelsInputWrapper.appendChild(suggestionsDropdown);

    labelsContainer.appendChild(labelsTagsDiv);
    labelsContainer.appendChild(labelsInputWrapper);

    labelsGroup.appendChild(labelsLabel);
    labelsGroup.appendChild(labelsContainer);

    // Render initial labels
    renderLabelTags();

    // Images section
    const imagesGroup = document.createElement('div');
    imagesGroup.className = 'prompt-form-group';

    const imagesLabelRow = document.createElement('div');
    imagesLabelRow.className = 'prompt-images-label-row';

    const imagesLabel = document.createElement('label');
    imagesLabel.className = 'prompt-form-label';
    imagesLabel.textContent = 'Images';

    const addImageBtn = document.createElement('button');
    addImageBtn.type = 'button';
    addImageBtn.className = 'prompt-add-image-btn';
    addImageBtn.title = 'Add images';
    addImageBtn.appendChild(this.createIcon('plus', 14));
    const addImageText = document.createElement('span');
    addImageText.textContent = 'Add';
    addImageBtn.appendChild(addImageText);

    imagesLabelRow.appendChild(imagesLabel);
    imagesLabelRow.appendChild(addImageBtn);

    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'prompt-images-container';

    const imagesThumbnails = document.createElement('div');
    imagesThumbnails.className = 'prompt-images-thumbnails';

    const imagesDropZone = document.createElement('div');
    imagesDropZone.className = 'prompt-images-drop-zone';
    imagesDropZone.textContent = 'Drop images here, paste, or click Add';

    // Function to render image thumbnails
    const renderImageThumbnails = async () => {
      imagesThumbnails.textContent = '';

      if (currentImages.length === 0) {
        imagesDropZone.style.display = 'block';
        imagesThumbnails.style.display = 'none';
        return;
      }

      imagesDropZone.style.display = 'none';
      imagesThumbnails.style.display = 'flex';

      for (const img of currentImages) {
        const thumb = document.createElement('div');
        thumb.className = 'prompt-image-thumb';

        const imgEl = document.createElement('img');
        // Try to get thumbnail data URL
        let thumbnailLoaded = false;
        if (window.electronAPI?.promptLibrary?.getImageThumbnail) {
          try {
            const dataUrl = await window.electronAPI.promptLibrary.getImageThumbnail(img.id);
            if (dataUrl) {
              imgEl.src = dataUrl;
              thumbnailLoaded = true;
            }
          } catch (err) {
            console.error('Failed to load thumbnail:', err);
          }
        }
        // Show placeholder if thumbnail failed
        if (!thumbnailLoaded) {
          thumb.classList.add('thumbnail-error');
        }
        imgEl.alt = img.filename || 'Image';
        imgEl.title = img.filename || 'Image';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'prompt-image-remove';
        removeBtn.title = 'Remove image';
        removeBtn.appendChild(this.createIcon('x', 12));

        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Remove from current images
          const idx = currentImages.findIndex(i => i.id === img.id);
          if (idx !== -1) {
            currentImages.splice(idx, 1);
            await renderImageThumbnails();
          }
        });

        thumb.appendChild(imgEl);
        thumb.appendChild(removeBtn);
        imagesThumbnails.appendChild(thumb);
      }
    };

    // Add image from file path
    const addImageFromPath = async (filePath) => {
      if (currentImages.length >= 10) {
        alert('Maximum of 10 images per prompt');
        return;
      }
      if (window.electronAPI?.promptLibrary?.addImage) {
        const result = await window.electronAPI.promptLibrary.addImage(filePath);
        if (result.success && result.image) {
          currentImages.push(result.image);
          await renderImageThumbnails();
        } else if (result.error) {
          alert('Failed to add image: ' + result.error);
        }
      }
    };

    // Add image from data URL (clipboard)
    const addImageFromDataUrl = async (dataUrl) => {
      if (currentImages.length >= 10) {
        alert('Maximum of 10 images per prompt');
        return;
      }
      if (window.electronAPI?.promptLibrary?.addImageFromDataUrl) {
        const result = await window.electronAPI.promptLibrary.addImageFromDataUrl(dataUrl);
        if (result.success && result.image) {
          currentImages.push(result.image);
          await renderImageThumbnails();
        } else if (result.error) {
          alert('Failed to add image: ' + result.error);
        }
      }
    };

    // File picker button click
    addImageBtn.addEventListener('click', async () => {
      if (window.electronAPI?.promptLibrary?.pickImageFiles) {
        const result = await window.electronAPI.promptLibrary.pickImageFiles();
        if (!result.canceled && result.filePaths) {
          for (const filePath of result.filePaths) {
            await addImageFromPath(filePath);
          }
        }
      }
    });

    // Drag and drop handling
    imagesContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      imagesContainer.classList.add('drag-over');
    });

    imagesContainer.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      imagesContainer.classList.remove('drag-over');
    });

    imagesContainer.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      imagesContainer.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await addImageFromPath(file.path);
        }
      }
    });

    // Paste handling for images
    const handlePaste = async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onload = async () => {
              await addImageFromDataUrl(reader.result);
            };
            reader.readAsDataURL(blob);
          }
          break;
        }
      }
    };

    // We need to add paste listener to the modal
    modal.addEventListener('paste', handlePaste);

    imagesContainer.appendChild(imagesThumbnails);
    imagesContainer.appendChild(imagesDropZone);

    imagesGroup.appendChild(imagesLabelRow);
    imagesGroup.appendChild(imagesContainer);

    // Render initial images
    renderImageThumbnails();

    // Options row (checkboxes and scope dropdown)
    const optionsRow = document.createElement('div');
    optionsRow.className = 'prompt-form-options';

    // Reusable checkbox
    const reusableGroup = document.createElement('div');
    reusableGroup.className = 'prompt-form-checkbox';

    const reusableInput = document.createElement('input');
    reusableInput.type = 'checkbox';
    reusableInput.id = 'prompt-reusable-input';
    reusableInput.checked = isReusable;

    const reusableLabel = document.createElement('label');
    reusableLabel.htmlFor = 'prompt-reusable-input';
    reusableLabel.textContent = 'Reusable';

    reusableGroup.appendChild(reusableInput);
    reusableGroup.appendChild(reusableLabel);

    // Favorite checkbox
    const favoriteGroup = document.createElement('div');
    favoriteGroup.className = 'prompt-form-checkbox';

    const favoriteInput = document.createElement('input');
    favoriteInput.type = 'checkbox';
    favoriteInput.id = 'prompt-favorite-input';
    favoriteInput.checked = isFavorite;

    const favoriteLabel = document.createElement('label');
    favoriteLabel.htmlFor = 'prompt-favorite-input';
    favoriteLabel.textContent = 'Favorite';

    favoriteGroup.appendChild(favoriteInput);
    favoriteGroup.appendChild(favoriteLabel);

    // Scope dropdown
    const scopeGroup = document.createElement('div');
    scopeGroup.className = 'prompt-form-scope-group';

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'prompt-form-scope-label';
    scopeLabel.htmlFor = 'prompt-scope-select';
    scopeLabel.textContent = 'Scope:';

    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'prompt-form-input prompt-form-select prompt-scope-select';
    scopeSelect.id = 'prompt-scope-select';

    const projectOption = document.createElement('option');
    projectOption.value = 'project';
    projectOption.textContent = 'Project';
    if (scope === 'project') projectOption.selected = true;

    const globalOption = document.createElement('option');
    globalOption.value = 'global';
    globalOption.textContent = 'Global';
    if (scope === 'global') globalOption.selected = true;

    scopeSelect.appendChild(projectOption);
    scopeSelect.appendChild(globalOption);

    // Auto-enable reusable when Global is selected
    const updateReusableForScope = () => {
      if (scopeSelect.value === 'global') {
        reusableInput.checked = true;
        reusableInput.disabled = true;
        reusableGroup.classList.add('disabled');
        reusableGroup.title = 'Global prompts are always reusable';
      } else {
        reusableInput.disabled = false;
        reusableGroup.classList.remove('disabled');
        reusableGroup.title = '';
      }
    };

    scopeSelect.addEventListener('change', updateReusableForScope);
    // Apply initial state
    updateReusableForScope();

    scopeGroup.appendChild(scopeLabel);
    scopeGroup.appendChild(scopeSelect);

    optionsRow.appendChild(reusableGroup);
    optionsRow.appendChild(favoriteGroup);
    optionsRow.appendChild(scopeGroup);

    // Append to right column
    rightColumn.appendChild(titleGroup);
    rightColumn.appendChild(labelsGroup);
    rightColumn.appendChild(imagesGroup);
    rightColumn.appendChild(optionsRow);

    // Append columns to body
    body.appendChild(leftColumn);
    body.appendChild(rightColumn);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'prompt-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-modal-btn cancel';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'prompt-modal-btn primary';
    saveBtn.id = 'prompt-save-btn';
    saveBtn.textContent = 'Save';

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    // Assemble modal
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);

    // Focus prompt input
    promptInput.focus();

    // Event listeners
    closeBtn.addEventListener('click', () => this.closeModal());
    cancelBtn.addEventListener('click', () => this.closeModal());

    // Save button
    saveBtn.addEventListener('click', async () => {
      const newPromptContent = promptInput.value.trim();
      const newTitle = titleInput.value.trim() || null;
      const newLabels = [...currentLabels];
      const newImages = [...currentImages];
      const newReusable = reusableInput.checked;
      const newFavorite = favoriteInput.checked;
      const newScope = scopeSelect.value;

      if (!newPromptContent) {
        promptInput.focus();
        return;
      }

      await this.savePrompt(newPromptContent, newTitle, newLabels, newImages, newReusable, newFavorite, newScope);
    });

    // Ctrl/Cmd + Enter to save
    promptInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      }
    });

    // Update save button state
    const updateSaveBtn = () => {
      saveBtn.disabled = !promptInput.value.trim();
    };
    promptInput.addEventListener('input', updateSaveBtn);
    updateSaveBtn();
  }

  /**
   * Close modal dialog (or inline editor)
   */
  closeModal() {
    if (this.isInlineEditing) {
      this.closeInlineEditor();
      return;
    }
    const modal = document.querySelector('.prompt-modal-overlay');
    if (modal) {
      modal.remove();
    }
    this.editingPromptId = null;
  }

  /**
   * Save prompt (create or update)
   */
  async savePrompt(promptContent, title, labels, images, reusable, isFavorite, scope, type = 'prompt') {
    try {
      const normalizedType = type === 'note' ? 'note' : 'prompt';
      if (this.editingPromptId) {
        if (window.electronAPI?.promptLibrary?.updatePrompt) {
          await window.electronAPI.promptLibrary.updatePrompt(this.editingPromptId, {
            prompt: promptContent,
            title,
            labels,
            images,
            reusable,
            isFavorite,
            scope,
            type: normalizedType
          });
        }
      } else {
        if (window.electronAPI?.promptLibrary?.createPrompt) {
          await window.electronAPI.promptLibrary.createPrompt({
            prompt: promptContent,
            title,
            labels,
            images,
            reusable,
            isFavorite,
            scope,
            type: normalizedType
          });
        }
      }

      this.closeModal();
      await this.loadPrompts();
    } catch (err) {
      console.error('Failed to save prompt:', err);
      alert('Failed to save prompt: ' + err.message);
    }
  }

  /**
   * Delete a prompt
   */
  async deletePrompt(promptId) {
    const prompt = this.prompts.find(p => p.id === promptId);
    if (!prompt) return;

    const displayTitle = this.getDisplayTitle(prompt);
    if (!confirm(`Delete "${displayTitle}"?`)) {
      return;
    }

    try {
      if (window.electronAPI?.promptLibrary?.deletePrompt) {
        await window.electronAPI.promptLibrary.deletePrompt(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to delete prompt:', err);
      alert('Failed to delete prompt: ' + err.message);
    }
  }

  /**
   * Convert a prompt's type (prompt ↔ note). Notes lose lifecycle state.
   */
  async convertPromptType(promptId) {
    const prompt = this.prompts.find(p => p.id === promptId);
    if (!prompt) return;
    const newType = prompt.type === 'note' ? 'prompt' : 'note';
    try {
      if (window.electronAPI?.promptLibrary?.updatePrompt) {
        await window.electronAPI.promptLibrary.updatePrompt(promptId, { type: newType });
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to convert type:', err);
      alert('Failed to convert: ' + err.message);
    }
  }

  /**
   * Duplicate a prompt
   */
  async duplicatePrompt(promptId) {
    try {
      if (window.electronAPI?.promptLibrary?.duplicatePrompt) {
        await window.electronAPI.promptLibrary.duplicatePrompt(promptId);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to duplicate prompt:', err);
      alert('Failed to duplicate prompt: ' + err.message);
    }
  }

  /**
   * Reorder a prompt
   */
  async reorderPrompt(draggedId, targetId, insertBefore) {
    // Only reorder active prompts within same scope
    const draggedPrompt = this.prompts.find(p => p.id === draggedId);
    const targetPrompt = this.prompts.find(p => p.id === targetId);

    if (!draggedPrompt || !targetPrompt) return;
    if (draggedPrompt.scope !== targetPrompt.scope) {
      alert('Cannot reorder prompts between different scopes');
      return;
    }

    const scope = draggedPrompt.scope || 'project';
    const activePrompts = this.prompts.filter(p => !p.done && p.scope === scope);
    const draggedIndex = activePrompts.findIndex(p => p.id === draggedId);
    const targetIndex = activePrompts.findIndex(p => p.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Create new order
    const newPrompts = [...activePrompts];
    const [draggedCard] = newPrompts.splice(draggedIndex, 1);

    let newIndex = targetIndex;
    if (draggedIndex < targetIndex) {
      newIndex = insertBefore ? targetIndex - 1 : targetIndex;
    } else {
      newIndex = insertBefore ? targetIndex : targetIndex + 1;
    }

    newPrompts.splice(newIndex, 0, draggedCard);

    // Get new order of IDs
    const promptIds = newPrompts.map(p => p.id);

    try {
      if (window.electronAPI?.promptLibrary?.reorderPrompts) {
        await window.electronAPI.promptLibrary.reorderPrompts(promptIds, scope);
        await this.loadPrompts();
      }
    } catch (err) {
      console.error('Failed to reorder prompts:', err);
      await this.loadPrompts();
    }
  }
}

// Export for use in terminal.js
window.PromptLibrary = PromptLibrary;

// Legacy alias for backward compatibility
window.TaskPanel = PromptLibrary;
