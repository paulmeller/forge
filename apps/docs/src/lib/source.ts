import { docs } from '@/../.source';
import { loader } from 'fumadocs-core/source';

const rawSource = docs.toFumadocsSource();
// fumadocs-mdx v11 returns `files` as a function; fumadocs-core v15 expects an array
const files = typeof rawSource.files === 'function'
  ? (rawSource.files as unknown as () => unknown[])()
  : rawSource.files;

export const source = loader({
  baseUrl: '/docs',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridge version mismatch
  source: { files } as any,
});
