import { env } from '../env';

import { GatewayAdapter } from './gateway';
import { ManagedAgentsAdapter } from './managed-agents';
import type { BackendAdapter, BackendKind } from './types';

export * from './types';
export { ManagedAgentsAdapter } from './managed-agents';
export { GatewayAdapter } from './gateway';

const cache = new Map<BackendKind, BackendAdapter>();

export function getAdapter(kind: BackendKind): BackendAdapter {
  const cached = cache.get(kind);
  if (cached) return cached;

  let adapter: BackendAdapter;
  switch (kind) {
    case 'managed-agents': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required for managed-agents backend');
      }
      if (!env.FORGE_MA_ENVIRONMENT_ID) {
        throw new Error('FORGE_MA_ENVIRONMENT_ID is required for managed-agents backend');
      }
      adapter = new ManagedAgentsAdapter({
        apiKey: env.ANTHROPIC_API_KEY,
        environmentId: env.FORGE_MA_ENVIRONMENT_ID,
      });
      break;
    }
    case 'gateway': {
      if (!env.GATEWAY_URL) {
        throw new Error('GATEWAY_URL is required for gateway backend');
      }
      if (!env.GATEWAY_API_KEY) {
        throw new Error('GATEWAY_API_KEY is required for gateway backend');
      }
      adapter = new GatewayAdapter({ baseUrl: env.GATEWAY_URL, apiKey: env.GATEWAY_API_KEY });
      break;
    }
    default:
      throw new Error(`unknown backend kind: ${String(kind)}`);
  }

  cache.set(kind, adapter);
  return adapter;
}
