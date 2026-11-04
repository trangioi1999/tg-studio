// One source of truth for the version: package.json. Copies it into
// src-tauri/Cargo.toml and src-tauri/tauri.conf.json.
//   node scripts/version-sync.mjs          write
//   node scripts/version-sync.mjs --check  exit 1 if any file differs (CI)
import { readFileSync, writeFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`package.json version is not SemVer: ${version}`);
  process.exit(1);
}

const files = [
  {
    path: 'src-tauri/Cargo.toml',
    // Only the [package] version, the first `version =` line.
    read: (text) => /^version = "([^"]+)"/m.exec(text)?.[1],
    write: (text) => text.replace(/^version = "[^"]+"/m, `version = "${version}"`),
  },
  {
    path: 'src-tauri/tauri.conf.json',
    read: (text) => JSON.parse(text).version,
    write: (text) => text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`),
  },
];

let mismatch = false;
for (const f of files) {
  const text = readFileSync(f.path, 'utf8');
  const found = f.read(text);
  if (found === version) continue;
  mismatch = true;
  if (check) console.error(`${f.path}: ${found} ≠ package.json ${version}`);
  else {
    writeFileSync(f.path, f.write(text));
    console.log(`${f.path}: ${found} → ${version}`);
  }
}
if (check && mismatch) process.exit(1);
if (!mismatch) console.log(`All files at ${version}.`);
