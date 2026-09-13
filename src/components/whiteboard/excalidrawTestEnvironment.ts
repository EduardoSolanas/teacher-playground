import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let environmentInstalled = false;
let fetchHandler: FetchHandler = () => new Response(null, { status: 404 });

function installCanvasContext(): void {
  const contextFor = (canvas: HTMLCanvasElement): unknown => {
    const target: Record<string, unknown> = { canvas, filter: 'none' };
    return new Proxy(target, {
      get(object, property) {
        if (property in object) return object[property as string];
        if (property === 'measureText') {
          return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
        }
        if (property === 'getImageData') {
          return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        }
        if (property === 'createLinearGradient' || property === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        if (property === 'getLineDash') return () => [];
        if (property === 'isPointInPath' || property === 'isPointInStroke') return () => false;
        return () => {};
      },
      set(object, property, value) {
        object[property as string] = value;
        return true;
      },
    });
  };

  (HTMLCanvasElement.prototype as unknown as { getContext: (type: string) => unknown }).getContext =
    function getContext(this: HTMLCanvasElement) {
      return contextFor(this);
    };
}

function installResizeObserver(): void {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverShim;
}

function installPath2D(): void {
  class Path2DShim {
    constructor() {
      return new Proxy(
        {},
        {
          get: () => () => undefined,
        },
      );
    }
  }

  (globalThis as unknown as { Path2D: unknown }).Path2D = Path2DShim;
}

function installFontFace(): void {
  class FontFaceShim {
    family: string;
    source: string;

    constructor(family: string, source: string) {
      this.family = family;
      this.source = source;
    }

    async load(): Promise<FontFaceShim> {
      return this;
    }
  }

  (globalThis as unknown as { FontFace: unknown }).FontFace = FontFaceShim;

  if (!document.fonts) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        add() {},
        delete() {},
        has() {
          return false;
        },
        check() {
          return false;
        },
        load() {
          return Promise.resolve([]);
        },
        ready: Promise.resolve(),
        status: 'loaded',
      },
    });
  }
}

function installFetch(): void {
  (globalThis as unknown as {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }).fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return fetchHandler(url.href, init);
  };
}

function installDesktopLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 1024;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 768;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 1024;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 768;
    },
  });
  (Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    function getBoundingClientRect() {
      return new DOMRect(0, 0, 1024, 768);
    };
}

export function installExcalidrawTestEnvironment(): void {
  if (environmentInstalled) return;
  environmentInstalled = true;

  register(pathToFileURL(join(process.cwd(), 'src/components/whiteboard/excalidrawTestLoader.mjs')).href);
  installCanvasContext();
  installResizeObserver();
  installPath2D();
  installFontFace();
  installFetch();
  installDesktopLayout();
}

export function setFetchHandler(handler: FetchHandler): void {
  fetchHandler = handler;
}

export async function loadExcalidrawWrapper() {
  installExcalidrawTestEnvironment();
  const wrapperModule = await import('./ExcalidrawWrapper');
  return wrapperModule.default;
}

export async function loadExcalidrawPackage() {
  installExcalidrawTestEnvironment();
  return import('@teacher-playground/excalidraw');
}
