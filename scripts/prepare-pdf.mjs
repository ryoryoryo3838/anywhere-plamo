import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// PDF fonts, CMaps and image decoders stay bundled; never fetch them from a CDN.
const source = resolve('node_modules/pdfjs-dist');
const target = resolve('public/pdfjs');
// Keep the public directory intact while a dev server may be serving it.
mkdirSync(target, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'LICENSE']) cpSync(`${source}/${name}`, `${target}/${name}`, { recursive: true });
// The worker itself is a Vite URL import, not a copied public asset.
