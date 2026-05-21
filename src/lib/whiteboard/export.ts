import type { Stage } from 'react-konva';
import type { CanvasElement, Viewport } from '@/types/whiteboard';

export type ExportOptions = {
  scale?: 1 | 2 | 4;
  filename?: string;
  format?: 'png' | 'svg';
  quality?: number;
};

export function getExportScale(): 1 | 2 | 4 {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio || 1;
  if (ratio >= 2) return 4;
  if (ratio >= 1.5) return 2;
  return 1;
}

export async function exportCanvasToPNG(
  stage: any,
  options: ExportOptions = {}
): Promise<Blob> {
  const scale = options.scale || getExportScale();
  const quality = options.quality ?? 0.92;

  const canvas = stage.toCanvas({ pixelRatio: scale });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob: Blob | null) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create blob from canvas'));
      }
    }, 'image/png', quality);
  });
}

export async function exportCanvasToSVG(
  stage: any,
  _options: ExportOptions = {}
): Promise<string> {
  const konvaStage = stage._stage || stage;
  const layer = konvaStage.children?.[0];
  if (layer && typeof layer.toSVG === 'function') {
    return layer.toSVG();
  }
  // Fallback: empty SVG wrapper
  return `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export function getElementsBoundingBox(
  elements: CanvasElement[]
): { x: number; y: number; width: number; height: number } | null {
  if (elements.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    if (el.type === 'pen' || el.type === 'line' || el.type === 'arrow') {
      const points = (el as any).points || [];
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    } else if ('x' in el && 'y' in el && 'width' in el && 'height' in el) {
      const x = el.x as number;
      const y = el.y as number;
      const w = el.width as number;
      const h = el.height as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
  }

  if (!isFinite(minX) || !isFinite(minY)) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
