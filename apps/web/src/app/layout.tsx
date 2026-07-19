import { RootProvider } from 'fumadocs-ui/provider';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Forge — Software Factory',
  description: 'GitHub Issues in. Pull Requests out. Your backlog, on autopilot.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans antialiased">
        <RootProvider theme={{ storageKey: 'forge-theme' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
