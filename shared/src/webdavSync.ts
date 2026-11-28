export interface WebDavSyncSettings {
  url: string;
  username: string;
  enabled: boolean;
  intervalMinutes: number;
  hasPassword: boolean;
}

export interface WebDavSyncConflict {
  local: string;
  remote: string | null;
}

export interface WebDavSyncStatus {
  settings: WebDavSyncSettings;
  state: 'idle' | 'syncing' | 'unchanged' | 'uploaded' | 'downloaded' | 'conflict' | 'error';
  message: string;
  lastSuccessAt: string | null;
  transferredBlocks: number;
  conflict: WebDavSyncConflict | null;
}
