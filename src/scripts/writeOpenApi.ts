import {writeFile} from 'node:fs/promises';

import '../modules/index.js';
import {generateOpenApiDocument} from '../lib/openapi.js';

await writeFile('docs/openapi.json', `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`);
console.log('Wrote docs/openapi.json');
process.exit(0);
