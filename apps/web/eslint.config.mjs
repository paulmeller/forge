// eslint-config-next v16 ships native flat configs, so these are imported
// directly. The previous FlatCompat shim (a legacy-eslintrc → flat bridge)
// throws "Converting circular structure to JSON" when handed an already-flat
// config, which is what broke `pnpm lint` after the Next.js 16 upgrade.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'content/**', '.source/**'],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // This codebase marks deliberately-unused bindings with a leading
      // underscore (e.g. adapter methods that accept a parameter only to
      // satisfy the shared BackendAdapter interface). Honour that convention
      // rather than reporting every one of them.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
