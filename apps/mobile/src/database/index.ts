import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import { schema } from './schema';
import { modelClasses } from './models';

let databaseInstance: Database | null = null;

export function getDatabase(): Database {
  if (!databaseInstance) {
    const adapter = new SQLiteAdapter({
      schema,
      jsi: false,
      onSetUpError: (error) => {
        console.error('WatermelonDB setup failed:', error);
      },
    });
    databaseInstance = new Database({
      adapter,
      modelClasses,
    });
  }
  return databaseInstance;
}

export { schema } from './schema';
export * from './models';
