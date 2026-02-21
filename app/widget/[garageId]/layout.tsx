import type { Metadata } from 'next';
import '../../../globals.css';

export const metadata: Metadata = {
  title: 'Chat Widget',
  description: 'ReceptionMate Chat Widget',
};

export default function WidgetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}


