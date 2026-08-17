import type { Metadata } from "next";
import "./globals.css";
import { AccessSessionBootstrap } from "../components/AccessSessionBootstrap";

export const metadata: Metadata = {
  title: "Whiteboard",
  description: "Real-time collaborative whiteboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body><AccessSessionBootstrap>{children}</AccessSessionBootstrap></body>
    </html>
  );
}
