// Plain TypeScript package — no React, no Next, so this uses typescript-eslint
// directly rather than apps/web's eslint-config-next.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const config = [
  {
    // migrations/ is drizzle-kit generated SQL and metadata — not hand-written
    // and not worth linting. Everything else, drizzle.config.ts included, is.
    ignores: ['node_modules/**', 'migrations/**', 'dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Matches apps/web: a leading underscore marks a deliberately-unused
      // binding, so the two packages agree on the convention.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
