/**
 * TabManager - Handles tab CRUD, ordering, and persistence
 *
 * Tab structure:
 * {
 *   id: string,          // Unique tab ID (e.g., 'tab-uuid')
 *   serviceType: string, // Service type ID from ServiceRegistry
 *   name: string,        // Display name (can be customized)
 *   order: number,       // Position in sidebar (0-based)
 *   createdAt: number,   // Timestamp
 * }
 */

const crypto = require('crypto');
const { generateTabName, isValidServiceType } = require('./ServiceRegistry');

class TabManager {
  /**
   * @param {Object} store - electron-store instance for persistence
   */
  constructor(store) {
    this.store = store;
    this.tabs = new Map();
    this.listeners = new Set();
    this._loadFromStore();
  }

  /**
   * Load tabs from persistent storage
   * @private
   */
  _loadFromStore() {
    const savedTabs = this.store.get('tabs', []);
    this.tabs.clear();

    // Validate and load each tab
    savedTabs.forEach(tab => {
      if (tab.id && tab.serviceType && isValidServiceType(tab.serviceType)) {
        this.tabs.set(tab.id, {
          id: tab.id,
          serviceType: tab.serviceType,
          name: tab.name || tab.serviceType,
          order: typeof tab.order === 'number' ? tab.order : this.tabs.size,
          createdAt: tab.createdAt || Date.now()
        });
      }
    });

    // Re-normalize order indices
    this._normalizeOrder();
  }

  /**
   * Save tabs to persistent storage
   * @private
   */
  _saveToStore() {
    const tabArray = this.getOrderedTabs();
    this.store.set('tabs', tabArray);
  }

  /**
   * Normalize order indices to be sequential (0, 1, 2, ...)
   * @private
   */
  _normalizeOrder() {
    const ordered = this.getOrderedTabs();
    ordered.forEach((tab, index) => {
      tab.order = index;
    });
  }

  /**
   * Notify all listeners of tab changes
   * @private
   */
  _notifyListeners() {
    const tabs = this.getOrderedTabs();
    this.listeners.forEach(callback => {
      try {
        callback(tabs);
      } catch (err) {
        console.error('TabManager listener error:', err);
      }
    });
  }

  /**
   * Get all tabs ordered by position
   * @returns {Object[]} Array of tabs sorted by order
   */
  getOrderedTabs() {
    return Array.from(this.tabs.values()).sort((a, b) => a.order - b.order);
  }

  /**
   * Get a specific tab by ID
   * @param {string} tabId - The tab ID
   * @returns {Object|null} The tab or null
   */
  getTab(tabId) {
    return this.tabs.get(tabId) || null;
  }

  /**
   * Check if any tabs exist
   * @returns {boolean} True if there are tabs
   */
  hasTabs() {
    return this.tabs.size > 0;
  }

  /**
   * Get the count of tabs
   * @returns {number} Number of tabs
   */
  getTabCount() {
    return this.tabs.size;
  }

  /**
   * Create a new tab
   * @param {string} serviceType - The service type ID
   * @param {string} [customName] - Optional custom name
   * @returns {Object} The created tab
   */
  createTab(serviceType, customName = null) {
    if (!isValidServiceType(serviceType)) {
      throw new Error(`Invalid service type: ${serviceType}`);
    }

    const existingTabs = this.getOrderedTabs();
    const name = customName || generateTabName(serviceType, existingTabs);

    const tab = {
      id: `tab-${crypto.randomUUID()}`,
      serviceType,
      name,
      order: this.tabs.size,
      createdAt: Date.now()
    };

    this.tabs.set(tab.id, tab);
    this._saveToStore();
    this._notifyListeners();

    return tab;
  }

  /**
   * Rename a tab
   * @param {string} tabId - The tab ID
   * @param {string} newName - The new name
   * @returns {boolean} True if successful
   */
  renameTab(tabId, newName) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    const trimmedName = (newName || '').trim();
    if (!trimmedName) return false;

    tab.name = trimmedName;
    this._saveToStore();
    this._notifyListeners();

    return true;
  }

  /**
   * Delete a tab
   * @param {string} tabId - The tab ID
   * @returns {Object|null} The deleted tab or null
   */
  deleteTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;

    this.tabs.delete(tabId);
    this._normalizeOrder();
    this._saveToStore();
    this._notifyListeners();

    return tab;
  }

  /**
   * Reorder a tab by moving it to a new position
   * @param {string} tabId - The tab ID to move
   * @param {number} newIndex - The new position (0-based)
   * @returns {boolean} True if successful
   */
  reorderTab(tabId, newIndex) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    const ordered = this.getOrderedTabs();
    const currentIndex = ordered.findIndex(t => t.id === tabId);

    if (currentIndex === -1) return false;

    // Clamp newIndex to valid range
    const clampedIndex = Math.max(0, Math.min(newIndex, ordered.length - 1));
    if (currentIndex === clampedIndex) return true;

    // Remove from current position and insert at new position
    ordered.splice(currentIndex, 1);
    ordered.splice(clampedIndex, 0, tab);

    // Update order values
    ordered.forEach((t, index) => {
      t.order = index;
    });

    this._saveToStore();
    this._notifyListeners();

    return true;
  }

  /**
   * Move a tab relative to another tab (for drag-drop)
   * @param {string} draggedTabId - The tab being dragged
   * @param {string} targetTabId - The tab to drop onto
   * @param {string} position - 'before' or 'after'
   * @returns {boolean} True if successful
   */
  moveTabRelative(draggedTabId, targetTabId, position = 'before') {
    if (draggedTabId === targetTabId) return true;

    const ordered = this.getOrderedTabs();
    const draggedIndex = ordered.findIndex(t => t.id === draggedTabId);
    const targetIndex = ordered.findIndex(t => t.id === targetTabId);

    if (draggedIndex === -1 || targetIndex === -1) return false;

    const draggedTab = ordered[draggedIndex];
    ordered.splice(draggedIndex, 1);

    // Calculate new index after removal
    let newIndex = ordered.findIndex(t => t.id === targetTabId);
    if (position === 'after') {
      newIndex += 1;
    }

    ordered.splice(newIndex, 0, draggedTab);

    // Update order values
    ordered.forEach((t, index) => {
      t.order = index;
    });

    this._saveToStore();
    this._notifyListeners();

    return true;
  }

  /**
   * Get tab at a specific position (for keyboard shortcuts)
   * @param {number} index - The position (0-based)
   * @returns {Object|null} The tab or null
   */
  getTabAtIndex(index) {
    const ordered = this.getOrderedTabs();
    return ordered[index] || null;
  }

  /**
   * Get the index of a tab
   * @param {string} tabId - The tab ID
   * @returns {number} The index or -1 if not found
   */
  getTabIndex(tabId) {
    const ordered = this.getOrderedTabs();
    return ordered.findIndex(t => t.id === tabId);
  }

  /**
   * Add a listener for tab changes
   * @param {Function} callback - Called with ordered tabs array on change
   * @returns {Function} Unsubscribe function
   */
  onTabsChanged(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Remove all listeners (for cleanup)
   */
  removeAllListeners() {
    this.listeners.clear();
  }

  /**
   * Get tabs for IPC serialization
   * @returns {Object[]} Array of tab data for renderer
   */
  getTabsForRenderer() {
    return this.getOrderedTabs().map(tab => ({
      id: tab.id,
      serviceType: tab.serviceType,
      name: tab.name,
      order: tab.order
    }));
  }
}

module.exports = TabManager;
