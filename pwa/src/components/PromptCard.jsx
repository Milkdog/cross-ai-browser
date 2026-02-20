/**
 * Prompt Card Component
 * Displays a single prompt with actions
 */

import { useState } from 'react';

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

// Globe icon for global scope
const GlobeIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

// Folder icon for project scope
const FolderIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export default function PromptCard({
  prompt,
  compact,
  onEdit,
  onDelete,
  onToggleFavorite,
  onMarkDone,
  onMarkTesting,
  onRestore
}) {
  const [showActions, setShowActions] = useState(false);

  // Truncate prompt text for preview
  const previewText = prompt.prompt?.length > 100
    ? prompt.prompt.substring(0, 100) + '...'
    : prompt.prompt;

  const compactPreviewText = prompt.prompt?.length > 60
    ? prompt.prompt.substring(0, 60) + '...'
    : prompt.prompt;

  // Compact layout for reusable prompts
  if (compact) {
    return (
      <div
        className="bg-app-surface border border-app-border rounded-lg px-3 py-2 hover:border-app-accent/50 transition-colors"
        onClick={() => onEdit()}
      >
        <div className="flex items-center gap-2">
          {/* Scope icon */}
          <span className={prompt.scope === 'global' ? 'text-emerald-400' : 'text-blue-400'} title={prompt.scope === 'global' ? 'Global' : 'Project'}>
            {prompt.scope === 'global' ? <GlobeIcon /> : <FolderIcon />}
          </span>

          {/* Title or preview */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {prompt.title ? (
              <span className="font-medium text-app-text text-sm truncate">{prompt.title}</span>
            ) : (
              <span className="text-app-text-muted text-sm truncate">{compactPreviewText || 'No content'}</span>
            )}

            {/* Inline badges */}
            {prompt.isFavorite && <span className="text-yellow-400 text-xs">★</span>}
            {prompt.images?.length > 0 && (
              <span className="text-app-text-muted text-xs">📷{prompt.images.length}</span>
            )}
          </div>

          {/* Actions */}
          <div className="flex-shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {onToggleFavorite && (
              <button
                onClick={onToggleFavorite}
                className={`p-1.5 rounded-lg transition-colors ${
                  prompt.isFavorite
                    ? 'text-yellow-400'
                    : 'text-app-text-muted hover:text-yellow-400'
                }`}
              >
                {prompt.isFavorite ? '★' : '☆'}
              </button>
            )}

            <div className="relative">
              <button
                onClick={() => setShowActions(!showActions)}
                className="p-1.5 text-app-text-muted hover:text-app-text rounded-lg transition-colors"
              >
                ⋮
              </button>

              {showActions && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowActions(false)} />
                  <div className="absolute right-0 top-full mt-1 w-40 bg-app-surface border border-app-border rounded-lg shadow-lg overflow-hidden z-50">
                    <button
                      onClick={() => { onEdit(); setShowActions(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      ✏️ Edit
                    </button>
                    <div className="border-t border-app-border" />
                    <button
                      onClick={() => { onDelete(); setShowActions(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-app-bg transition-colors"
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      </div>
    );
  }

  // Standard layout for non-reusable prompts
  return (
    <div
      className="bg-app-surface border border-app-border rounded-lg p-4 hover:border-app-accent/50 transition-colors"
      onClick={() => onEdit()}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Content */}
        <div className="flex-1 min-w-0">
          {prompt.title && (
            <h3 className="font-medium text-app-text mb-1 truncate">
              {prompt.title}
            </h3>
          )}
          <p className="text-sm text-app-text-muted line-clamp-2 whitespace-pre-wrap">
            {previewText || 'No content'}
          </p>
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Favorite */}
          {onToggleFavorite && (
            <button
              onClick={onToggleFavorite}
              className={`p-2 rounded-lg transition-colors ${
                prompt.isFavorite
                  ? 'text-yellow-400'
                  : 'text-app-text-muted hover:text-yellow-400'
              }`}
              title={prompt.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              {prompt.isFavorite ? '★' : '☆'}
            </button>
          )}

          {/* More actions */}
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-2 text-app-text-muted hover:text-app-text rounded-lg transition-colors"
            >
              ⋮
            </button>

            {showActions && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowActions(false)}
                />
                <div className="absolute right-0 top-full mt-1 w-40 bg-app-surface border border-app-border rounded-lg shadow-lg overflow-hidden z-50">
                  <button
                    onClick={() => {
                      onEdit();
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                  >
                    ✏️ Edit
                  </button>

                  {onMarkTesting && !prompt.testing && !prompt.done && (
                    <button
                      onClick={() => {
                        onMarkTesting();
                        setShowActions(false);
                      }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      🧪 Mark Testing
                    </button>
                  )}

                  {onMarkDone && !prompt.done && (
                    <button
                      onClick={() => {
                        onMarkDone();
                        setShowActions(false);
                      }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      ✓ Mark Done
                    </button>
                  )}

                  {onRestore && (prompt.done || prompt.testing) && (
                    <button
                      onClick={() => {
                        onRestore();
                        setShowActions(false);
                      }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      ↩️ Restore
                    </button>
                  )}

                  <div className="border-t border-app-border" />

                  <button
                    onClick={() => {
                      onDelete();
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-app-bg transition-colors"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Labels */}
      {prompt.labels?.length > 0 && (
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {prompt.labels.map(label => {
            const colorIndex = getLabelColorIndex(label);
            const colors = LABEL_COLORS[colorIndex];
            return (
              <span
                key={label}
                className="px-2 py-0.5 text-xs rounded font-medium"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              >
                {label}
              </span>
            );
          })}
        </div>
      )}

      {/* Images indicator */}
      {prompt.images?.length > 0 && (
        <div className="flex items-center gap-1 mt-2 text-xs text-app-text-muted">
          <span>📷</span>
          <span>{prompt.images.length} image{prompt.images.length > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
}
