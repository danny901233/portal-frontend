import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReceptionMate - Voice AI Agent Platform",
  description: "Create and configure your custom voice AI agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
