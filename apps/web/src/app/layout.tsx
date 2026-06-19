import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AutoEdit AI',
  description: 'AI-powered video editing automation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
