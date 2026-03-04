import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Chat',
  description: 'Chat with AI Assistant',
};

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
