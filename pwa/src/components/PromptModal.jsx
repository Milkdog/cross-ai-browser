/**
 * Prompt Modal Component
 * Full-screen create/edit prompt modal with stacked layout
 */

import { useState, useRef, useEffect } from 'react';

// Label colors matching design-tokens.js
const LABEL_COLORS = [
  { bg: '#6366f1', text: '#ffffff' },  // Indigo
  { bg: '#8b5cf6', text: '#ffffff' },  // Violet
  { bg: '#d946ef', text: '#ffffff' },  // Fuchsia
  { bg: '#ec4899', text: '#ffffff' },  // Pink
  { bg: '#f43f5e', text: '#ffffff' },  // Rose
  { bg: '#ef4444', text: '#ffffff' },  // Red
  { bg: '#f97316', text: '#ffffff' },  // Orange
  { bg: '#eab308', text: '#1a1a20' },  // Yellow (dark text)
  { bg: '#22c55e', text: '#ffffff' },  // Green
  { bg: '#14b8a6', text: '#ffffff' },  // Teal
  { bg: '#06b6d4', text: '#1a1a20' },  // Cyan (dark text)
  { bg: '#3b82f6', text: '#ffffff' },  // Blue
];

// Generate a deterministic color index from label name
function getLabelColorIndex(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % LABEL_COLORS.length;
}

export default function PromptModal({ prompt, allLabels, onSave, onClose }) {
  const [title, setTitle] = useState(prompt?.title || '');
  const [content, setContent] = useState(prompt?.prompt || '');
  const [labels, setLabels] = useState(prompt?.labels || []);
  const [labelInput, setLabelInput] = useState('');
  const [reusable, setReusable] = useState(prompt?.reusable || false);
  const [scope, setScope] = useState(prompt?.scope || 'project');
  const [saving, setSaving] = useState(false);

  // Label suggestions
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const labelInputRef = useRef(null);

  // Global prompts are always reusable
  const isGlobal = scope === 'global';
  useEffect(() => {
    if (isGlobal && !reusable) {
      setReusable(true);
    }
  }, [scope, isGlobal, reusable]);

  const filteredSuggestions = labelInput
    ? allLabels.filter(
        l => l.toLowerCase().includes(labelInput.toLowerCase()) && !labels.includes(l)
      )
    : [];

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      title,
      prompt: content,
      labels,
      reusable,
      scope
    });
    setSaving(false);
  };

  const addLabel = (label) => {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed) && labels.length < 5) {
      setLabels([...labels, trimmed]);
    }
    setLabelInput('');
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  const removeLabel = (label) => {
    setLabels(labels.filter(l => l !== label));
  };

  const handleLabelKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && filteredSuggestions[highlightedIndex]) {
        addLabel(filteredSuggestions[highlightedIndex]);
      } else if (labelInput.trim()) {
        addLabel(labelInput);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev =>
        prev < filteredSuggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  return (
    <div className="fixed inset-0 bg-app-bg z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface flex-shrink-0">
        <h2 className="font-semibold text-app-text">
          {prompt ? 'Edit Prompt' : 'New Prompt'}
        </h2>
        <button
          onClick={onClose}
          className="p-2 text-app-text-muted hover:text-app-text transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Body - Stacked Layout */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Title */}
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional title"
            className="w-full px-3 py-2 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent"
          />
        </div>

        {/* Prompt Content - Large textarea */}
        <div className="flex-1">
          <label className="block text-xs text-app-text-muted mb-1">Prompt</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Enter your prompt..."
            className="w-full min-h-[300px] p-3 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent resize-none"
            style={{ height: 'calc(100vh - 420px)', minHeight: '200px' }}
            autoFocus
          />
        </div>

        {/* Labels */}
        <div>
          <label className="block text-xs text-app-text-muted mb-1">
            Labels ({labels.length}/5)
          </label>

          {/* Current labels */}
          {labels.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {labels.map(label => {
                const colorIndex = getLabelColorIndex(label);
                const colors = LABEL_COLORS[colorIndex];
                return (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded-full font-medium"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  >
                    {label}
                    <button
                      onClick={() => removeLabel(label)}
                      className="ml-1 opacity-70 hover:opacity-100 transition-opacity"
                      style={{ color: colors.text }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Label input with suggestions */}
          <div className="relative">
            <input
              ref={labelInputRef}
              type="text"
              value={labelInput}
              onChange={(e) => {
                setLabelInput(e.target.value);
                setShowSuggestions(true);
                setHighlightedIndex(-1);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onKeyDown={handleLabelKeyDown}
              placeholder={labels.length >= 5 ? 'Max labels reached' : 'Add label...'}
              disabled={labels.length >= 5}
              className="w-full px-3 py-2 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent disabled:opacity-50"
            />

            {/* Suggestions dropdown */}
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-app-surface border border-app-border rounded-lg overflow-hidden z-10 max-h-40 overflow-y-auto shadow-lg">
                {filteredSuggestions.map((suggestion, idx) => (
                  <button
                    key={suggestion}
                    onClick={() => addLabel(suggestion)}
                    className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                      idx === highlightedIndex
                        ? 'bg-app-accent text-white'
                        : 'text-app-text hover:bg-app-bg'
                    }`}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Scope & Options Row */}
        <div className="flex flex-wrap gap-4 items-center">
          {/* Scope */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-app-text-muted">Scope:</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="px-3 py-2 bg-app-surface border border-app-border rounded-lg text-app-text text-sm focus:outline-none focus:border-app-accent"
            >
              <option value="project">Project</option>
              <option value="global">Global</option>
            </select>
          </div>

          {/* Reusable checkbox */}
          <label className={`flex items-center gap-2 ${isGlobal ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={reusable}
              onChange={(e) => setReusable(e.target.checked)}
              disabled={isGlobal}
              className="w-4 h-4 rounded border-app-border bg-app-surface text-app-accent focus:ring-app-accent disabled:cursor-not-allowed"
            />
            <span className="text-sm text-app-text">Reusable</span>
            <span className="text-xs text-app-text-muted">
              {isGlobal ? '(global prompts are always reusable)' : '(stays active after use)'}
            </span>
          </label>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-app-border bg-app-surface flex-shrink-0">
        <button
          onClick={onClose}
          className="px-4 py-2 text-app-text-muted hover:text-app-text transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !content.trim()}
          className="px-5 py-2 bg-app-accent hover:bg-app-accent-hover text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
