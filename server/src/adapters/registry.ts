import type { PlatformId } from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';

const adapters = new Map<PlatformId, PlatformAdapter>();

export function register(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

export function getAdapter(platform: PlatformId): PlatformAdapter | undefined {
  return adapters.get(platform);
}

export function listAdapters(): PlatformAdapter[] {
  return [...adapters.values()];
}
