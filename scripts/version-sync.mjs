// One source of truth for the version: package.json. Copies it into src-tauri/Cargo.toml,
// src-tauri/Cargo.lock, package-lock.json, src-tauri/tauri.conf.json and the mock backend.
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
    // The lockfiles carry the version too; a stale one shows up as a diff after the next build.
    path: 'src-tauri/Cargo.lock',
    // \r?\n: a Windows checkout has CRLF line ends.
    read: (text) => /\[\[package\]\]\r?\nname = "tg-studio"\r?\nversion = "([^"]+)"/.exec(text)?.[1],
    write: (text) => text.replace(/(\[\[package\]\]\r?\nname = "tg-studio"\r?\nversion = )"[^"]+"/, `$1"${version}"`),
  },
  {
    path: 'package-lock.json',
    read: (text) => {
      const lock = JSON.parse(text);
      return lock.version === lock.packages?.['']?.version ? lock.version : null;
    },
    write: (text) => {
      const lock = JSON.parse(text);
      lock.version = version;
      if (lock.packages?.['']) lock.packages[''].version = version;
      return JSON.stringify(lock, null, 2) + '\n';
    },
  },
  {
    // What the browser-only mock shows in the status bar and in screenshots.
    path: 'src/app/core/mock/mock-backend.ts',
    read: (text) => /const APP_VERSION = '([^']+)';/.exec(text)?.[1],
    write: (text) => text.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${version}';`),
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
