import { useEffect, useState } from 'react';

interface PosterBackdropProps {
  /** Poster image URL, or null to show the gradient placeholder. */
  posterUrl: string | null;
  /** Fallback placeholder colour (used as a gradient anchor). */
  placeholderColor?: string;
  /** When false the backdrop is hidden (poster faded out). */
  visible: boolean;
}

/**
 * PosterBackdrop — blurred poster image covering the viewer mount area.
 *
 * - Keeps correct aspect ratio (object-fit: cover) so the poster never
 *   distorts.
 * - If the poster fails to load (onError), swaps to the project-owned
 *   gradient so loading is never blocked by a missing image.
 * - `visible=false` triggers the fade-out; the element stays mounted so the
 *   transition is a CSS opacity transition (honours prefers-reduced-motion).
 * - pointer-events: none — never takes input or acts as a 3D hit target.
 */
export function PosterBackdrop({ posterUrl, placeholderColor, visible }: PosterBackdropProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // reset when the poster URL changes
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [posterUrl]);

  const showPoster = posterUrl && !failed;
  const showGradient = !showPoster;
  const gradient = placeholderColor
    ? `radial-gradient(circle at 30% 30%, ${placeholderColor}, #0b111f 70%)`
    : 'radial-gradient(circle at 30% 30%, #1a2a3a, #0b111f 70%)';

  return (
    <div
      className="gs-viewer__poster-backdrop"
      data-testid="poster-backdrop"
      aria-hidden="true"
      style={{ opacity: visible ? 1 : 0, pointerEvents: 'none' }}
    >
      {showPoster && (
        <img
          src={posterUrl}
          alt=""
          className="gs-viewer__poster-img"
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {showGradient && (
        <div className="gs-viewer__poster-gradient" style={{ background: gradient }} />
      )}
      {showPoster && !loaded && (
        <div className="gs-viewer__poster-gradient" style={{ background: gradient }} />
      )}
    </div>
  );
}
