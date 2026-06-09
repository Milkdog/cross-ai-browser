/**
 * ImageThumbnail
 * Lazy-loads a thumbnail from Firebase Storage using the user's UID + image ID.
 * Shows a placeholder while loading and if the blob is missing (e.g. desktop
 * authored an image that hasn't been synced to Storage yet).
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getImageUrl, getThumbnailUrl } from '../services/images';

export default function ImageThumbnail({ imageId, filename, size = 48, onClick, useFullSize = false }) {
  const { user } = useAuth();
  const [url, setUrl] = useState(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    if (!user || !imageId) return;
    const fetcher = useFullSize ? getImageUrl : getThumbnailUrl;
    fetcher(user.uid, imageId).then(r => {
      if (cancelled) return;
      if (r.success && r.url) {
        setUrl(r.url);
        setStatus('ready');
      } else {
        // If the thumbnail is missing, fall back to original.
        if (!useFullSize) {
          getImageUrl(user.uid, imageId).then(r2 => {
            if (cancelled) return;
            if (r2.success && r2.url) {
              setUrl(r2.url);
              setStatus('ready');
            } else {
              setStatus('missing');
            }
          });
        } else {
          setStatus('missing');
        }
      }
    });
    return () => { cancelled = true; };
  }, [user, imageId, useFullSize]);

  const style = { width: size, height: size };

  if (status === 'loading') {
    return <div style={style} className="rounded bg-app-border animate-pulse" />;
  }
  if (status === 'missing') {
    return (
      <div
        style={style}
        title={`${filename || imageId} (not synced)`}
        className="rounded bg-app-border flex items-center justify-center text-app-text-muted text-xs"
      >
        ⏳
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={filename || imageId}
      style={style}
      onClick={onClick}
      className="rounded object-cover cursor-pointer border border-app-border"
    />
  );
}
