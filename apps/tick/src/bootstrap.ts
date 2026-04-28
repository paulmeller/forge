import { config as loadDotenv } from 'dotenv';

// Loaded as a side-effect import. MUST be the first import in src/index.ts
// so process.env is populated before env.ts evaluates its module body.
//
// Why dotenv (not Node's --env-file): Node refuses to override env vars that
// already exist in the parent shell, even when they're set to empty strings —
// a common .zshrc / CI footgun that silently broke local dev for ~15 minutes
// of debugging. dotenv with `override: true` does the right thing: file wins.
loadDotenv({ path: '.env.local', override: true });
