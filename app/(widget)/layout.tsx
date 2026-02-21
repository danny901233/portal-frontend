import type { ReactNode } from 'react';
import '../globals.css';

export default function WidgetRootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <style>{`
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            overflow: hidden;
          }
        `}</style>
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
