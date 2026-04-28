# Landing Page & Docs Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal Forge landing page with a dark-themed marketing page positioned as "the open-source software factory," and scaffold a Fumadocs-based docs site at `apps/docs`.

**Architecture:** The landing page uses Next.js route groups to separate the marketing page (`(marketing)/`) from the app console (`(app)/`), each with its own layout. The docs site is a standalone Next.js app in the monorepo using Fumadocs for MDX-based documentation with built-in search.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 3.4, shadcn/ui, Fumadocs (core + ui + mdx)

---

## Part 1: Landing Page

### Task 1: Restructure routes with route groups

Move the app header out of the root layout into an `(app)` route group layout, so the landing page can have its own layout without the app chrome.

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/(app)/layout.tsx`
- Move: `apps/web/src/app/missions/` → `apps/web/src/app/(app)/missions/`
- Move: `apps/web/src/app/login/` → `apps/web/src/app/(app)/login/`
- Move: `apps/web/src/app/signup/` → `apps/web/src/app/(app)/signup/`
- Move: `apps/web/src/app/api/` → `apps/web/src/app/(app)/api/`
- Delete: `apps/web/src/app/page.tsx`

- [ ] **Step 1: Create the (app) route group directory and layout**

Create `apps/web/src/app/(app)/layout.tsx` with the header extracted from the current root layout:

```tsx
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import { getOptionalUser } from '@/lib/with-auth';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getOptionalUser();

  return (
    <>
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-12 max-w-[1400px] items-center justify-between">
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-sm font-bold tracking-tight">
              Forge
            </Link>
            <Link
              href="/missions"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Missions
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <UserMenu name={user.name} email={user.email} />
            ) : (
              <Link
                href="/login"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
```

- [ ] **Step 2: Simplify the root layout**

Replace `apps/web/src/app/layout.tsx` with a minimal shell (html + body + globals only):

```tsx
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
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Move existing routes into (app) group**

```bash
mkdir -p apps/web/src/app/\(app\)
mv apps/web/src/app/missions apps/web/src/app/\(app\)/missions
mv apps/web/src/app/login apps/web/src/app/\(app\)/login
mv apps/web/src/app/signup apps/web/src/app/\(app\)/signup
mv apps/web/src/app/api apps/web/src/app/\(app\)/api
```

- [ ] **Step 4: Delete the old landing page**

```bash
rm apps/web/src/app/page.tsx
```

- [ ] **Step 5: Verify the app still works**

```bash
cd apps/web && pnpm build
```

Expected: Build succeeds. Routes `/missions`, `/login`, `/signup`, and `/api/*` still work (route groups don't affect URLs).

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/app/
git commit -m "refactor: use route groups to separate marketing and app layouts"
```

---

### Task 2: Build the landing page

Create the marketing layout and landing page with all five sections from the spec.

**Files:**
- Create: `apps/web/src/app/(marketing)/layout.tsx`
- Create: `apps/web/src/app/(marketing)/page.tsx`
- Create: `apps/web/src/app/(marketing)/_components/console-mock.tsx`

- [ ] **Step 1: Create the marketing layout**

Create `apps/web/src/app/(marketing)/layout.tsx`:

```tsx
import Link from 'next/link';

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark bg-[#09090b] text-[#fafafa]" style={{ colorScheme: 'dark' }}>
      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-[#1a1a1e] bg-[#09090b]/85 px-12 py-4 backdrop-blur-sm">
        <span className="text-base font-bold tracking-tight">Forge</span>
        <div className="flex items-center gap-6">
          <Link
            href="/docs"
            className="text-[13px] text-[#71717a] transition-colors hover:text-[#a1a1aa]"
          >
            Docs
          </Link>
          <Link
            href="https://github.com/anthropics/forge"
            className="text-[13px] text-[#71717a] transition-colors hover:text-[#a1a1aa]"
          >
            GitHub
          </Link>
          <Link
            href="https://github.com/anthropics/forge"
            className="rounded-md bg-[#fafafa] px-3.5 py-1.5 text-[13px] font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
          >
            ★ Star
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create the ConsoleMock component**

Create `apps/web/src/app/(marketing)/_components/console-mock.tsx`:

```tsx
function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-[3px] overflow-hidden rounded-full bg-[#27272a]">
      <div
        className="h-full rounded-full"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}

const missions = [
  { name: 'bump fast-glob', done: 138, total: 140, color: '#22c55e' },
  { name: 'add OTel spans', done: 24, total: 67, color: '#3b82f6' },
  { name: 'fix CVE-2024-4067', done: 8, total: 22, color: '#f59e0b' },
] as const;

export function ConsoleMock() {
  return (
    <div className="w-[260px] shrink-0 rounded-[10px] border border-[#27272a] bg-[#18181b] p-5">
      <div className="mb-4 text-[10px] uppercase tracking-widest text-[#52525b]">
        Mission Control
      </div>
      {missions.map((m) => (
        <div key={m.name} className="mb-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs text-[#a1a1aa]">{m.name}</span>
            <span className="text-[11px]" style={{ color: m.color }}>
              ● {m.done}/{m.total}
            </span>
          </div>
          <ProgressBar
            percent={Math.round((m.done / m.total) * 100)}
            color={m.color}
          />
        </div>
      ))}
      <div className="my-3.5 h-px bg-[#27272a]" />
      <div className="flex justify-between text-[11px]">
        <span className="text-[#52525b]">Budget</span>
        <span className="text-[#a1a1aa]">$12.40 / $50.00</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the landing page**

Create `apps/web/src/app/(marketing)/page.tsx`:

```tsx
import Link from 'next/link';

import { ConsoleMock } from './_components/console-mock';

const GITHUB_URL = 'https://github.com/anthropics/forge';

const steps = [
  { num: 1, name: 'Plan', desc: 'Define target repos.\nPreview tasks.\nSet budget.' },
  { num: 2, name: 'Dispatch', desc: 'Parallel agent sessions.\nOne per repo.\nConcurrency-controlled.' },
  { num: 3, name: 'Gate', desc: 'Open PRs.\nWait for CI.\nRetry on failure.' },
  { num: 4, name: 'Merge', desc: 'Auto-merge on pass.\nFlag for review.\nTrack in Ledger.' },
] as const;

export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto flex max-w-[960px] items-start justify-between gap-12 px-12 pb-20 pt-20">
        <div className="flex-1">
          <span className="mb-4 inline-block rounded-full border border-[#27272a] px-2.5 py-1 text-[11px] uppercase tracking-wide text-[#a1a1aa]">
            MIT Licensed
          </span>
          <h1 className="mb-5 text-[52px] font-semibold leading-[1.08] tracking-[-1.5px]">
            The open-source
            <br />
            software factory.
          </h1>
          <p className="mb-8 max-w-[440px] text-[17px] leading-relaxed text-[#71717a]">
            Orchestrate fleet-scale autonomous code changes. Every action in a
            ledger you own. Every dollar tracked.
          </p>
          <div className="flex gap-3">
            <Link
              href={GITHUB_URL}
              className="rounded-md bg-[#fafafa] px-5 py-2.5 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
            >
              ★ Star on GitHub
            </Link>
            <Link
              href="/docs/quickstart"
              className="rounded-md border border-[#27272a] px-5 py-2.5 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
            >
              Quickstart →
            </Link>
          </div>
        </div>
        <ConsoleMock />
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Value Props */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        {[
          ['Auditable.', 'Every action in an append-only ledger. Every state change queryable. You own the record.'],
          ['Budgeted.', 'Per-mission spend caps in dollars and tokens. Auto-pause before overrun. No surprises.'],
          ['Portable.', 'Claude Managed Agents or self-hosted gateway. Swap with one env var. No lock-in.'],
        ].map(([word, desc]) => (
          <div key={word} className="mb-8 flex items-baseline gap-5 last:mb-0">
            <span className="shrink-0 text-[32px] font-semibold tracking-tight">
              {word}
            </span>
            <span className="text-[15px] leading-normal text-[#71717a]">
              {desc}
            </span>
          </div>
        ))}
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* How a Mission Runs */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
          How a Mission runs
        </h2>
        <p className="mb-10 text-center text-sm text-[#71717a]">
          &ldquo;Bump fast-glob to ^3.3.2 across 140 repos&rdquo;
        </p>
        <div className="flex items-start gap-3">
          {steps.map((step, i) => (
            <div key={step.name} className="contents">
              <div className="flex-1 text-center">
                <div className="mb-2.5 rounded-lg border border-[#27272a] bg-[#18181b] px-3 py-[18px]">
                  <div className="mb-1 text-lg font-semibold text-[#52525b]">
                    {step.num}
                  </div>
                  <div className="text-sm font-semibold">{step.name}</div>
                </div>
                <p className="whitespace-pre-line text-[11px] leading-snug text-[#52525b]">
                  {step.desc}
                </p>
              </div>
              {i < steps.length - 1 && (
                <span className="mt-7 shrink-0 text-xl text-[#27272a]">→</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Why Open Source */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">
          Why open source
        </h2>
        <div className="mb-6">
          <p className="mb-4 text-[15px] leading-relaxed">
            Stripe runs 1,300 autonomous PRs per week with an internal tool
            their engineers built. That capability shouldn&rsquo;t require a
            $200/mo subscription and a proprietary black box.
          </p>
          <p className="text-[15px] leading-relaxed text-[#a1a1aa]">
            Forge is MIT-licensed fleet orchestration. The Ledger is in your
            database. The budget controls are in your config. The agent adapter
            is a single interface you can swap, extend, or replace.
          </p>
        </div>
        <blockquote className="border-l-2 border-[#27272a] pl-4">
          <p className="text-[13px] italic leading-normal text-[#71717a]">
            &ldquo;The primary reason the Minions work has almost nothing to do
            with the AI model. It has everything to do with the
            infrastructure.&rdquo;
          </p>
          <cite className="mt-1.5 block text-xs not-italic text-[#52525b]">
            — Patrick Collison, Stripe CEO
          </cite>
        </blockquote>
      </section>

      <hr className="border-[#1a1a1e]" />

      {/* Footer CTA */}
      <section className="px-12 py-20 text-center">
        <h2 className="mb-3 text-4xl font-semibold tracking-tight">
          Start a Mission.
        </h2>
        <p className="mb-8 text-[15px] text-[#71717a]">
          First Mission running in under 10 minutes. MIT licensed. Free forever.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            href={GITHUB_URL}
            className="rounded-md bg-[#fafafa] px-6 py-3 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
          >
            ★ Star on GitHub
          </Link>
          <Link
            href="/docs/quickstart"
            className="rounded-md border border-[#27272a] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
          >
            Quickstart →
          </Link>
        </div>
      </section>

      {/* Bottom Bar */}
      <div className="flex items-center justify-between border-t border-[#1a1a1e] px-12 py-5">
        <span className="text-xs text-[#52525b]">MIT License · Forge</span>
        <Link
          href={GITHUB_URL}
          className="text-xs text-[#52525b] transition-colors hover:text-[#71717a]"
        >
          GitHub
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Verify the landing page renders**

```bash
cd apps/web && pnpm dev
```

Open http://localhost:3100 — verify the landing page renders with all five sections, dark theme, sticky nav. Verify http://localhost:3100/missions still loads the app with its own header.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(marketing\)/
git commit -m "feat: add landing page — the open-source software factory"
```

---

### Task 3: Add responsive styles

Make the landing page work on mobile screens.

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx`
- Modify: `apps/web/src/app/(marketing)/layout.tsx`
- Modify: `apps/web/src/app/(marketing)/_components/console-mock.tsx`

- [ ] **Step 1: Make the hero stack on mobile**

In `apps/web/src/app/(marketing)/page.tsx`, update the hero section's container class:

Change:
```tsx
<section className="mx-auto flex max-w-[960px] items-start justify-between gap-12 px-12 pb-20 pt-20">
```
To:
```tsx
<section className="mx-auto flex max-w-[960px] flex-col items-start gap-12 px-6 pb-20 pt-20 md:flex-row md:justify-between md:px-12">
```

- [ ] **Step 2: Hide ConsoleMock on small screens**

In `apps/web/src/app/(marketing)/page.tsx`, add `hidden md:block` to the ConsoleMock wrapper:

Change:
```tsx
<ConsoleMock />
```
To:
```tsx
<div className="hidden md:block">
  <ConsoleMock />
</div>
```

- [ ] **Step 3: Make pipeline steps stack on mobile**

Update the flow steps container:

Change:
```tsx
<div className="flex items-start gap-3">
```
To:
```tsx
<div className="grid grid-cols-2 gap-4 md:flex md:items-start md:gap-3">
```

Hide the arrows on mobile by adding a class to the arrow spans:

Change:
```tsx
<span className="mt-7 shrink-0 text-xl text-[#27272a]">→</span>
```
To:
```tsx
<span className="mt-7 hidden shrink-0 text-xl text-[#27272a] md:block">→</span>
```

- [ ] **Step 4: Reduce horizontal padding on mobile**

Update all section containers to use `px-6 md:px-12` instead of `px-12`. Update nav padding similarly.

In `apps/web/src/app/(marketing)/layout.tsx`, change:
```tsx
<nav className="sticky top-0 z-50 flex items-center justify-between border-b border-[#1a1a1e] bg-[#09090b]/85 px-12 py-4 backdrop-blur-sm">
```
To:
```tsx
<nav className="sticky top-0 z-50 flex items-center justify-between border-b border-[#1a1a1e] bg-[#09090b]/85 px-6 py-4 backdrop-blur-sm md:px-12">
```

In `apps/web/src/app/(marketing)/page.tsx`, apply `px-6 md:px-12` to:
- Value props section
- Mission flow section
- Why open source section
- Footer CTA section
- Bottom bar

- [ ] **Step 5: Reduce hero headline size on mobile**

Change:
```tsx
<h1 className="mb-5 text-[52px] font-semibold leading-[1.08] tracking-[-1.5px]">
```
To:
```tsx
<h1 className="mb-5 text-[36px] font-semibold leading-[1.08] tracking-[-1.5px] md:text-[52px]">
```

- [ ] **Step 6: Verify on mobile viewport**

Open http://localhost:3100 in a browser, toggle responsive mode to ~375px width. Verify:
- Hero stacks vertically, ConsoleMock is hidden
- Pipeline steps display as 2x2 grid
- All text is readable, no horizontal overflow
- Nav is compact

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(marketing\)/
git commit -m "feat: add responsive styles to landing page"
```

---

## Part 2: Docs Site

### Task 4: Scaffold the Fumadocs app

Set up the `apps/docs` package with Fumadocs, Tailwind, and the dark theme.

**Files:**
- Create: `apps/docs/package.json`
- Create: `apps/docs/tsconfig.json`
- Create: `apps/docs/next.config.mjs`
- Create: `apps/docs/postcss.config.mjs`
- Create: `apps/docs/tailwind.config.ts`
- Create: `apps/docs/source.config.ts`
- Create: `apps/docs/src/app/layout.tsx`
- Create: `apps/docs/src/app/globals.css`
- Create: `apps/docs/src/app/layout.config.tsx`
- Create: `apps/docs/src/app/docs/[[...slug]]/page.tsx`
- Create: `apps/docs/src/lib/source.ts`

- [ ] **Step 1: Create package.json**

Create `apps/docs/package.json`:

```json
{
  "name": "@forge/docs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3200",
    "build": "next build",
    "start": "next start --port 3200",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fumadocs-core": "^15.0.0",
    "fumadocs-mdx": "^11.0.0",
    "fumadocs-ui": "^15.0.0",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `apps/docs/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },
    "isolatedModules": true
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts", ".source/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create source.config.ts**

Create `apps/docs/source.config.ts`:

```ts
import { defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
});
```

- [ ] **Step 4: Create next.config.mjs**

Create `apps/docs/next.config.mjs`:

```js
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {};

export default withMDX(config);
```

- [ ] **Step 5: Create PostCSS config**

Create `apps/docs/postcss.config.mjs`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 6: Create Tailwind config**

Create `apps/docs/tailwind.config.ts`:

```ts
import { createPreset } from 'fumadocs-ui/tailwind-plugin';
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
    './content/**/*.mdx',
    './node_modules/fumadocs-ui/dist/**/*.js',
  ],
  presets: [createPreset()],
};

export default config;
```

- [ ] **Step 7: Create globals.css**

Create `apps/docs/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Create the source loader**

Create `apps/docs/src/lib/source.ts`:

```ts
import { docs } from '@/../.source';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
```

- [ ] **Step 9: Create layout.config.tsx**

Create `apps/docs/src/app/layout.config.tsx`:

```tsx
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: 'Forge',
    url: '/',
  },
  links: [
    {
      text: 'GitHub',
      url: 'https://github.com/anthropics/forge',
    },
  ],
};
```

- [ ] **Step 10: Create root layout**

Create `apps/docs/src/app/layout.tsx`:

```tsx
import { RootProvider } from 'fumadocs-ui/provider';
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
```

- [ ] **Step 11: Create the docs catch-all page**

Create `apps/docs/src/app/docs/[[...slug]]/page.tsx`:

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';

import { source } from '@/lib/source';

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
```

- [ ] **Step 12: Create the docs layout**

Create `apps/docs/src/app/docs/layout.tsx`:

```tsx
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';

import { baseOptions } from '@/app/layout.config';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.pageTree} {...baseOptions}>
      {children}
    </DocsLayout>
  );
}
```

- [ ] **Step 13: Create a root redirect**

Create `apps/docs/src/app/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/docs');
}
```

- [ ] **Step 14: Install dependencies and verify build**

```bash
cd apps/docs && pnpm install
```

Don't build yet — we need at least one content file first (Task 5).

- [ ] **Step 15: Commit**

```bash
git add apps/docs/
git commit -m "feat: scaffold Fumadocs docs site at apps/docs"
```

---

### Task 5: Write Getting Started content

Create the first three docs pages — enough to verify the docs site builds and link from the landing page Quickstart CTA.

**Files:**
- Create: `apps/docs/content/docs/index.mdx`
- Create: `apps/docs/content/docs/quickstart.mdx`
- Create: `apps/docs/content/docs/configuration.mdx`
- Create: `apps/docs/content/docs/meta.json`

- [ ] **Step 1: Create the sidebar structure**

Create `apps/docs/content/docs/meta.json`:

```json
{
  "title": "Docs",
  "pages": [
    "---Getting Started---",
    "index",
    "quickstart",
    "configuration",
    "---Concepts---",
    "missions-and-tasks",
    "ledger",
    "budget-controls",
    "skills",
    "retrospectives",
    "backend-adapters",
    "---Architecture---",
    "system-overview",
    "state-machine",
    "gate-lifecycle",
    "---Guides---",
    "writing-a-skill",
    "deploying-to-cloud-run",
    "connecting-gateway",
    "---API Reference---",
    "api-missions",
    "api-tasks",
    "api-webhooks",
    "---Contributing---",
    "development-setup",
    "project-conventions",
    "testing"
  ]
}
```

- [ ] **Step 2: Create the introduction page**

Create `apps/docs/content/docs/index.mdx`:

```mdx
---
title: Introduction
description: What is Forge, who it's for, and how it works.
---

Forge is an open-source orchestration layer for fleet-scale autonomous code changes. It accepts a **Mission** — like "bump fast-glob across 140 repos" — plans it into parallel **Tasks**, dispatches each to an autonomous agent session, opens PRs, gates on CI and review, and auto-merges when safe.

## Who is Forge for?

- **Platform / DevEx engineers** who own the "upgrade all services" problem
- **Engineering managers** who need fleet-scale agents with auditability and cost control
- **Open-source maintainers** fleet-fixing their own repos

## What Forge is not

- Not an IDE plugin or coding assistant (use Claude Code, Cursor, or Copilot for that)
- Not a sandbox or agent engine — it orchestrates existing agent backends
- Not a CI system or code review tool — it integrates with yours

## Key concepts

- **Mission** — a high-level goal ("bump this dependency everywhere")
- **Task** — one unit of work (one repo, one PR)
- **Ledger** — append-only audit trail of every action
- **Skill** — a declarative playbook agents follow
- **Gate** — the PR → CI → merge lifecycle

## Backend adapters

Forge runs on [Claude Managed Agents](https://docs.anthropic.com/en/docs/agents) by default. Swap to a self-hosted gateway with one environment variable.

## Next steps

- [Quickstart](/docs/quickstart) — first Mission in under 10 minutes
- [Configuration](/docs/configuration) — environment variables and credentials
```

- [ ] **Step 3: Create the quickstart page**

Create `apps/docs/content/docs/quickstart.mdx`. Derive the content from the project's actual setup steps — read `README.md`, `.env.example`, and `package.json` scripts to write accurate instructions:

```mdx
---
title: Quickstart
description: Get your first Mission running in under 10 minutes.
---

## Prerequisites

- Node.js 22+
- pnpm 10+
- An [Anthropic API key](https://console.anthropic.com/)
- A [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope

## Install

```bash
git clone https://github.com/anthropics/forge.git
cd forge
pnpm install
```

## Configure

```bash
cp .env.example .env.local
```

Edit `.env.local` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
```

See [Configuration](/docs/configuration) for all available options.

## Start the dev servers

```bash
pnpm dev
```

This starts both the web console (port 3100) and the tick service.

## Create your first Mission

1. Open http://localhost:3100
2. Click **New Mission**
3. Describe your change — e.g., "Bump fast-glob to ^3.3.2"
4. Add target repositories
5. Set a budget (start small — $5 is enough for a test)
6. Review the generated tasks
7. Start the Mission

The tick service will dispatch agents, open PRs, and track progress. Watch it in the Mission Control console.
```

- [ ] **Step 4: Create the configuration page**

Create `apps/docs/content/docs/configuration.mdx`. Read the project's `.env.example` to list actual variables:

```mdx
---
title: Configuration
description: Environment variables and credential setup.
---

Forge is configured via environment variables. Copy `.env.example` to `.env.local` for local development.

## Required variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude Managed Agents |
| `GITHUB_TOKEN` | GitHub personal access token with `repo` scope |

## Database

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | libSQL database URL | `file:local.db` (local SQLite) |
| `DATABASE_AUTH_TOKEN` | Turso auth token (production only) | — |

## Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKEND_ADAPTER` | `managed-agents` or `gateway` | `managed-agents` |
| `GATEWAY_URL` | URL of self-hosted AgentStep Gateway | — |
| `PORT` | Web server port | `3100` |

## Production deployment

For production on Cloud Run or similar, see [Deploying to Cloud Run](/docs/deploying-to-cloud-run).
```

- [ ] **Step 5: Verify the docs site builds and renders**

```bash
cd apps/docs && pnpm build
```

Expected: Build succeeds. Then:

```bash
pnpm dev
```

Open http://localhost:3200/docs — verify the introduction page renders with sidebar, search, and dark theme.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/content/
git commit -m "docs: add getting started content — introduction, quickstart, configuration"
```

---

### Task 6: Write Concepts content

Create the six concept pages. Derive content from reading the actual source code: `packages/db/src/schema.ts` for data models, `apps/tick/src/` for subsystem behavior, `skills/` for skill format.

**Files:**
- Create: `apps/docs/content/docs/missions-and-tasks.mdx`
- Create: `apps/docs/content/docs/ledger.mdx`
- Create: `apps/docs/content/docs/budget-controls.mdx`
- Create: `apps/docs/content/docs/skills.mdx`
- Create: `apps/docs/content/docs/retrospectives.mdx`
- Create: `apps/docs/content/docs/backend-adapters.mdx`

- [ ] **Step 1: Read the source for data models and behavior**

Read these files to understand the actual implementation before writing docs:

```bash
cat packages/db/src/schema.ts
cat apps/tick/src/state.ts
cat apps/tick/src/tick.ts
ls skills/
cat skills/dependency-bump/SKILL.md
cat apps/tick/src/adapters/
cat prompts/retrospective.md
```

- [ ] **Step 2: Write missions-and-tasks.mdx**

Create `apps/docs/content/docs/missions-and-tasks.mdx` covering:
- Mission lifecycle: `draft → planning → running → (paused) → completed/cancelled`
- Task lifecycle: `queued → dispatching → running → turn_ended → opening_pr → awaiting_ci → merging → merged`
- Concurrency control
- DAG dependencies (v3)
- The relationship: one Mission has many Tasks

Use state diagrams (Fumadocs supports mermaid via a plugin, or use text-based diagrams). Derive all status values from the actual schema.

- [ ] **Step 3: Write ledger.mdx**

Create `apps/docs/content/docs/ledger.mdx` covering:
- What the Ledger is (append-only event log)
- Event types (derive from schema)
- Role tags: forge, model, agent, session
- Querying events by Mission or Task
- Why append-only matters for auditability

- [ ] **Step 4: Write budget-controls.mdx**

Create `apps/docs/content/docs/budget-controls.mdx` covering:
- Per-Mission budgets (USD and tokens)
- Auto-pause at threshold (default 80%)
- Raising budget (allowed) vs. lowering below spent (not allowed)
- How costs accrue from backend usage events

- [ ] **Step 5: Write skills.mdx**

Create `apps/docs/content/docs/skills.mdx` covering:
- What a Skill is (declarative playbook)
- File format with an example from an actual skill
- Goal templates with `{{variables}}`
- Step-by-step instructions
- Tool restrictions
- The four bundled skills: dependency-bump, codemod-rollout, ci-fix, forge-dev

- [ ] **Step 6: Write retrospectives.mdx**

Create `apps/docs/content/docs/retrospectives.mdx` covering:
- What triggers a retrospective
- How the analyst agent works (read-only, scoped to Ledger)
- Output: skill diffs + memory entries
- Review gate: operator accepts/edits/rejects
- Memory schema: scope, key, value, confidence, expiry

- [ ] **Step 7: Write backend-adapters.mdx**

Create `apps/docs/content/docs/backend-adapters.mdx` covering:
- The BackendAdapter interface
- Managed Agents adapter (default)
- AgentStep Gateway adapter
- Swapping with `BACKEND_ADAPTER` env var
- Contract tests ensuring interchangeability

- [ ] **Step 8: Verify build**

```bash
cd apps/docs && pnpm build
```

Expected: Build succeeds with all six new pages in the sidebar.

- [ ] **Step 9: Commit**

```bash
git add apps/docs/content/docs/
git commit -m "docs: add concepts content — missions, ledger, budgets, skills, retrospectives, adapters"
```

---

### Task 7: Write Architecture content

**Files:**
- Create: `apps/docs/content/docs/system-overview.mdx`
- Create: `apps/docs/content/docs/state-machine.mdx`
- Create: `apps/docs/content/docs/gate-lifecycle.mdx`

- [ ] **Step 1: Read the architecture source**

```bash
cat apps/tick/src/tick.ts
cat apps/tick/src/state.ts
cat apps/tick/src/subsystems/gate.ts
cat apps/tick/src/subsystems/dispatcher.ts
cat AGENTS.md
```

- [ ] **Step 2: Write system-overview.mdx**

Cover: two services (forge-web + forge-tick), stateless design, tick subsystems (poller, dispatcher, gate, budgets, reconciler), Cloud Run deployment model, database (libSQL/Turso).

- [ ] **Step 3: Write state-machine.mdx**

Cover: pure `transition(status, event) → delta` function, Mission lifecycle state diagram, Task lifecycle state diagram. Include the actual transition table from `state.ts`.

- [ ] **Step 4: Write gate-lifecycle.mdx**

Cover: PR creation on `session.turn.ended`, CI polling via Checks API, retry-with-feedback (up to 3 retries), auto-merge on success, flag-for-review flow.

- [ ] **Step 5: Verify and commit**

```bash
cd apps/docs && pnpm build
git add apps/docs/content/docs/
git commit -m "docs: add architecture content — system overview, state machine, gate lifecycle"
```

---

### Task 8: Write Guides content

**Files:**
- Create: `apps/docs/content/docs/writing-a-skill.mdx`
- Create: `apps/docs/content/docs/deploying-to-cloud-run.mdx`
- Create: `apps/docs/content/docs/connecting-gateway.mdx`

- [ ] **Step 1: Write writing-a-skill.mdx**

Walk through creating a custom Skill from scratch. Use the actual skill file format from `skills/dependency-bump/SKILL.md` as a reference. Cover: file structure, goal template variables, constraints, tool restrictions, testing locally.

- [ ] **Step 2: Write deploying-to-cloud-run.mdx**

Cover: Docker build (`output: 'standalone'` in next.config), Cloud Run service setup for both web and tick, Cloud Scheduler configuration (60s POST), Turso database provisioning, environment variables for production.

- [ ] **Step 3: Write connecting-gateway.mdx**

Cover: what AgentStep Gateway is, setting `BACKEND_ADAPTER=gateway` and `GATEWAY_URL`, running the contract test suite, differences from Managed Agents.

- [ ] **Step 4: Verify and commit**

```bash
cd apps/docs && pnpm build
git add apps/docs/content/docs/
git commit -m "docs: add guides — writing skills, deploying, connecting gateway"
```

---

### Task 9: Write API Reference content

**Files:**
- Create: `apps/docs/content/docs/api-missions.mdx`
- Create: `apps/docs/content/docs/api-tasks.mdx`
- Create: `apps/docs/content/docs/api-webhooks.mdx`

- [ ] **Step 1: Read the actual API routes**

```bash
ls apps/web/src/app/api/
# Read each route handler to document actual endpoints, request/response shapes
```

- [ ] **Step 2: Write api-missions.mdx**

Document every Mission endpoint: method, path, request body (with Zod schema), response shape, status codes. Derive from actual route handlers.

- [ ] **Step 3: Write api-tasks.mdx**

Document every Task endpoint similarly.

- [ ] **Step 4: Write api-webhooks.mdx**

Document the incoming webhook format from Managed Agents: event types, payload schema, verification, how Forge processes each event type.

- [ ] **Step 5: Verify and commit**

```bash
cd apps/docs && pnpm build
git add apps/docs/content/docs/
git commit -m "docs: add API reference — missions, tasks, webhooks"
```

---

### Task 10: Write Contributing content

**Files:**
- Create: `apps/docs/content/docs/development-setup.mdx`
- Create: `apps/docs/content/docs/project-conventions.mdx`
- Create: `apps/docs/content/docs/testing.mdx`

- [ ] **Step 1: Write development-setup.mdx**

Cover: prerequisites (Node 22, pnpm 10), clone, install, env setup, running `pnpm dev`, project structure overview. Derive from `AGENTS.md` and root `package.json`.

- [ ] **Step 2: Write project-conventions.mdx**

Cover: TypeScript strict mode, Prettier formatting, conventional commits, ESLint config, code organization patterns. Derive from `AGENTS.md`.

- [ ] **Step 3: Write testing.mdx**

Cover: Vitest, the "no mocking" philosophy, pure function extraction, running `pnpm test`, writing new tests. Derive from `AGENTS.md` and existing test files.

- [ ] **Step 4: Verify final build**

```bash
cd apps/docs && pnpm build
```

Expected: All 20 pages build successfully, sidebar shows all sections.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs/
git commit -m "docs: add contributing content — setup, conventions, testing"
```

---

### Task 11: Wire up landing page links

Update the landing page nav and CTA links to point to the docs site.

**Files:**
- Modify: `apps/web/src/app/(marketing)/layout.tsx`
- Modify: `apps/web/src/app/(marketing)/page.tsx`

- [ ] **Step 1: Update docs link in nav**

In `apps/web/src/app/(marketing)/layout.tsx`, update the Docs link `href` to point to the docs site URL (e.g., `http://localhost:3200/docs` in dev, `https://docs.forge.dev` in production). For now, use a relative `/docs` that can be configured later:

No change needed — the link already points to `/docs`. When deploying, this will be handled by a reverse proxy or subdomain routing.

- [ ] **Step 2: Update Quickstart link**

In `apps/web/src/app/(marketing)/page.tsx`, verify the Quickstart buttons link to `/docs/quickstart`. They already do — no change needed.

- [ ] **Step 3: Verify both apps run together**

```bash
pnpm dev
```

Open http://localhost:3100 (landing page) and http://localhost:3200/docs (docs). Verify nav links work as expected.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: verify landing page and docs site integration"
```
