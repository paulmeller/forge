import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/lib/env';

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
        defaultVaultId: env.FORGE_MA_DEFAULT_VAULT_ID,
        // ANTHROPIC_BASE_URL already exists as a documented override (see .env.example) but was
        // never actually threaded into the client this adapter uses — every managed-agents call
        // silently went to api.anthropic.com regardless of the env var. Constructing the client
        // explicitly here (rather than leaving ManagedAgentsAdapter's own default
        // `new Anthropic({ apiKey })`) is what makes a self-hosted engine at a non-default baseURL
        // actually reachable.
        client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL }),
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
      adapter = new GatewayAdapter({ baseUrl: env.GATEWAY_URL, apiKey: env.GATEWAY_API_KEY, environmentId: env.GATEWAY_ENVIRONMENT_ID });
      break;
    }
    default:
      throw new Error(`unknown backend kind: ${String(kind)}`);
  }

  cache.set(kind, adapter);
  return adapter;
}
