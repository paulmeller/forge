import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  transpilePackages: ['@forge/db'],
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['@libsql/client'],
};

export default withMDX(config);
