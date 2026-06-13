/**
 * PromptLibraryManager - Manages prompts for Claude Code terminals
 *
 * Handles:
 * - CRUD operations for prompts
 * - Per-directory prompt storage via PromptStorageEngine (project scope)
 * - Global prompt storage (global scope)
 * - Panel state persistence per terminal tab
 * - Label management (multiple labels per prompt)
 * - Favorites management
 * - Event emission for UI updates
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const PromptStorageEngine = require('./PromptStorageEngine');

// Validation constants
const MAX_TITLE_LENGTH = 100;
const MAX_PROMPT_LENGTH = 5000;
const MAX_PROMPTS_PER_DIRECTORY = 100;
const MAX_LABEL_LENGTH = 30;
const MAX_LABELS = 50;
const MAX_LABELS_PER_PROMPT = 5;
const MAX_IMAGES_PER_PROMPT = 10;

class PromptLibraryManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - electron-store instance
   * @param {string} options.userDataPath - Electron app.getPath('userData')
   */
  constructor({ store, userDataPath }) {
    super();
    this.store = store;
    this.storageEngine = new PromptStorageEngine(userDataPath);

    // Initialize panel states in store if not present
    if (!this.store.has('promptPanels')) {
      this.store.set('promptPanels', {});
    }

    // Initialize labels if not present (migrate from old categories)
    if (!this.store.has('promptLibrary.labels')) {
      // Migrate old categories to labels if they exist
      const oldCategories = this.store.get('promptLibrary.categories', []);
      this.store.set('promptLibrary.labels', oldCategories);
    }

    // Initialize label colors if not present (assign colors to existing labels)
    if (!this.store.has('promptLibrary.labelColors')) {
      const existingLabels = this.store.get('promptLibrary.labels', []);
      const labelColors = {};
      existingLabels.forEach((label, index) => {
        labelColors[label] = index % 12; // 12 colors in palette
      });
      this.store.set('promptLibrary.labelColors', labelColors);
    }
  }

  /**
   * Migrate old prompt format to new format
   * @private
   */
  _migratePrompt(prompt) {
    const migrated = { ...prompt };

    // Migrate old 'description' field to 'prompt'
    if (prompt.description !== undefined && prompt.prompt === undefined) {
      migrated.prompt = prompt.description;
      delete migrated.description;
    }

    // If no prompt content but has title, use title as prompt
    if (!migrated.prompt && migrated.title) {
      migrated.prompt = migrated.title;
      migrated.title = null;
    }

    // Migrate old 'category' (string) to 'labels' (array)
    if (prompt.category !== undefined && prompt.labels === undefined) {
      migrated.labels = prompt.category ? [prompt.category] : [];
      delete migrated.category;
    }

    // Add new fields with defaults
    if (migrated.labels === undefined) migrated.labels = [];
    if (migrated.images === undefined) migrated.images = [];
    if (migrated.isFavorite === undefined) migrated.isFavorite = false;
    if (migrated.scope === undefined) migrated.scope = 'project';
    if (migrated.type !== 'note' && migrated.type !== 'prompt') migrated.type = 'prompt';

    return migrated;
  }

  _isNote(type) {
    return type === 'note';
  }

  /**
   * Validate a prompt object
   * @private
   */
  _validatePrompt(prompt) {
    if (!prompt.prompt || typeof prompt.prompt !== 'string') {
      throw new Error('Prompt content is required');
    }
    if (prompt.prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt must be ${MAX_PROMPT_LENGTH} characters or less`);
    }
    if (prompt.title && prompt.title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or less`);
    }
    if (prompt.labels) {
      if (!Array.isArray(prompt.labels)) {
        throw new Error('Labels must be an array');
      }
      if (prompt.labels.length > MAX_LABELS_PER_PROMPT) {
        throw new Error(`Maximum of ${MAX_LABELS_PER_PROMPT} labels per prompt`);
      }
      for (const label of prompt.labels) {
        if (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH) {
          throw new Error(`Each label must be ${MAX_LABEL_LENGTH} characters or less`);
        }
      }
    }
    if (prompt.images !== undefined) {
      if (!Array.isArray(prompt.images)) {
        throw new Error('Images must be an array');
      }
      if (prompt.images.length > MAX_IMAGES_PER_PROMPT) {
        throw new Error(`Maximum of ${MAX_IMAGES_PER_PROMPT} images per prompt`);
      }
      for (const img of prompt.images) {
        if (!img || typeof img.id !== 'string') {
          throw new Error('Each image must have a valid ID');
        }
      }
    }
  }

  /**
   * Get all prompts for a working directory (project + global combined)
   * @param {string} cwd - Working directory path
   * @returns {Array} Array of prompt objects sorted by order
   */
  getPromptsForCwd(cwd) {
    if (!cwd) return [];

    // Get project prompts
    const projectPrompts = this.storageEngine.readPrompts(cwd)
      .map(p => this._migratePrompt({ ...p, scope: 'project' }));

    // Get global prompts
    const globalPrompts = this.storageEngine.readGlobalPrompts()
      .map(p => this._migratePrompt({ ...p, scope: 'global' }));

    // Combine and sort
    const allPrompts = [...projectPrompts, ...globalPrompts];
    return allPrompts.sort((a, b) => {
      // Favorites first
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      // Then by order
      return a.order - b.order;
    });
  }

  /**
   * Get only project prompts for a working directory
   * @param {string} cwd - Working directory path
   * @returns {Array} Array of project prompt objects
   */
  getProjectPrompts(cwd) {
    if (!cwd) return [];
    return this.storageEngine.readPrompts(cwd)
      .map(p => this._migratePrompt({ ...p, scope: 'project' }))
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get only global prompts
   * @returns {Array} Array of global prompt objects
   */
  getGlobalPrompts() {
    return this.storageEngine.readGlobalPrompts()
      .map(p => this._migratePrompt({ ...p, scope: 'global' }))
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get a single prompt by ID
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Object|null} Prompt object or null if not found
   */
  getPromptById(cwd, promptId) {
    const prompts = this.getPromptsForCwd(cwd);
    return prompts.find(p => p.id === promptId) || null;
  }

  /**
   * Create a new prompt
   * @param {string} cwd - Working directory path
   * @param {Object} promptData - Prompt data (prompt, title, labels, isFavorite, scope)
   * @returns {Promise<Object>} Created prompt
   */
  async createPrompt(cwd, promptData) {
    this._validatePrompt(promptData);

    const scope = promptData.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    if (prompts.length >= MAX_PROMPTS_PER_DIRECTORY) {
      throw new Error(`Maximum of ${MAX_PROMPTS_PER_DIRECTORY} prompts per ${scope === 'global' ? 'global library' : 'directory'}`);
    }

    // Normalize labels: trim, filter empty, dedupe
    const labels = (promptData.labels || [])
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter((l, i, arr) => arr.indexOf(l) === i);

    const type = promptData.type === 'note' ? 'note' : 'prompt';
    const isNote = this._isNote(type);
    const now = Date.now();
    const prompt = {
      id: `prompt-${crypto.randomUUID()}`,
      type,
      prompt: promptData.prompt.trim(),
      title: promptData.title ? promptData.title.trim() : null,
      labels,
      images: promptData.images || [],
      isFavorite: promptData.isFavorite || false,
      // Notes can never be reusable/done/testing — force false.
      reusable: isNote ? false : (promptData.reusable || false),
      done: false,
      scope,
      order: prompts.length,
      createdAt: now,
      updatedAt: now
    };

    prompts.push(prompt);

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Update an existing prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated prompt
   */
  async updatePrompt(cwd, promptId, updates) {
    // Find the prompt to determine its scope
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const promptIndex = prompts.findIndex(p => p.id === promptId);
    if (promptIndex === -1) {
      throw new Error('Prompt not found in storage');
    }

    // Validate updates
    if (updates.prompt !== undefined) {
      if (!updates.prompt || typeof updates.prompt !== 'string') {
        throw new Error('Prompt content is required');
      }
      if (updates.prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`Prompt must be ${MAX_PROMPT_LENGTH} characters or less`);
      }
    }
    if (updates.title !== undefined && updates.title && updates.title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or less`);
    }

    const prompt = prompts[promptIndex];
    if (updates.prompt !== undefined) {
      prompt.prompt = updates.prompt.trim();
    }
    if (updates.title !== undefined) {
      prompt.title = updates.title ? updates.title.trim() : null;
    }
    if (updates.labels !== undefined) {
      // Normalize labels: trim, filter empty, dedupe
      prompt.labels = (updates.labels || [])
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter((l, i, arr) => arr.indexOf(l) === i);
    }
    if (updates.isFavorite !== undefined) {
      prompt.isFavorite = updates.isFavorite;
    }
    if (updates.type !== undefined) {
      const newType = updates.type === 'note' ? 'note' : 'prompt';
      prompt.type = newType;
      if (this._isNote(newType)) {
        // Notes cannot carry prompt-lifecycle state.
        prompt.reusable = false;
        prompt.done = false;
        prompt.testing = false;
        delete prompt.doneAt;
        delete prompt.testingStartedAt;
      }
    }
    if (updates.reusable !== undefined) {
      // Notes stay non-reusable regardless of what the UI sends.
      prompt.reusable = this._isNote(prompt.type) ? false : updates.reusable;
    }
    if (updates.images !== undefined) {
      // Validate images array
      if (!Array.isArray(updates.images)) {
        throw new Error('Images must be an array');
      }
      if (updates.images.length > MAX_IMAGES_PER_PROMPT) {
        throw new Error(`Maximum of ${MAX_IMAGES_PER_PROMPT} images per prompt`);
      }
      prompt.images = updates.images;
    }
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Delete a prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deletePrompt(cwd, promptId) {
    // Find the prompt to determine its scope
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      return false;
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const promptIndex = prompts.findIndex(p => p.id === promptId);
    if (promptIndex === -1) {
      return false;
    }

    prompts.splice(promptIndex, 1);

    // Renormalize order values
    prompts.forEach((prompt, index) => {
      prompt.order = index;
    });

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return true;
  }

  /**
   * Create a prompt from remote data (preserves the remote ID)
   * Used for real-time sync from Firebase/PWA
   * @param {string} cwd - Working directory path (or '__global__' for global)
   * @param {Object} promptData - Prompt data including id
   * @returns {Promise<Object>} Created prompt
   */
  async createPromptFromRemote(cwd, promptData) {
    const scope = promptData.scope || 'project';
    const isGlobal = scope === 'global' || cwd === '__global__';
    const prompts = isGlobal
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    // Check if prompt already exists (avoid duplicates)
    if (prompts.find(p => p.id === promptData.id)) {
      return this.updatePromptFromRemote(cwd, promptData.id, promptData);
    }

    if (prompts.length >= MAX_PROMPTS_PER_DIRECTORY) {
      console.warn('[PromptLibraryManager] Max prompts reached, skipping remote create');
      return null;
    }

    const type = promptData.type === 'note' ? 'note' : 'prompt';
    const isNote = this._isNote(type);
    const now = Date.now();
    const prompt = {
      id: promptData.id,
      type,
      prompt: (promptData.prompt || '').trim(),
      title: promptData.title ? promptData.title.trim() : null,
      labels: promptData.labels || [],
      images: promptData.images || [],
      isFavorite: promptData.isFavorite || false,
      reusable: isNote ? false : (promptData.reusable || false),
      done: isNote ? false : (promptData.done || false),
      testing: isNote ? false : (promptData.testing || false),
      scope: isGlobal ? 'global' : 'project',
      order: promptData.order !== undefined ? promptData.order : prompts.length,
      createdAt: promptData.createdAt || now,
      updatedAt: promptData.updatedAt || now
    };

    prompts.push(prompt);

    if (isGlobal) {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Update a prompt from remote data
   * Used for real-time sync from Firebase/PWA
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @param {Object} updates - Remote data
   * @returns {Promise<Object>} Updated prompt
   */
  async updatePromptFromRemote(cwd, promptId, updates) {
    const scope = updates.scope || 'project';
    const isGlobal = scope === 'global' || cwd === '__global__';
    const prompts = isGlobal
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const promptIndex = prompts.findIndex(p => p.id === promptId);
    if (promptIndex === -1) {
      // Prompt doesn't exist locally, create it instead
      return this.createPromptFromRemote(cwd, { ...updates, id: promptId });
    }

    const prompt = prompts[promptIndex];

    // Update fields from remote
    if (updates.prompt !== undefined) prompt.prompt = (updates.prompt || '').trim();
    if (updates.title !== undefined) prompt.title = updates.title ? updates.title.trim() : null;
    if (updates.labels !== undefined) prompt.labels = updates.labels || [];
    if (updates.images !== undefined) prompt.images = updates.images || [];
    if (updates.isFavorite !== undefined) prompt.isFavorite = updates.isFavorite;
    if (updates.type !== undefined) prompt.type = updates.type === 'note' ? 'note' : 'prompt';
    if (updates.reusable !== undefined) prompt.reusable = updates.reusable;
    if (updates.done !== undefined) prompt.done = updates.done;
    if (updates.testing !== undefined) prompt.testing = updates.testing;
    if (updates.order !== undefined) prompt.order = updates.order;

    // Notes can't carry prompt-lifecycle state, regardless of what the remote sent.
    if (this._isNote(prompt.type)) {
      prompt.reusable = false;
      prompt.done = false;
      prompt.testing = false;
    }

    prompt.updatedAt = Date.now();

    if (isGlobal) {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Delete a prompt by ID from any location
   * Used for real-time sync from Firebase/PWA
   * @param {string} promptId - Prompt ID
   * @returns {Promise<boolean>} True if found and deleted
   */
  async deletePromptById(promptId) {
    // Check global prompts first
    const globalPrompts = this.getGlobalPrompts();
    const globalIndex = globalPrompts.findIndex(p => p.id === promptId);
    if (globalIndex !== -1) {
      globalPrompts.splice(globalIndex, 1);
      globalPrompts.forEach((p, i) => p.order = i);
      await this.storageEngine.writeGlobalPrompts(globalPrompts);
      this.emit('prompts-updated', { cwd: '__global__', prompts: globalPrompts });
      return true;
    }

    // Check all project prompt files
    const fs = require('fs');
    const files = fs.readdirSync(this.storageEngine.getBaseDir());
    for (const file of files) {
      if (file === 'global.json' || !file.endsWith('.json')) continue;

      const filePath = require('path').join(this.storageEngine.getBaseDir(), file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const prompts = JSON.parse(content);
        const index = prompts.findIndex(p => p.id === promptId);
        if (index !== -1) {
          prompts.splice(index, 1);
          prompts.forEach((p, i) => p.order = i);
          await fs.promises.writeFile(filePath, JSON.stringify(prompts, null, 2));
          // We don't know the actual cwd here, but emit with a placeholder
          this.emit('prompts-updated', { cwd: file.replace('.json', ''), prompts });
          return true;
        }
      } catch (err) {
        // Skip invalid files
      }
    }

    return false;
  }

  /**
   * Duplicate a prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID to duplicate
   * @returns {Promise<Object>} New duplicated prompt
   */
  async duplicatePrompt(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    if (prompts.length >= MAX_PROMPTS_PER_DIRECTORY) {
      throw new Error(`Maximum of ${MAX_PROMPTS_PER_DIRECTORY} prompts per ${scope === 'global' ? 'global library' : 'directory'}`);
    }

    const type = existingPrompt.type === 'note' ? 'note' : 'prompt';
    const now = Date.now();
    const newPrompt = {
      id: `prompt-${crypto.randomUUID()}`,
      type,
      prompt: existingPrompt.prompt,
      title: existingPrompt.title ? `${existingPrompt.title} (copy)` : null,
      labels: [...(existingPrompt.labels || [])],
      images: [], // Don't copy images to avoid shared references
      isFavorite: false,
      reusable: this._isNote(type) ? false : (existingPrompt.reusable || false),
      done: false,
      scope,
      order: existingPrompt.order + 1,
      createdAt: now,
      updatedAt: now
    };

    // Insert after original and renormalize orders
    const originalIndex = prompts.findIndex(p => p.id === promptId);
    prompts.splice(originalIndex + 1, 0, newPrompt);
    prompts.forEach((prompt, index) => {
      prompt.order = index;
    });

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return newPrompt;
  }

  /**
   * Reorder prompts within same scope
   * @param {string} cwd - Working directory path
   * @param {Array<string>} promptIds - Array of prompt IDs in new order
   * @param {string} scope - 'project' or 'global'
   * @returns {Promise<boolean>} True if reordered
   */
  async reorderPrompts(cwd, promptIds, scope = 'project') {
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    // Validate all IDs exist
    const existingIds = new Set(prompts.map(p => p.id));
    for (const id of promptIds) {
      if (!existingIds.has(id)) {
        throw new Error(`Prompt ${id} not found`);
      }
    }

    // Create a map for quick lookup
    const promptMap = new Map(prompts.map(p => [p.id, p]));

    // Reorder based on provided IDs
    const reorderedPrompts = promptIds.map((id, index) => {
      const prompt = promptMap.get(id);
      prompt.order = index;
      return prompt;
    });

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(reorderedPrompts);
    } else {
      await this.storageEngine.writePrompts(cwd, reorderedPrompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return true;
  }

  /**
   * Toggle favorite status on a prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt
   */
  async toggleFavorite(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) {
      throw new Error('Prompt not found in storage');
    }

    prompt.isFavorite = !prompt.isFavorite;
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Toggle reusable flag on a prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt
   */
  async toggleReusable(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) {
      throw new Error('Prompt not found in storage');
    }

    prompt.reusable = !prompt.reusable;
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Set labels on a prompt
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @param {Array<string>} labels - Array of label names
   * @returns {Promise<Object>} Updated prompt
   */
  async setLabels(cwd, promptId, labels) {
    if (labels && labels.length > MAX_LABELS_PER_PROMPT) {
      throw new Error(`Maximum of ${MAX_LABELS_PER_PROMPT} labels per prompt`);
    }

    return this.updatePrompt(cwd, promptId, { labels: labels || [] });
  }

  /**
   * Mark a prompt as testing (moves to Testing section unless reusable)
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt
   */
  async markAsTesting(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    // Don't move reusable prompts to testing
    if (existingPrompt.reusable) {
      return existingPrompt;
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) {
      throw new Error('Prompt not found in storage');
    }

    prompt.testing = true;
    prompt.testingStartedAt = Date.now();
    prompt.done = false;
    delete prompt.doneAt;
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Mark a prompt as done (moves to Done section unless reusable)
   * Can be called from active or testing status
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt
   */
  async markAsDone(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    // Don't move reusable prompts to done
    if (existingPrompt.reusable) {
      return existingPrompt;
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) {
      throw new Error('Prompt not found in storage');
    }

    prompt.done = true;
    prompt.doneAt = Date.now();
    // Clear testing status
    prompt.testing = false;
    delete prompt.testingStartedAt;
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Restore a prompt from done or testing back to active
   * @param {string} cwd - Working directory path
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt
   */
  async restorePrompt(cwd, promptId) {
    const existingPrompt = this.getPromptById(cwd, promptId);
    if (!existingPrompt) {
      throw new Error('Prompt not found');
    }

    const scope = existingPrompt.scope || 'project';
    const prompts = scope === 'global'
      ? this.getGlobalPrompts()
      : this.getProjectPrompts(cwd);

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) {
      throw new Error('Prompt not found in storage');
    }

    prompt.done = false;
    delete prompt.doneAt;
    // Also clear testing status
    prompt.testing = false;
    delete prompt.testingStartedAt;
    prompt.updatedAt = Date.now();

    if (scope === 'global') {
      await this.storageEngine.writeGlobalPrompts(prompts);
    } else {
      await this.storageEngine.writePrompts(cwd, prompts);
    }

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return prompt;
  }

  /**
   * Clear all done prompts
   * @param {string} cwd - Working directory path
   * @returns {Promise<number>} Number of prompts cleared
   */
  async clearDonePrompts(cwd) {
    // Clear from project prompts
    const projectPrompts = this.getProjectPrompts(cwd);
    const activeProjectPrompts = projectPrompts.filter(p => !p.done);
    const projectCleared = projectPrompts.length - activeProjectPrompts.length;

    activeProjectPrompts.forEach((prompt, index) => {
      prompt.order = index;
    });
    await this.storageEngine.writePrompts(cwd, activeProjectPrompts);

    // Clear from global prompts
    const globalPrompts = this.getGlobalPrompts();
    const activeGlobalPrompts = globalPrompts.filter(p => !p.done);
    const globalCleared = globalPrompts.length - activeGlobalPrompts.length;

    activeGlobalPrompts.forEach((prompt, index) => {
      prompt.order = index;
    });
    await this.storageEngine.writeGlobalPrompts(activeGlobalPrompts);

    this.emit('prompts-updated', { cwd, prompts: this.getPromptsForCwd(cwd) });
    return projectCleared + globalCleared;
  }

  // --- Label Management ---

  /**
   * Get all available labels
   * @returns {Array<string>} Array of label names
   */
  getLabels() {
    return this.store.get('promptLibrary.labels', []);
  }

  /**
   * Get all label colors
   * @returns {Object} Map of label name to color index
   */
  getLabelColors() {
    return this.store.get('promptLibrary.labelColors', {});
  }

  /**
   * Get a specific label's color index
   * @param {string} name - Label name
   * @returns {number} Color index (0-11)
   */
  getLabelColor(name) {
    const colors = this.getLabelColors();
    return colors[name] !== undefined ? colors[name] : 0;
  }

  /**
   * Get the next color index to assign (cycles through 12 colors)
   * @private
   */
  _getNextColorIndex() {
    const colors = this.getLabelColors();
    const usedIndices = Object.values(colors);
    // Find the least used color index
    const colorCounts = new Array(12).fill(0);
    usedIndices.forEach(idx => {
      if (idx >= 0 && idx < 12) colorCounts[idx]++;
    });
    // Return the index with lowest count
    let minCount = Infinity;
    let minIndex = 0;
    colorCounts.forEach((count, idx) => {
      if (count < minCount) {
        minCount = count;
        minIndex = idx;
      }
    });
    return minIndex;
  }

  /**
   * Add a new label
   * @param {string} name - Label name
   * @returns {boolean} True if added, false if already exists
   */
  addLabel(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Label name is required');
    }

    const trimmed = name.trim();
    if (trimmed.length > MAX_LABEL_LENGTH) {
      throw new Error(`Label must be ${MAX_LABEL_LENGTH} characters or less`);
    }

    const labels = this.getLabels();
    if (labels.length >= MAX_LABELS) {
      throw new Error(`Maximum of ${MAX_LABELS} labels allowed`);
    }

    if (labels.includes(trimmed)) {
      return false;
    }

    // Assign a color to the new label
    const labelColors = this.getLabelColors();
    const colorIndex = this._getNextColorIndex();
    labelColors[trimmed] = colorIndex;

    labels.push(trimmed);
    this.store.set('promptLibrary.labels', labels);
    this.store.set('promptLibrary.labelColors', labelColors);
    this.emit('labels-updated', { labels, labelColors });
    return true;
  }

  /**
   * Delete a label
   * @param {string} name - Label name
   * @returns {boolean} True if deleted
   */
  deleteLabel(name) {
    const labels = this.getLabels();
    const index = labels.indexOf(name);
    if (index === -1) {
      return false;
    }

    // Remove label color
    const labelColors = this.getLabelColors();
    delete labelColors[name];

    labels.splice(index, 1);
    this.store.set('promptLibrary.labels', labels);
    this.store.set('promptLibrary.labelColors', labelColors);
    this.emit('labels-updated', { labels, labelColors });
    return true;
  }

  /**
   * Replace the local label registry with a remote-authored set.
   * Does NOT emit `labels-updated` — that event is reserved for local edits and
   * re-emitting it would cause a sync ping-pong. Emits `labels-applied-remote`
   * so the renderer can still refresh its UI.
   * @param {Array<string>} labels
   * @param {Object<string, number>} labelColors
   */
  applyRemoteLabels(labels, labelColors) {
    const safeLabels = Array.isArray(labels) ? labels : [];
    const safeColors = labelColors && typeof labelColors === 'object' ? labelColors : {};
    this.store.set('promptLibrary.labels', safeLabels);
    this.store.set('promptLibrary.labelColors', safeColors);
    this.emit('labels-applied-remote', { labels: safeLabels, labelColors: safeColors });
  }

  /**
   * Return every prompt across project + global scopes. Used by sync backfills.
   * @returns {Array<Object>}
   */
  getAllPromptsAcrossScopes() {
    return this.storageEngine.readAllPrompts();
  }

  // Legacy aliases
  getCategories() { return this.getLabels(); }
  addCategory(name) { return this.addLabel(name); }
  deleteCategory(name) { return this.deleteLabel(name); }

  // --- Panel State Management ---

  /**
   * Get panel state for a terminal tab
   * @param {string} tabId - Terminal tab ID
   * @returns {Object} Panel state { visible, width, activeTab, scopeFilter }
   */
  getPanelState(tabId) {
    const panels = this.store.get('promptPanels', {});
    const saved = panels[tabId] || {};
    return {
      visible: saved.visible || false,
      width: saved.width || 300,
      activeTab: saved.activeTab || 'prompts',
      scopeFilter: saved.scopeFilter || 'all'
    };
  }

  /**
   * Set panel state for a terminal tab
   * @param {string} tabId - Terminal tab ID
   * @param {Object} state - Panel state { visible, width, activeTab, scopeFilter }
   */
  setPanelState(tabId, state) {
    const panels = this.store.get('promptPanels', {});
    const prev = panels[tabId] || {};
    panels[tabId] = {
      visible: state.visible !== undefined ? state.visible : (prev.visible || false),
      width: state.width !== undefined ? state.width : (prev.width || 300),
      activeTab: state.activeTab !== undefined ? state.activeTab : (prev.activeTab || 'prompts'),
      scopeFilter: state.scopeFilter !== undefined ? state.scopeFilter : (prev.scopeFilter || 'all')
    };
    this.store.set('promptPanels', panels);

    this.emit('panel-state-changed', { tabId, state: panels[tabId] });
  }

  /**
   * Clean up panel state for a deleted tab
   * @param {string} tabId - Terminal tab ID
   */
  cleanupPanelState(tabId) {
    const panels = this.store.get('promptPanels', {});
    if (panels[tabId]) {
      delete panels[tabId];
      this.store.set('promptPanels', panels);
    }
  }

  /**
   * Get the storage engine (for advanced operations)
   * @returns {PromptStorageEngine}
   */
  getStorageEngine() {
    return this.storageEngine;
  }

  // --- Legacy aliases for backward compatibility ---

  getCardsForCwd(cwd) {
    return this.getPromptsForCwd(cwd);
  }

  getCardById(cwd, cardId) {
    return this.getPromptById(cwd, cardId);
  }

  async createCard(cwd, cardData) {
    // Convert old card format to new prompt format
    const promptData = {
      prompt: cardData.description || cardData.prompt || cardData.title,
      title: cardData.title || null,
      reusable: cardData.reusable || false,
      category: cardData.category || null,
      isFavorite: cardData.isFavorite || false,
      scope: cardData.scope || 'project'
    };
    return this.createPrompt(cwd, promptData);
  }

  async updateCard(cwd, cardId, updates) {
    // Convert old field names
    const promptUpdates = { ...updates };
    if (updates.description !== undefined) {
      promptUpdates.prompt = updates.description;
      delete promptUpdates.description;
    }
    return this.updatePrompt(cwd, cardId, promptUpdates);
  }

  async deleteCard(cwd, cardId) {
    return this.deletePrompt(cwd, cardId);
  }

  async duplicateCard(cwd, cardId) {
    return this.duplicatePrompt(cwd, cardId);
  }

  async reorderCards(cwd, cardIds) {
    return this.reorderPrompts(cwd, cardIds, 'project');
  }

  // Note: markAsDone already exists as the primary method, no legacy alias needed

  async restoreCard(cwd, cardId) {
    return this.restorePrompt(cwd, cardId);
  }

  async clearDoneCards(cwd) {
    return this.clearDonePrompts(cwd);
  }
}

module.exports = PromptLibraryManager;
