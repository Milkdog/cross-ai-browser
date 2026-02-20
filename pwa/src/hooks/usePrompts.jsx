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
  // Order: Reusable -> Regular -> Testing -> Done
  // Within Reusable: global first, then project, then favorites
  const organizedPrompts = useCallback(() => {
    // Sort helper: favorites first, then by order
    const sortWithFavoritesFirst = (a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    };

    // Reusable prompts: global first, then project, then favorites within each
    const reusable = prompts
      .filter(p => p.reusable)
      .sort((a, b) => {
        // Global prompts first
        if (a.scope === 'global' && b.scope !== 'global') return -1;
        if (a.scope !== 'global' && b.scope === 'global') return 1;
        // Then favorites
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
        return (a.order || 0) - (b.order || 0);
      });

    // Non-reusable prompts can be in regular, testing, or done
    const regular = prompts
      .filter(p => !p.reusable && !p.done && !p.testing)
      .sort(sortWithFavoritesFirst);

    const testing = prompts
      .filter(p => !p.reusable && p.testing && !p.done)
      .sort((a, b) => {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
        return (b.testingStartedAt || 0) - (a.testingStartedAt || 0);
      });

    const done = prompts
      .filter(p => !p.reusable && p.done)
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

    return { reusable, regular, testing, done };
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
    toggleFavorite: handleToggleFavorite,
    markAsDone: handleMarkDone,
    markAsTesting: handleMarkTesting,
    restorePrompt: handleRestore
  };
}
