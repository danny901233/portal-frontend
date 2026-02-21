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


