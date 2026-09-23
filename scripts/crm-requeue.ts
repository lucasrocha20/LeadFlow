// Requeues dead-lettered CRM syncs: `npm run crm:requeue` (all) or `npm run crm:requeue -- <leadId>…`.
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { requeueDeadLetters } from '../src/crm/syncLead.js';
import { createDb } from '../src/db.js';
import { createJobQueue } from '../src/queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = createJobQueue(redis);
const leadIds = process.argv.slice(2);

try {
  const count = await requeueDeadLetters(db, queue, leadIds.length > 0 ? leadIds : undefined);
  console.log(`Cleared ${count} dead-lettered lead(s); the worker will sync them again.`);
} finally {
  await queue.close();
  redis.disconnect();
  await db.$disconnect();
}
