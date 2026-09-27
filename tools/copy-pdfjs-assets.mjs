// Copy the decoders, fonts and character maps pdf.js loads at runtime.
import { cpSync, rmSync } from 'node:fs';
const src = 'node_modules/pdfjs-dist';
const dst = 'public/pdfjs';
rmSync(dst, { recursive: true, force: true });
for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) cpSync(`${src}/${dir}`, `${dst}/${dir}`, { recursive: true });
