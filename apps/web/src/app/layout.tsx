import { RootProvider } from 'fumadocs-ui/provider';
import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Forge',
  description: 'Open-source Missions for Claude Managed Agents.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('forge-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
