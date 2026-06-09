/**
 * Prompts Service
 * Handles CRUD operations for prompts in Firestore
 */

import {
  collection,
  doc,
  setDoc,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  writeBatch
} from 'firebase/firestore';
import { db, isConfigured } from './firebase';

const PROMPTS_COLLECTION = 'prompts';
const PROJECTS_COLLECTION = 'projects';

/**
 * Subscribe to prompts for a user (real-time)
 * @param {string} userId
 * @param {string|null} projectId - Filter by project, or null for all
 * @param {function} callback - Called with prompts array
 * @returns {function} Unsubscribe function
 */
export function subscribeToPrompts(userId, projectId, callback) {
  if (!isConfigured) {
    callback([]);
    return () => {};
  }

  let q;
  if (projectId) {
    q = query(
      collection(db, PROMPTS_COLLECTION),
      where('userId', '==', userId),
      where('projectId', '==', projectId),
      orderBy('order', 'asc')
    );
  } else {
    q = query(
      collection(db, PROMPTS_COLLECTION),
      where('userId', '==', userId),
      orderBy('order', 'asc')
    );
  }

  return onSnapshot(q, (snapshot) => {
    const prompts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    callback(prompts);
  }, (error) => {
    console.error('Error subscribing to prompts:', error);
    callback([]);
  });
}

/**
 * Subscribe to projects for a user
 * @param {string} userId
 * @param {function} callback - Called with projects array
 * @returns {function} Unsubscribe function
 */
export function subscribeToProjects(userId, callback) {
  if (!isConfigured) {
    callback([]);
    return () => {};
  }

  const q = query(
    collection(db, PROJECTS_COLLECTION),
    where('userId', '==', userId),
    orderBy('name', 'asc')
  );

  return onSnapshot(q, (snapshot) => {
    const projects = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    callback(projects);
  }, (error) => {
    console.error('Error subscribing to projects:', error);
    callback([]);
  });
}

/**
 * Create a new prompt
 * @param {string} userId
 * @param {object} promptData
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function createPrompt(userId, promptData) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    const promptId = `prompt-${crypto.randomUUID()}`;
    const now = Date.now();
    const type = promptData.type === 'note' ? 'note' : 'prompt';
    const isNote = type === 'note';
    const docRef = doc(db, PROMPTS_COLLECTION, promptId);
    await setDoc(docRef, {
      userId,
      type,
      title: promptData.title || '',
      prompt: promptData.prompt || '',
      labels: promptData.labels || [],
      images: promptData.images || [],
      isFavorite: promptData.isFavorite || false,
      reusable: isNote ? false : (promptData.reusable || false),
      done: isNote ? false : (promptData.done || false),
      testing: isNote ? false : (promptData.testing || false),
      scope: promptData.scope || 'project',
      projectId: promptData.projectId || null,
      projectPath: promptData.projectPath || null,
      order: promptData.order || 0,
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now)
    });

    return { success: true, id: promptId };
  } catch (error) {
    console.error('Error creating prompt:', error);
    return { success: false, error: error.message };
  }
}

// Allowed fields for prompt updates (security: prevent userId injection)
const ALLOWED_UPDATE_FIELDS = [
  'title', 'prompt', 'labels', 'images', 'isFavorite',
  'reusable', 'done', 'testing', 'scope', 'order', 'projectId', 'projectPath', 'type'
];

/**
 * Update an existing prompt
 * @param {string} promptId
 * @param {object} updates
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updatePrompt(promptId, updates) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    // Filter to only allowed fields (prevent userId injection)
    const safeUpdates = {};
    for (const key of ALLOWED_UPDATE_FIELDS) {
      if (key in updates) {
        safeUpdates[key] = updates[key];
      }
    }

    // Notes can't carry prompt-lifecycle state. When an update converts to 'note',
    // force-strip those flags so the Firestore doc stays consistent.
    if (safeUpdates.type === 'note') {
      safeUpdates.reusable = false;
      safeUpdates.done = false;
      safeUpdates.testing = false;
    }

    const docRef = doc(db, PROMPTS_COLLECTION, promptId);
    await updateDoc(docRef, {
      ...safeUpdates,
      updatedAt: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    console.error('Error updating prompt:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a prompt
 * @param {string} promptId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deletePrompt(promptId) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    await deleteDoc(doc(db, PROMPTS_COLLECTION, promptId));
    return { success: true };
  } catch (error) {
    console.error('Error deleting prompt:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Duplicate a prompt. Matches desktop behaviour: "(copy)" title suffix,
 * reset done/testing, no image copy (avoid shared references).
 */
export async function duplicatePrompt(userId, prompt, orderFallback = 0) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }
  try {
    const newId = `prompt-${crypto.randomUUID()}`;
    const now = Date.now();
    const title = prompt.title ? `${prompt.title} (copy)` : '';
    const type = prompt.type === 'note' ? 'note' : 'prompt';
    const isNote = type === 'note';
    const docRef = doc(db, PROMPTS_COLLECTION, newId);
    await setDoc(docRef, {
      userId,
      type,
      title,
      prompt: prompt.prompt || '',
      labels: Array.isArray(prompt.labels) ? [...prompt.labels] : [],
      images: [],
      isFavorite: false,
      reusable: isNote ? false : (prompt.reusable || false),
      done: false,
      testing: false,
      scope: prompt.scope || 'project',
      projectId: prompt.projectId || null,
      projectPath: prompt.projectPath || null,
      order: typeof prompt.order === 'number' ? prompt.order + 0.5 : orderFallback,
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now)
    });
    return { success: true, id: newId };
  } catch (error) {
    console.error('Error duplicating prompt:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Reorder prompts
 * @param {Array<{id: string, order: number}>} orderUpdates
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function reorderPrompts(orderUpdates) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    const batch = writeBatch(db);

    for (const { id, order } of orderUpdates) {
      const docRef = doc(db, PROMPTS_COLLECTION, id);
      batch.update(docRef, { order, updatedAt: serverTimestamp() });
    }

    await batch.commit();
    return { success: true };
  } catch (error) {
    console.error('Error reordering prompts:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Toggle favorite status
 * @param {string} promptId
 * @param {boolean} isFavorite
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function toggleFavorite(promptId, isFavorite) {
  return updatePrompt(promptId, { isFavorite });
}

/**
 * Mark prompt as done
 * @param {string} promptId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function markAsDone(promptId) {
  return updatePrompt(promptId, { done: true, testing: false });
}

/**
 * Mark prompt as testing
 * @param {string} promptId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function markAsTesting(promptId) {
  return updatePrompt(promptId, { testing: true, done: false });
}

/**
 * Restore prompt (remove done/testing status)
 * @param {string} promptId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function restorePrompt(promptId) {
  return updatePrompt(promptId, { done: false, testing: false });
}

/**
 * Create or update a project
 * @param {string} userId
 * @param {object} projectData
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function createProject(userId, projectData) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    // Check if project with this path already exists
    const q = query(
      collection(db, PROJECTS_COLLECTION),
      where('userId', '==', userId),
      where('path', '==', projectData.path)
    );
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      // Project exists, return its ID
      return { success: true, id: snapshot.docs[0].id };
    }

    // Create new project
    const docRef = await addDoc(collection(db, PROJECTS_COLLECTION), {
      userId,
      name: projectData.name,
      path: projectData.path,
      pathHash: projectData.pathHash,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return { success: true, id: docRef.id };
  } catch (error) {
    console.error('Error creating project:', error);
    return { success: false, error: error.message };
  }
}
