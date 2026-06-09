/**
 * Label colors shared between PromptCard and PromptModal.
 * Prefers the synced per-user registry (desktop's assigned colors); falls back
 * to a deterministic hash so unknown labels still render consistently.
 */

export const LABEL_COLORS = [
  { bg: '#6366f1', text: '#ffffff' },  // Indigo
  { bg: '#8b5cf6', text: '#ffffff' },  // Violet
  { bg: '#d946ef', text: '#ffffff' },  // Fuchsia
  { bg: '#ec4899', text: '#ffffff' },  // Pink
  { bg: '#f43f5e', text: '#ffffff' },  // Rose
  { bg: '#ef4444', text: '#ffffff' },  // Red
  { bg: '#f97316', text: '#ffffff' },  // Orange
  { bg: '#eab308', text: '#1a1a20' },  // Yellow
  { bg: '#22c55e', text: '#ffffff' },  // Green
  { bg: '#14b8a6', text: '#ffffff' },  // Teal
  { bg: '#06b6d4', text: '#1a1a20' },  // Cyan
  { bg: '#3b82f6', text: '#ffffff' },  // Blue
];

function hashIndex(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash) + label.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % LABEL_COLORS.length;
}

export function resolveLabelColor(label, labelColors) {
  const registryIdx = labelColors && typeof labelColors[label] === 'number'
    ? labelColors[label]
    : null;
  const idx = registryIdx !== null
    ? (registryIdx % LABEL_COLORS.length + LABEL_COLORS.length) % LABEL_COLORS.length
    : hashIndex(label);
  return LABEL_COLORS[idx];
}
