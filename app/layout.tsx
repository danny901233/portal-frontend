import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";
import Providers from "./providers";
import AppShell from "./components/AppShell";

export const metadata: Metadata = {
  title: "ReceptionMate Portal",
  description: "Operational dashboard for AI call logs",
};

// viewport-fit=cover makes the iOS safe-area insets resolve to real values so
// the fixed bottom nav clears the home indicator / rounded corners instead of
// being clipped (env(safe-area-inset-*) is 0 without this).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const headersList = await headers();
  const pathname = headersList.get('x-pathname') || '';
  const isWidget = pathname.startsWith('/widget/');
  const isChat = pathname.startsWith('/chat/');

  if (isWidget || isChat) {
    return (
      <html lang="en">
        <head>
          <style>{`
            :root, html, body { color-scheme: light !important; background: transparent !important; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { overflow: hidden; }
          `}</style>
        </head>
        <body>{children}</body>
      </html>
    );
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}