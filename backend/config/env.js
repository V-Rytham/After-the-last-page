import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Import this module before anything that reads process.env. Loading .env as a
// side effect of a database module made env availability depend on import order.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
