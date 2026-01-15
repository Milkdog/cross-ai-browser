/**
 * Prompt Card Component
 * Displays a single prompt with actions
 */

import { useState } from 'react';

export default function PromptCard({
  prompt,
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
          {prompt.labels.map(label => (
            <span
              key={label}
              className="px-2 py-0.5 bg-app-bg text-app-text-muted text-xs rounded"
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Images indicator */}
      {prompt.images?.length > 0 && (
        <div className="flex items-center gap-1 mt-2 text-xs text-app-text-muted">
          <span>📷</span>
          <span>{prompt.images.length} image{prompt.images.length > 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Status badges */}
      <div className="flex gap-2 mt-2">
        {prompt.reusable && (
          <span className="px-2 py-0.5 bg-blue-900/30 text-blue-400 text-xs rounded">
            Reusable
          </span>
        )}
        {prompt.scope === 'global' && (
          <span className="px-2 py-0.5 bg-purple-900/30 text-purple-400 text-xs rounded">
            Global
          </span>
        )}
      </div>
    </div>
  );
}
