/**
 * FirebaseSyncAdapter
 *
 * Syncs local prompt library with Firebase Firestore for cross-device access.
 * Handles bidirectional sync, conflict resolution, and offline support.
 */

const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp
} = require('firebase/firestore');
const {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged
} = require('firebase/auth');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROMPTS_COLLECTION = 'prompts';
const PROJECTS_COLLECTION = 'projects';

class FirebaseSyncAdapter extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - electron-store instance
   * @param {Object} options.promptLibraryManager - PromptLibraryManager instance
   * @param {string} options.userDataPath - Electron app.getPath('userData')
   */
  constructor({ store, promptLibraryManager, userDataPath }) {
    super();
    this.store = store;
    this.promptLibraryManager = promptLibraryManager;
    this.userDataPath = userDataPath;
    this.promptsDir = path.join(userDataPath, 'prompts');
    this.app = null;
    this.db = null;
    this.auth = null;
    this.user = null;
    this.unsubscribers = [];
    this.syncEnabled = false;
    this.isSyncing = false;
  }

  /**
   * Initialize Firebase with config
   * @param {Object} config - Firebase config object
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async initialize(config) {
    if (!config || !config.apiKey) {
      return { success: false, error: 'Invalid Firebase config' };
    }

    try {
      this.app = initializeApp(config, 'prompt-sync');
      this.db = getFirestore(this.app);
      this.auth = getAuth(this.app);

      // Listen for auth state changes
      onAuthStateChanged(this.auth, (user) => {
        this.user = user;
        this.emit('auth-state-changed', user ? { uid: user.uid, email: user.email } : null);

        if (user && this.syncEnabled) {
          this._startRealtimeSync();
        } else {
          this._stopRealtimeSync();
        }
      });

      console.log('[FirebaseSyncAdapter] Initialized');
      return { success: true };
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Init error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Sign in with email/password
   * @param {string} email
   * @param {string} password
   * @param {boolean} saveCredentials - Whether to save credentials for auto-login
   * @returns {Promise<{success: boolean, user?: object, error?: string}>}
   */
  async signIn(email, password, saveCredentials = true) {
    if (!this.auth) {
      return { success: false, error: 'Firebase not initialized' };
    }

    try {
      const credential = await signInWithEmailAndPassword(this.auth, email, password);

      // Save credentials securely for auto-login on next app start
      if (saveCredentials) {
        this._saveCredentials(email, password);
      }

      // Enable sync and start real-time listener
      this.syncEnabled = true;
      this.store.set('firebase.syncEnabled', true);
      this._startRealtimeSync();

      return {
        success: true,
        user: { uid: credential.user.uid, email: credential.user.email }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Restore session from saved credentials (called on app start)
   * @returns {Promise<{success: boolean, user?: object, error?: string}>}
   */
  async restoreSession() {
    const credentials = this._loadCredentials();
    if (!credentials) {
      return { success: false, error: 'No saved credentials' };
    }

    console.log('[FirebaseSyncAdapter] Restoring session for', credentials.email);
    return this.signIn(credentials.email, credentials.password, false);
  }

  /**
   * Save credentials securely using Electron's safeStorage
   * @private
   */
  _saveCredentials(email, password) {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[FirebaseSyncAdapter] Secure storage not available');
        return;
      }

      const credentials = JSON.stringify({ email, password });
      const encrypted = safeStorage.encryptString(credentials);
      this.store.set('firebase.credentials', encrypted.toString('base64'));
      console.log('[FirebaseSyncAdapter] Credentials saved securely');
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to save credentials:', err);
    }
  }

  /**
   * Load credentials from secure storage
   * @private
   */
  _loadCredentials() {
    try {
      const encrypted = this.store.get('firebase.credentials');
      if (!encrypted) return null;

      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[FirebaseSyncAdapter] Secure storage not available');
        return null;
      }

      const buffer = Buffer.from(encrypted, 'base64');
      const decrypted = safeStorage.decryptString(buffer);
      return JSON.parse(decrypted);
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to load credentials:', err);
      return null;
    }
  }

  /**
   * Clear saved credentials
   * @private
   */
  _clearCredentials() {
    this.store.delete('firebase.credentials');
    console.log('[FirebaseSyncAdapter] Credentials cleared');
  }

  /**
   * Sign out
   */
  async signOut() {
    this._clearCredentials();
    if (this.auth) {
      await this.auth.signOut();
    }
  }

  /**
   * Enable/disable sync
   * @param {boolean} enabled
   */
  setSyncEnabled(enabled) {
    this.syncEnabled = enabled;
    this.store.set('firebase.syncEnabled', enabled);

    if (enabled && this.user) {
      this._startRealtimeSync();
    } else {
      this._stopRealtimeSync();
    }
  }

  /**
   * Perform initial full sync
   * @param {string} cwd - Working directory to sync
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async syncProject(cwd) {
    if (!this.user || !this.db) {
      return { success: false, error: 'Not authenticated' };
    }

    if (this.isSyncing) {
      return { success: false, error: 'Sync already in progress' };
    }

    this.isSyncing = true;

    try {
      // Get local prompts
      const localPrompts = await this.promptLibraryManager.getPromptsForCwd(cwd);

      // Get or create project in Firestore
      const projectId = await this._ensureProject(cwd);

      // Get remote prompts for this project
      const remotePrompts = await this._getRemotePrompts(projectId);

      // Merge prompts (local wins on conflict for now)
      const mergedPrompts = this._mergePrompts(localPrompts, remotePrompts);

      // Upload merged prompts
      for (const prompt of mergedPrompts) {
        await this._uploadPrompt(projectId, prompt);
      }

      // Update local with any new remote prompts
      for (const prompt of mergedPrompts) {
        const localExists = localPrompts.some(p => p.id === prompt.id);
        if (!localExists) {
          await this.promptLibraryManager.createPrompt(cwd, prompt);
        }
      }

      this.emit('sync-complete', { cwd, promptCount: mergedPrompts.length });
      return { success: true };
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Sync error:', err);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Migrate all local prompts to Firebase (called on first login)
   * Scans the prompts directory and uploads all project + global prompts
   * @returns {Promise<{success: boolean, projectCount?: number, promptCount?: number, error?: string}>}
   */
  async migrateAllLocalPrompts() {
    if (!this.user || !this.db) {
      return { success: false, error: 'Not authenticated' };
    }

    if (this.isSyncing) {
      return { success: false, error: 'Sync already in progress' };
    }

    this.isSyncing = true;
    let projectCount = 0;
    let promptCount = 0;

    try {
      console.log('[FirebaseSyncAdapter] Starting migration of all local prompts...');
      this.emit('migration-started');

      // Ensure prompts directory exists
      if (!fs.existsSync(this.promptsDir)) {
        console.log('[FirebaseSyncAdapter] No prompts directory found, nothing to migrate');
        return { success: true, projectCount: 0, promptCount: 0 };
      }

      // Get all JSON files in prompts directory
      const files = fs.readdirSync(this.promptsDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const filePath = path.join(this.promptsDir, file);

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const prompts = JSON.parse(content);

          if (!Array.isArray(prompts) || prompts.length === 0) {
            continue;
          }

          // Determine if this is global or project prompts
          const isGlobal = file === 'global.json';

          if (isGlobal) {
            // Upload global prompts with special project ID
            const globalProjectId = `${this.user.uid}_global`;
            await setDoc(doc(this.db, PROJECTS_COLLECTION, globalProjectId), {
              userId: this.user.uid,
              name: 'Global Prompts',
              path: '__global__',
              pathHash: 'global',
              updatedAt: serverTimestamp()
            }, { merge: true });

            for (const prompt of prompts) {
              await this._uploadPrompt(globalProjectId, { ...prompt, scope: 'global' });
              promptCount++;
            }
            console.log(`[FirebaseSyncAdapter] Migrated ${prompts.length} global prompts`);
          } else {
            // Project prompts - file name is the path hash
            const pathHash = file.replace('.json', '');

            // We don't know the original cwd, so we'll use a placeholder
            // The important thing is the prompts get uploaded with a unique project ID
            const projectId = `${this.user.uid}_${pathHash}`;

            await setDoc(doc(this.db, PROJECTS_COLLECTION, projectId), {
              userId: this.user.uid,
              name: `Project ${pathHash.substring(0, 8)}`,
              path: `unknown_${pathHash}`,
              pathHash,
              updatedAt: serverTimestamp()
            }, { merge: true });

            for (const prompt of prompts) {
              await this._uploadPrompt(projectId, { ...prompt, scope: 'project' });
              promptCount++;
            }
            projectCount++;
            console.log(`[FirebaseSyncAdapter] Migrated ${prompts.length} prompts from project ${pathHash.substring(0, 8)}`);
          }
        } catch (parseErr) {
          console.error(`[FirebaseSyncAdapter] Failed to parse ${file}:`, parseErr.message);
        }
      }

      // Mark migration as complete
      this.store.set('firebase.migrationComplete', true);

      console.log(`[FirebaseSyncAdapter] Migration complete: ${projectCount} projects, ${promptCount} prompts`);
      this.emit('migration-complete', { projectCount, promptCount });

      return { success: true, projectCount, promptCount };
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Migration error:', err);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Check if migration has been completed
   * @returns {boolean}
   */
  isMigrationComplete() {
    return this.store.get('firebase.migrationComplete', false);
  }

  /**
   * Start real-time sync listeners
   * @private
   */
  _startRealtimeSync() {
    this._stopRealtimeSync(); // Clear any existing listeners

    if (!this.user || !this.db) return;

    // Listen for remote prompt changes
    const q = query(
      collection(this.db, PROMPTS_COLLECTION),
      where('userId', '==', this.user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const changes = snapshot.docChanges();
      if (changes.length > 0) {
        console.log(`[FirebaseSyncAdapter] Syncing ${changes.length} prompt(s)`);
      }
      changes.forEach((change) => {
        const data = change.doc.data();
        const promptId = change.doc.id;

        if (change.type === 'added' || change.type === 'modified') {
          this.emit('remote-prompt-changed', {
            id: promptId,
            ...data,
            isRemote: true
          });
        } else if (change.type === 'removed') {
          this.emit('remote-prompt-deleted', { id: promptId });
        }
      });
    }, (error) => {
      console.error('[FirebaseSyncAdapter] onSnapshot error:', error);
    });

    this.unsubscribers.push(unsubscribe);
    console.log('[FirebaseSyncAdapter] Real-time sync started for user:', this.user?.email);
  }

  /**
   * Stop real-time sync listeners
   * @private
   */
  _stopRealtimeSync() {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }

  /**
   * Ensure project exists in Firestore
   * @private
   */
  async _ensureProject(cwd) {
    const pathHash = this._hashPath(cwd);
    const projectRef = doc(this.db, PROJECTS_COLLECTION, `${this.user.uid}_${pathHash}`);
    const folderName = cwd.split('/').filter(Boolean).pop() || cwd;

    await setDoc(projectRef, {
      userId: this.user.uid,
      name: folderName,
      path: cwd,
      pathHash,
      updatedAt: serverTimestamp()
    }, { merge: true });

    return projectRef.id;
  }

  /**
   * Get remote prompts for a project
   * @private
   */
  async _getRemotePrompts(projectId) {
    const q = query(
      collection(this.db, PROMPTS_COLLECTION),
      where('userId', '==', this.user.uid),
      where('projectId', '==', projectId)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  }

  /**
   * Upload a prompt to Firestore
   * @private
   */
  async _uploadPrompt(projectId, prompt) {
    const promptRef = doc(this.db, PROMPTS_COLLECTION, prompt.id);

    await setDoc(promptRef, {
      userId: this.user.uid,
      projectId,
      title: prompt.title || '',
      prompt: prompt.prompt || '',
      labels: prompt.labels || [],
      images: prompt.images || [],
      isFavorite: prompt.isFavorite || false,
      reusable: prompt.reusable || false,
      done: prompt.done || false,
      testing: prompt.testing || false,
      scope: prompt.scope || 'project',
      order: prompt.order || 0,
      createdAt: prompt.createdAt ? Timestamp.fromMillis(prompt.createdAt) : serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  /**
   * Delete a prompt from Firestore
   * @param {string} promptId
   */
  async deleteRemotePrompt(promptId) {
    if (!this.user || !this.db) return;
    await deleteDoc(doc(this.db, PROMPTS_COLLECTION, promptId));
  }

  /**
   * Push a local prompt to Firebase (public method for real-time sync)
   * @param {string} cwd - Working directory path
   * @param {Object} prompt - The prompt object
   */
  async pushPromptToFirebase(cwd, prompt) {
    if (!this.user || !this.db || !this.syncEnabled) {
      console.log('[FirebaseSyncAdapter] Skipping push - not authenticated or sync disabled');
      return;
    }

    try {
      const isGlobal = prompt.scope === 'global';
      let projectId;

      if (isGlobal) {
        projectId = `${this.user.uid}_global`;
      } else {
        // Ensure project exists and get projectId
        projectId = await this._ensureProject(cwd);
      }

      await this._uploadPrompt(projectId, prompt);
      console.log('[FirebaseSyncAdapter] Pushed prompt to Firebase:', prompt.id);
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to push prompt:', err.message);
    }
  }

  /**
   * Merge local and remote prompts
   * @private
   */
  _mergePrompts(local, remote) {
    const merged = new Map();

    // Add local prompts
    for (const prompt of local) {
      merged.set(prompt.id, prompt);
    }

    // Merge remote prompts (remote wins if newer)
    for (const remotePrompt of remote) {
      const localPrompt = merged.get(remotePrompt.id);

      if (!localPrompt) {
        // New remote prompt
        merged.set(remotePrompt.id, remotePrompt);
      } else {
        // Conflict - merge fields
        const mergedPrompt = this._mergePromptFields(localPrompt, remotePrompt);
        merged.set(remotePrompt.id, mergedPrompt);
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Merge individual prompt fields (auto-merge strategy)
   * @private
   */
  _mergePromptFields(local, remote) {
    const localTime = local.updatedAt || local.createdAt || 0;
    const remoteTime = remote.updatedAt?.toMillis?.() || remote.updatedAt || 0;

    // For content fields, newer wins
    const contentSource = remoteTime > localTime ? remote : local;

    return {
      id: local.id,
      title: contentSource.title,
      prompt: contentSource.prompt,
      // Merge arrays (union)
      labels: [...new Set([...(local.labels || []), ...(remote.labels || [])])],
      images: [...new Set([...(local.images || []), ...(remote.images || [])])],
      // Boolean flags - if either is true, keep true
      isFavorite: local.isFavorite || remote.isFavorite,
      reusable: local.reusable || remote.reusable,
      done: local.done || remote.done,
      testing: local.testing || remote.testing,
      // Take from newer
      scope: contentSource.scope,
      order: contentSource.order,
      createdAt: Math.min(local.createdAt || Date.now(), remoteTime || Date.now()),
      updatedAt: Math.max(localTime, remoteTime)
    };
  }

  /**
   * Hash a path for use as an ID
   * Must match PromptStorageEngine.getCwdHash() algorithm for consistency
   * @private
   */
  _hashPath(cwdPath) {
    const normalized = path.normalize(cwdPath).toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Update project info in Firebase when terminal connects to a folder
   * This updates placeholder names with actual folder paths/names
   * @param {string} cwd - Working directory path
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateProjectInfo(cwd) {
    if (!this.user || !this.db) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const pathHash = this._hashPath(cwd);
      const projectId = `${this.user.uid}_${pathHash}`;
      const projectRef = doc(this.db, PROJECTS_COLLECTION, projectId);
      const folderName = cwd.split('/').filter(Boolean).pop() || cwd;

      await setDoc(projectRef, {
        userId: this.user.uid,
        name: folderName,
        path: cwd,
        pathHash,
        updatedAt: serverTimestamp()
      }, { merge: true });

      // Logged at debug level — this runs frequently during sync
      return { success: true };
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to update project info:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Resolve a projectId to a cwd path
   * @param {string} projectId - The project ID (userId_pathHash)
   * @returns {Promise<string|null>} The cwd path or null if not found
   */
  async resolveProjectIdToCwd(projectId) {
    if (!this.db || !projectId) return null;

    // Handle global scope
    if (projectId.endsWith('_global')) {
      return '__global__';
    }

    try {
      const projectRef = doc(this.db, PROJECTS_COLLECTION, projectId);
      const projectSnap = await getDoc(projectRef);
      if (projectSnap.exists()) {
        return projectSnap.data().path || null;
      }
    } catch (err) {
      console.error('[FirebaseSyncAdapter] Failed to resolve projectId:', err);
    }
    return null;
  }

  /**
   * Get current user
   */
  getCurrentUser() {
    return this.user ? { uid: this.user.uid, email: this.user.email } : null;
  }

  /**
   * Check if sync is enabled
   */
  isSyncEnabled() {
    return this.syncEnabled && !!this.user;
  }

  /**
   * Cleanup
   */
  destroy() {
    this._stopRealtimeSync();
    this.removeAllListeners();
  }
}

module.exports = FirebaseSyncAdapter;
