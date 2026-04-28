import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: { template: '%s | Forge Docs', default: 'Forge Docs' },
  description: 'Documentation for Forge — open-source fleet-scale autonomous code changes.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider
          theme={{ defaultTheme: 'dark', forcedTheme: 'dark' }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
