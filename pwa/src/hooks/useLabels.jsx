/**
 * useLabels Hook
 * Subscribes to the user's label registry (synced with the desktop app).
 */

import { useState, useEffect, useCallback } from 'react';
import { subscribeToLabels, addLabel, deleteLabel, ensureLabelsRegistered } from '../services/labels';
import { useAuth } from './useAuth';

export function useLabels() {
  const { user } = useAuth();
  const [labels, setLabels] = useState([]);
  const [labelColors, setLabelColors] = useState({});

  useEffect(() => {
    if (!user) {
      setLabels([]);
      setLabelColors({});
      return;
    }
    const unsub = subscribeToLabels(user.uid, ({ labels, labelColors }) => {
      setLabels(labels);
      setLabelColors(labelColors);
    });
    return unsub;
  }, [user]);

  const add = useCallback((name) => {
    if (!user) return Promise.resolve({ success: false, error: 'Not authenticated' });
    return addLabel(user.uid, name, labels, labelColors);
  }, [user, labels, labelColors]);

  const remove = useCallback((name) => {
    if (!user) return Promise.resolve({ success: false, error: 'Not authenticated' });
    return deleteLabel(user.uid, name, labels, labelColors);
  }, [user, labels, labelColors]);

  const ensure = useCallback((names) => {
    if (!user) return Promise.resolve({ success: false });
    return ensureLabelsRegistered(user.uid, names, labels, labelColors);
  }, [user, labels, labelColors]);

  return { labels, labelColors, addLabel: add, deleteLabel: remove, ensureLabels: ensure };
}
