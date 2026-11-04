import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openStore } from './core/store.js';
import { createEngine } from './core/engine.js';
import { createHttp } from './http/server.js';
import { log } from './core/util.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = process.env.LIVEDESK_SAMPLE === '1';
const store = openStore(sample ? ':memory:' : (process.env.DB_FILE || join(root, 'data', 'livedesk.db')));

// Seed events from config/events/*.json. A config file only seeds an event the first time; after
// that the database copy (edited in the admin panel) is authoritative unless CONFIG_OVERWRITE=1.
for (const f of readdirSync(join(root, 'config', 'events')).filter(f => f.endsWith('.json'))) {
  const cfg = JSON.parse(readFileSync(join(root, 'config', 'events', f), 'utf8'));
  if (sample) cfg.sources = [{ id: 'sample', adapter: 'sample', name: 'Sample data (simulated)', license: 'Simulated. Not real election results.', trust: 'sample', enabled: true, priority: 1, intervalSec: 15, params: {} }];
  if (!store.getEvent(cfg.id) || process.env.CONFIG_OVERWRITE === '1' || sample) store.upsertEvent(cfg);
}

const engine = createEngine(store, { sampleMode: sample });
const server = createHttp({ store, engine, publicDir: join(root, 'public') });
const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  log('info', `LiveDesk listening on http://localhost:${port}${sample ? ' (SAMPLE DATA MODE)' : ''}`);
  engine.start();
});
const shutdown = () => { engine.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
