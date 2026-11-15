import { fileURLToPath } from 'node:url';
import type { MigrationSet } from './db/migrate.js';

/** The workspace tables: parts, files and the rest of the stateui-mcp storage */
export const STATEUI_PG_MIGRATIONS: MigrationSet = { owner: 'stateui-pg', dir: fileURLToPath(new URL('../migrations', import.meta.url)) };
