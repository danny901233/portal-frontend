import type { Metadata } from 'next';
import '../../globals.css';

export const metadata: Metadata = {
  title: 'Chat Widget',
  description: 'ReceptionMate Chat Widget',
};

export default function WidgetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          html, body {
            width: 100%;
            max-width: 100vw;
            overflow-x: hidden;
            overflow-y: hidden;
            background: transparent;
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}


