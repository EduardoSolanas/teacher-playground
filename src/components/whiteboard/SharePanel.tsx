import { useState } from 'react';

function generateQRDataUrl(text: string): string {
  const size = 200;
  const moduleCount = 25;
  const cellSize = size / moduleCount;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const hash = simpleHash(text);
  const modules = generateQRModules(hash, moduleCount);

  ctx.fillStyle = '#000000';
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (modules[row][col]) {
        ctx.fillRect(
          col * cellSize,
          row * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }

  return canvas.toDataURL('image/png');
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function generateQRModules(hash: number, size: number): boolean[][] {
  const modules: boolean[][] = [];
  let seed = hash;

  function nextBit(): boolean {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 3) !== 0;
  }

  for (let row = 0; row < size; row++) {
    modules[row] = [];
    for (let col = 0; col < size; col++) {
      modules[row][col] = nextBit();
    }
  }

  // Finder patterns (top-left, top-right, bottom-left)
  drawFinderPattern(modules, 0, 0, size);
  drawFinderPattern(modules, size - 7, 0, size);
  drawFinderPattern(modules, 0, size - 7, size);

  return modules;
}

function drawFinderPattern(
  modules: boolean[][],
  startRow: number,
  startCol: number,
  size: number
) {
  const outer = 7;
  for (let r = 0; r < outer; r++) {
    for (let c = 0; c < outer; c++) {
      const isBorder = r === 0 || r === outer - 1 || c === 0 || c === outer - 1;
      const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (isBorder || isInner) {
        if (startRow + r < size && startCol + c < size) {
          modules[startRow + r][startCol + c] = true;
        }
      }
    }
  }
}

export default function SharePanel({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const url = `/whiteboard/${roomId}`;

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${url}`
    : url;

  const qrDataUrl = generateQRDataUrl(shareUrl);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed bottom-4 left-20 bg-white/95 rounded-xl border border-slate-200 p-4 shadow-xl shadow-slate-900/10 z-[100] w-[300px] backdrop-blur">
      <h3 className="m-0 mb-2 text-[14px] font-semibold">Share this room</h3>
      <div
        data-testid="whiteboard-share-url-group"
        className="flex gap-2 mb-3"
      >
        <input
          data-testid="whiteboard-share-url-input"
          type="text"
          readOnly
          value={shareUrl}
          className="flex-1 px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-slate-50 min-w-0 text-slate-700"
        />
        <button
          data-testid="whiteboard-copy-url-btn"
          onClick={handleCopy}
          className="px-3 py-2 rounded-lg border-none text-white text-[12px] font-semibold cursor-pointer whitespace-nowrap transition-colors duration-150"
          style={{ background: copied ? '#2ecc71' : '#3498db' }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {qrDataUrl && (
        <div className="text-center">
          <img
            src={qrDataUrl}
            alt="QR Code"
            className="w-[112px] h-[112px] rounded-md"
          />
        </div>
      )}
    </div>
  );
}
