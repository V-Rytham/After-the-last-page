import app from './app.js';
import { env } from './config/env.js';
import { connectDbIfConfigured } from './config/db.js';

await connectDbIfConfigured().catch(() => {});
app.listen(env.port, () => console.log(`[SEARCH_SERVICE] listening on ${env.port}`));
