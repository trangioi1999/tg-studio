// Starts a release: raises the version everywhere, dates the changelog, commits and tags.
//   npm run release -- patch     0.2.0 → 0.2.1   (fixes)
//   npm run release -- minor     0.2.1 → 0.3.0   (new features)
//   npm run release -- major     0.3.0 → 1.0.0
//   npm run release -- 0.4.0-beta.1
// Then build (npm run build:mac / build:app) and push the commit and tag yourself.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) fail('Cần cho biết mức nâng: patch, minor, major hoặc một số phiên bản (vd. 0.4.0).');
if (run('git', ['status', '--porcelain'])) fail('Còn thay đổi chưa commit. Commit hoặc cất đi trước khi phát hành.');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split(/[.-]/).map(Number);
const next = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[arg] ?? arg;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) fail(`"${next}" không phải số phiên bản SemVer.`);
if (run('git', ['tag', '--list', `v${next}`])) fail(`Tag v${next} đã có.`);

pkg.version = next;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(run('node', ['scripts/version-sync.mjs']));

// The unreleased notes become this version's; a fresh empty section goes on top.
const day = new Date().toISOString().slice(0, 10);
const log = readFileSync('CHANGELOG.md', 'utf8');
if (!log.includes('## [Chưa phát hành]')) fail('CHANGELOG.md thiếu mục "## [Chưa phát hành]".');
writeFileSync('CHANGELOG.md', log.replace('## [Chưa phát hành]', `## [Chưa phát hành]\n\n## [${next}] - ${day}`));

run('git', ['add', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src/app/core/mock-backend.ts', 'CHANGELOG.md']);
run('git', ['commit', '-m', `chore(release): v${next}`]);
run('git', ['tag', '-a', `v${next}`, '-m', `TG Studio v${next}`]);
console.log(`\nĐã nâng lên ${next}, commit và gắn tag v${next}.`);
console.log('Tiếp theo: npm run build:mac (Mac, mọi chip) hoặc npm run build:app, rồi git push --follow-tags.');
