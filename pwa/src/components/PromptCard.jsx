/**
 * Prompt Card Component
 * Displays a single prompt with actions
 */

import { useState } from 'react';
import ImageThumbnail from './ImageThumbnail';
import { LABEL_COLORS, resolveLabelColor } from '../utils/labelColors';

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
  labelColors,
  onEdit,
  onDelete,
  onDuplicate,
  onConvertType,
  onToggleFavorite,
  onMarkDone,
  onMarkTesting,
  onRestore
}) {
  const [showActions, setShowActions] = useState(false);
  const isNote = prompt.type === 'note';

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
              <span className="flex items-center gap-1 flex-shrink-0">
                <ImageThumbnail
                  imageId={prompt.images[0].id}
                  filename={prompt.images[0].filename}
                  size={20}
                />
                {prompt.images.length > 1 && (
                  <span className="text-app-text-muted text-xs">+{prompt.images.length - 1}</span>
                )}
              </span>
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
      className={`bg-app-surface border border-app-border rounded-lg p-4 hover:border-app-accent/50 transition-colors ${
        isNote ? 'border-l-4 border-l-sky-500' : ''
      }`}
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
          <p className={`text-sm text-app-text-muted ${
            isNote ? 'truncate' : 'line-clamp-2 whitespace-pre-wrap'
          }`}>
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

                  {/* Lifecycle actions only apply to prompts, not notes */}
                  {!isNote && onMarkTesting && !prompt.testing && !prompt.done && (
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

                  {!isNote && onMarkDone && !prompt.done && (
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

                  {!isNote && onRestore && (prompt.done || prompt.testing) && (
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

                  {onDuplicate && (
                    <button
                      onClick={() => { onDuplicate(); setShowActions(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      ⎘ Duplicate
                    </button>
                  )}

                  {onConvertType && (
                    <button
                      onClick={() => { onConvertType(); setShowActions(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
                    >
                      ↔ {isNote ? 'Convert to Prompt' : 'Convert to Note'}
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
            const colors = resolveLabelColor(label, labelColors);
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

      {/* Image thumbnail strip */}
      {prompt.images?.length > 0 && (
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {prompt.images.slice(0, 5).map(img => (
            <ImageThumbnail
              key={img.id}
              imageId={img.id}
              filename={img.filename}
              size={44}
            />
          ))}
          {prompt.images.length > 5 && (
            <span className="text-xs text-app-text-muted self-center">
              +{prompt.images.length - 5} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
