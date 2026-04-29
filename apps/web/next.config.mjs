import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  transpilePackages: ['@forge/db'],
  eslint: { ignoreDuringBuilds: true },
};

export default withMDX(config);
