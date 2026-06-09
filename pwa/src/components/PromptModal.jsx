/**
 * Prompt Modal Component
 * Full-screen create/edit prompt modal with stacked layout
 */

import { useState, useRef, useEffect } from 'react';
import { resolveLabelColor } from '../utils/labelColors';
import ImageThumbnail from './ImageThumbnail';
import { uploadImageWithThumbnail, generateImageId, deleteImage } from '../services/images';
import { useAuth } from '../hooks/useAuth';

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export default function PromptModal({ prompt, allLabels, labelColors, onSave, onClose }) {
  const { user } = useAuth();
  const [type, setType] = useState(prompt?.type === 'note' ? 'note' : 'prompt');
  const [title, setTitle] = useState(prompt?.title || '');
  const [content, setContent] = useState(prompt?.prompt || '');
  const [labels, setLabels] = useState(prompt?.labels || []);
  const [labelInput, setLabelInput] = useState('');
  const [reusable, setReusable] = useState(prompt?.reusable || false);
  const [scope, setScope] = useState(prompt?.scope || 'project');
  const [saving, setSaving] = useState(false);

  const isNote = type === 'note';

  // Images: existing (already uploaded, have id) + staged (local file, pending upload)
  const [existingImages, setExistingImages] = useState(prompt?.images || []);
  const [stagedImages, setStagedImages] = useState([]); // { id, file, previewUrl, filename, size }
  const [removedImageIds, setRemovedImageIds] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Label suggestions
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const labelInputRef = useRef(null);

  // Global prompts are always reusable (except notes, which can't be reusable)
  const isGlobal = scope === 'global';
  useEffect(() => {
    if (isNote) {
      if (reusable) setReusable(false);
      return;
    }
    if (isGlobal && !reusable) {
      setReusable(true);
    }
  }, [scope, isGlobal, reusable, isNote]);

  // Clean up object URLs when staged images change/unmount
  useEffect(() => {
    return () => {
      stagedImages.forEach(img => {
        if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalImageCount = existingImages.length + stagedImages.length;

  const filteredSuggestions = labelInput
    ? allLabels.filter(
        l => l.toLowerCase().includes(labelInput.toLowerCase()) && !labels.includes(l)
      )
    : [];

  const stageFiles = (files) => {
    setUploadError(null);
    const accepted = [];
    for (const file of files) {
      if (!file.type?.startsWith('image/')) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setUploadError(`${file.name} exceeds 5 MB limit`);
        continue;
      }
      if (totalImageCount + accepted.length >= MAX_IMAGES) {
        setUploadError(`Max ${MAX_IMAGES} images per prompt`);
        break;
      }
      accepted.push({
        id: generateImageId(),
        file,
        previewUrl: URL.createObjectURL(file),
        filename: file.name,
        size: file.size
      });
    }
    if (accepted.length > 0) {
      setStagedImages(prev => [...prev, ...accepted]);
    }
  };

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files || []);
    stageFiles(files);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    stageFiles(files);
  };

  const removeStagedImage = (id) => {
    setStagedImages(prev => {
      const target = prev.find(img => img.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(img => img.id !== id);
    });
  };

  const removeExistingImage = (id) => {
    setExistingImages(prev => prev.filter(img => img.id !== id));
    setRemovedImageIds(prev => [...prev, id]);
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setUploadError(null);

    try {
      // Upload staged images first
      const uploadedImages = [];
      for (const staged of stagedImages) {
        const result = await uploadImageWithThumbnail(user.uid, staged.file, staged.id);
        if (!result.success) {
          setUploadError(`Upload failed: ${result.error}`);
          setSaving(false);
          return;
        }
        uploadedImages.push(result.image);
      }

      // Best-effort delete removed image blobs
      for (const id of removedImageIds) {
        try { await deleteImage(user.uid, id); } catch {}
      }

      const mergedImages = [...existingImages, ...uploadedImages];

      await onSave({
        type,
        title,
        prompt: content,
        labels,
        reusable: isNote ? false : reusable,
        scope,
        images: mergedImages
      });

      // Revoke preview URLs after successful save
      stagedImages.forEach(img => {
        if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
      });
    } finally {
      setSaving(false);
    }
  };

  const addLabelValue = (label) => {
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
        addLabelValue(filteredSuggestions[highlightedIndex]);
      } else if (labelInput.trim()) {
        addLabelValue(labelInput);
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
          {prompt
            ? (isNote ? 'Edit Note' : 'Edit Prompt')
            : (isNote ? 'New Note' : 'New Prompt')}
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
        {/* Type selector */}
        <div className="inline-flex gap-0.5 p-0.5 bg-app-bg border border-app-border rounded-lg">
          {['prompt', 'note'].map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                type === t
                  ? 'bg-app-accent text-white'
                  : 'text-app-text-muted hover:text-app-text'
              }`}
            >
              {t === 'prompt' ? 'Prompt' : 'Note'}
            </button>
          ))}
        </div>

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

        {/* Content textarea (label/placeholder change for notes) */}
        <div className="flex-1">
          <label className="block text-xs text-app-text-muted mb-1">
            {isNote ? 'Content' : 'Prompt'}
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={isNote
              ? 'Note content — saved commands, snippets, reference...'
              : 'Enter your prompt...'}
            className="w-full min-h-[200px] p-3 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent resize-y"
            autoFocus
          />
        </div>

        {/* Images */}
        <div>
          <label className="block text-xs text-app-text-muted mb-1">
            Images ({totalImageCount}/{MAX_IMAGES})
          </label>

          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-3 transition-colors ${
              isDragOver
                ? 'border-app-accent bg-app-accent/10'
                : 'border-app-border bg-app-surface'
            }`}
          >
            {totalImageCount > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {existingImages.map(img => (
                  <div key={img.id} className="relative group">
                    <ImageThumbnail imageId={img.id} filename={img.filename} size={64} />
                    <button
                      type="button"
                      onClick={() => removeExistingImage(img.id)}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {stagedImages.map(img => (
                  <div key={img.id} className="relative group">
                    <img
                      src={img.previewUrl}
                      alt={img.filename}
                      className="w-16 h-16 object-cover rounded border border-app-border"
                    />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1 rounded-b truncate">
                      new
                    </span>
                    <button
                      type="button"
                      onClick={() => removeStagedImage(img.id)}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={totalImageCount >= MAX_IMAGES}
                className="px-3 py-1.5 text-sm bg-app-bg border border-app-border rounded hover:border-app-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                + Add images
              </button>
              <span className="text-xs text-app-text-muted">
                drop files here · max 5 MB each
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileInput}
                className="hidden"
              />
            </div>
          </div>

          {uploadError && (
            <p className="mt-1 text-xs text-red-400">{uploadError}</p>
          )}
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
                const colors = resolveLabelColor(label, labelColors);
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
                    onClick={() => addLabelValue(suggestion)}
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

          {/* Reusable checkbox (hidden for notes — they can't be reusable) */}
          {!isNote && (
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
          )}
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
