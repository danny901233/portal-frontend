import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";
import Providers from "./providers";
import AppShell from "./components/AppShell";

export const metadata: Metadata = {
  title: "ReceptionMate Portal",
  description: "Operational dashboard for LiveKit AI call logs",
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