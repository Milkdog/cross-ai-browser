/**
 * usePrompts Hook
 * Manages prompts state with real-time sync
 */

import { useState, useEffect, useCallback } from 'react';
import {
  subscribeToPrompts,
  subscribeToProjects,
  createPrompt,
  updatePrompt,
  deletePrompt,
  duplicatePrompt,
  toggleFavorite,
  markAsDone,
  markAsTesting,
  restorePrompt
} from '../services/prompts';
import { useAuth } from './useAuth';

export function usePrompts(projectId = null) {
  const { user } = useAuth();
  const [prompts, setPrompts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Subscribe to prompts
  useEffect(() => {
    if (!user) {
      setPrompts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = subscribeToPrompts(user.uid, projectId, (data) => {
      setPrompts(data);
      setLoading(false);
    });

    return unsubscribe;
  }, [user, projectId]);

  // Subscribe to projects
  useEffect(() => {
    if (!user) {
      setProjects([]);
      return;
    }

    const unsubscribe = subscribeToProjects(user.uid, (data) => {
      setProjects(data);
    });

    return unsubscribe;
  }, [user]);

  // Helper to organize prompts into sections
  // Order: Notes -> Reusable -> Regular -> Testing -> Done
  // Notes are a distinct item type with no lifecycle state.
  const organizedPrompts = useCallback(() => {
    const isNote = (p) => p.type === 'note';

    const sortWithFavoritesFirst = (a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    };

    // Notes: global first, then favorites, then order
    const notes = prompts
      .filter(isNote)
      .sort((a, b) => {
        if (a.scope === 'global' && b.scope !== 'global') return -1;
        if (a.scope !== 'global' && b.scope === 'global') return 1;
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
        return (a.order || 0) - (b.order || 0);
      });

    const promptItems = prompts.filter(p => !isNote(p));

    const reusable = promptItems
      .filter(p => p.reusable)
      .sort((a, b) => {
        if (a.scope === 'global' && b.scope !== 'global') return -1;
        if (a.scope !== 'global' && b.scope === 'global') return 1;
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
        return (a.order || 0) - (b.order || 0);
      });

    const regular = promptItems
      .filter(p => !p.reusable && !p.done && !p.testing)
      .sort(sortWithFavoritesFirst);

    const testing = promptItems
      .filter(p => !p.reusable && p.testing && !p.done)
      .sort((a, b) => {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
        return (b.testingStartedAt || 0) - (a.testingStartedAt || 0);
      });

    const done = promptItems
      .filter(p => !p.reusable && p.done)
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

    return { notes, reusable, regular, testing, done };
  }, [prompts]);

  // Get unique labels from all prompts
  const getAllLabels = useCallback(() => {
    const labelSet = new Set();
    prompts.forEach(p => {
      (p.labels || []).forEach(label => labelSet.add(label));
    });
    return Array.from(labelSet).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [prompts]);

  // CRUD operations
  const handleCreate = async (promptData) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    setError(null);
    const result = await createPrompt(user.uid, {
      ...promptData,
      projectId,
      order: prompts.length
    });

    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const handleUpdate = async (promptId, updates) => {
    setError(null);
    const result = await updatePrompt(promptId, updates);
    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const handleDelete = async (promptId) => {
    setError(null);
    const result = await deletePrompt(promptId);
    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const handleToggleFavorite = async (promptId) => {
    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt) return { success: false, error: 'Prompt not found' };
    return toggleFavorite(promptId, !prompt.isFavorite);
  };

  const handleMarkDone = async (promptId) => {
    return markAsDone(promptId);
  };

  const handleMarkTesting = async (promptId) => {
    return markAsTesting(promptId);
  };

  const handleRestore = async (promptId) => {
    return restorePrompt(promptId);
  };

  const handleDuplicate = async (promptId) => {
    if (!user) return { success: false, error: 'Not authenticated' };
    const source = prompts.find(p => p.id === promptId);
    if (!source) return { success: false, error: 'Prompt not found' };
    setError(null);
    const result = await duplicatePrompt(user.uid, source, prompts.length);
    if (!result.success) setError(result.error);
    return result;
  };

  const handleConvertType = async (promptId) => {
    const source = prompts.find(p => p.id === promptId);
    if (!source) return { success: false, error: 'Prompt not found' };
    const newType = source.type === 'note' ? 'prompt' : 'note';
    return updatePrompt(promptId, { type: newType });
  };

  return {
    prompts,
    projects,
    loading,
    error,
    organizedPrompts,
    getAllLabels,
    createPrompt: handleCreate,
    updatePrompt: handleUpdate,
    deletePrompt: handleDelete,
    duplicatePrompt: handleDuplicate,
    convertType: handleConvertType,
    toggleFavorite: handleToggleFavorite,
    markAsDone: handleMarkDone,
    markAsTesting: handleMarkTesting,
    restorePrompt: handleRestore
  };
}
