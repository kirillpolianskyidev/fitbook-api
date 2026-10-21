import {connectDb, disconnectDb} from '../db/connect.js';
import {runMigrations} from '../db/migrations.js';

await connectDb();
await runMigrations();
await disconnectDb();
console.log('Migrations done');
process.exit(0);
