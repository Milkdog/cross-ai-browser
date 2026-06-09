/**
 * Labels Service
 * Syncs the user's label registry (shared with the desktop app) via Firestore.
 * Single doc per user at `userLabels/{uid}` with { userId, labels[], labelColors{} }.
 */

import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, isConfigured } from './firebase';

const USER_LABELS_COLLECTION = 'userLabels';
const MAX_LABELS = 50;
const MAX_LABEL_LENGTH = 30;
const NUM_COLORS = 12;

export function subscribeToLabels(userId, callback) {
  if (!isConfigured || !userId) {
    callback({ labels: [], labelColors: {} });
    return () => {};
  }
  const ref = doc(db, USER_LABELS_COLLECTION, userId);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      callback({ labels: [], labelColors: {} });
      return;
    }
    const data = snap.data();
    callback({
      labels: Array.isArray(data.labels) ? data.labels : [],
      labelColors: data.labelColors || {}
    });
  }, (err) => {
    console.error('Error subscribing to labels:', err);
    callback({ labels: [], labelColors: {} });
  });
}

async function writeLabels(userId, labels, labelColors) {
  const ref = doc(db, USER_LABELS_COLLECTION, userId);
  await setDoc(ref, {
    userId,
    labels,
    labelColors,
    updatedAt: serverTimestamp()
  });
}

/**
 * Pick the least-used color index (matches desktop's _getNextColorIndex).
 */
function nextColorIndex(labelColors) {
  const counts = new Array(NUM_COLORS).fill(0);
  for (const idx of Object.values(labelColors || {})) {
    if (typeof idx === 'number' && idx >= 0 && idx < NUM_COLORS) counts[idx]++;
  }
  let minCount = Infinity;
  let minIndex = 0;
  counts.forEach((c, i) => {
    if (c < minCount) {
      minCount = c;
      minIndex = i;
    }
  });
  return minIndex;
}

export async function addLabel(userId, name, currentLabels, currentColors) {
  if (!isConfigured || !userId) return { success: false, error: 'Not configured' };
  const trimmed = (name || '').trim();
  if (!trimmed) return { success: false, error: 'Label name is required' };
  if (trimmed.length > MAX_LABEL_LENGTH) {
    return { success: false, error: `Label must be ${MAX_LABEL_LENGTH} characters or less` };
  }
  const labels = Array.isArray(currentLabels) ? [...currentLabels] : [];
  const labelColors = { ...(currentColors || {}) };
  if (labels.includes(trimmed)) return { success: true, skipped: true };
  if (labels.length >= MAX_LABELS) {
    return { success: false, error: `Maximum of ${MAX_LABELS} labels` };
  }
  labels.push(trimmed);
  labelColors[trimmed] = nextColorIndex(labelColors);
  try {
    await writeLabels(userId, labels, labelColors);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function deleteLabel(userId, name, currentLabels, currentColors) {
  if (!isConfigured || !userId) return { success: false, error: 'Not configured' };
  const labels = (currentLabels || []).filter(l => l !== name);
  const labelColors = { ...(currentColors || {}) };
  delete labelColors[name];
  try {
    await writeLabels(userId, labels, labelColors);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Ensure any labels referenced by a prompt exist in the registry, assigning
 * colors as needed. Safe to call before/after save.
 */
export async function ensureLabelsRegistered(userId, usedLabels, currentLabels, currentColors) {
  if (!isConfigured || !userId) return { success: false };
  const labels = Array.isArray(currentLabels) ? [...currentLabels] : [];
  const labelColors = { ...(currentColors || {}) };
  let changed = false;
  for (const name of usedLabels || []) {
    const trimmed = (name || '').trim();
    if (!trimmed || labels.includes(trimmed)) continue;
    if (labels.length >= MAX_LABELS) break;
    labels.push(trimmed);
    labelColors[trimmed] = nextColorIndex(labelColors);
    changed = true;
  }
  if (!changed) return { success: true, skipped: true };
  try {
    await writeLabels(userId, labels, labelColors);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
