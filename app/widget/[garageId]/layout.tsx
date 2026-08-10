import type { Metadata } from 'next';

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
            overflow: hidden;
            background: transparent !important;
            color-scheme: light;
          }
        `}</style>
      </head>
      <body style={{ background: 'transparent' }}>{children}</body>
    </html>
  );
}


