import type { Metadata, Viewport } from "next";
import "./globals.css";
import { EXCALIDRAW_ASSET_PATH } from "@/lib/whiteboard/excalidrawAssetPath";

export const metadata: Metadata = {
  title: "Teacher Playground",
  description: "A secure collaborative whiteboard classroom for teachers and students",
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
      <body>{children}</body>
    </html>
  );
}
