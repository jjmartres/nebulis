import { useEffect, useState } from 'react';
import { DEFAULT_FOCAL_POINT, getImageFocalPoint, type FocalPoint } from '../lib/imageFocalPoint';

/** Where to center a blurred/zoomed ambient copy of `src` so the crop lands
 *  on the image's actual subject instead of the geometric center. Resets to
 *  dead center immediately on a src change so the ambient background never
 *  flashes the previous picture's focal point while the new one is sampled. */
export function useImageFocalPoint(src: string | null): FocalPoint {
  const [focalPoint, setFocalPoint] = useState<FocalPoint>(DEFAULT_FOCAL_POINT);

  useEffect(() => {
    if (!src) {
      setFocalPoint(DEFAULT_FOCAL_POINT);
      return;
    }
    let cancelled = false;
    setFocalPoint(DEFAULT_FOCAL_POINT);
    getImageFocalPoint(src).then((point) => {
      if (!cancelled) setFocalPoint(point);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return focalPoint;
}
