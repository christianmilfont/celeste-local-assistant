import { TvDevice } from '../../core/types/tv';
import { TvRegistry } from '../../application/TvService';
import { CelesteDatabase } from './Database';

const KEY = 'tv.devices';

/** Guarda as TVs conhecidas (IP, MAC, token de autorização) na tabela settings do SQLite. */
export class SettingsTvRegistry implements TvRegistry {
  constructor(private database: CelesteDatabase) {}

  load(): TvDevice[] {
    const row = this.database
      .getDatabase()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(KEY) as { value: string } | undefined;
    if (!row) {
      return [];
    }
    try {
      const devices = JSON.parse(row.value);
      return Array.isArray(devices) ? devices : [];
    } catch {
      return [];
    }
  }

  save(devices: TvDevice[]): void {
    this.database
      .getDatabase()
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
      )
      .run(KEY, JSON.stringify(devices));
  }
}
