import type { Metadata, Viewport } from "next";
import "./globals.css";
import { EXCALIDRAW_ASSET_PATH } from "@/lib/whiteboard/excalidrawAssetPath";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: "Teacher Playground",
  description: "A secure collaborative whiteboard classroom for teachers and students",
  /*
   * The offline shell's web-app manifest (OFF-01). The file itself ships as
   * a plain public/ asset; manifest-src falls back to default-src 'self' in
   * the Worker's CSP, so no policy change is needed to fetch it.
   */
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/*
          Excalidraw reads EXCALIDRAW_ASSET_PATH when its module initialises. It
          ships in its own webpack chunk, so import order in a component cannot
          guarantee we win that race — setting it there still left Excalidraw
          resolving fonts against its CDN, which font-src refuses (209 CJK
          subsets, reported ~230 times).

          Inline in <head> is the only placement that is reliably first. The
          Worker rewrites script tags to carry the CSP nonce, so this needs no
          'unsafe-inline'. Production resolves the immutable fork release on
          the R2 CDN; local and preview builds use the same-origin fallback.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.EXCALIDRAW_ASSET_PATH=${JSON.stringify(EXCALIDRAW_ASSET_PATH)}`,
          }}
        />
      </head>
      <body>
        {children}
        {/*
          * OFF-01: production-only service-worker registration for the
          * offline shell. Renders nothing; failures are swallowed by
          * contract, so a refused registration can never disturb a lesson.
          */}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
