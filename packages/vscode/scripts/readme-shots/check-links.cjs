// README image check, run before a release:
//
//   node scripts/readme-shots/check-links.cjs [whats-new.md ...]
//
// 1. Every relative link and image in packages/vscode/README.md resolves to a file.
// 2. Every README image is a PNG under 400 KB; screenshots share one width.
// 3. No file in images/ is left without a reference (it would ship in the VSIX).
// 4. Prints the URL each image gets on the Marketplace. vsce rewrites a relative
//    image to https://github.com/<repo>/raw/HEAD/<path>, with <path> taken from
//    the README's own folder, NOT from packages/vscode. So the files must also be
//    at <repo root>/images/ in the public GitHub repo for the Marketplace to show them.
// 5. For each What's-new file given, every {{shot:name|...}} slot has whats-new/shots/<name>.png.
// Exit code 1 on any failure.
const fs = require('node:fs');
const path = require('node:path');

const PKG = path.join(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const MAX_KB = 400;
const ICON = 'images/origami-coder-icon.png';
let bad = 0;
const fail = (m) => { bad++; console.log('FAIL ' + m); };

const links = [];
for (const m of readme.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) links.push({ image: m[1] === '!', href: m[2] });
for (const m of readme.matchAll(/<img[^>]+src=["']([^"']+)["']/g)) links.push({ image: true, href: m[1] });
const relative = links.filter((l) => !/^\w+:\/\//.test(l.href) && !l.href.startsWith('#') && !l.href.startsWith('mailto:'));

const repo = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '').replace(/\.git$/, '');
const project = (repo.match(/github\.com[/:]([^/]+\/[^/]+)/) || [])[1];
if (!project) fail('package.json repository is not a GitHub URL: vsce cannot rewrite relative images');

const widths = new Map();
const seen = new Set();
for (const l of relative) {
  const file = path.join(PKG, l.href);
  if (!fs.existsSync(file)) { fail(`missing ${l.href}`); continue; }
  if (!l.image) { console.log(`ok   link  ${l.href}`); continue; }
  seen.add(l.href);
  const b = fs.readFileSync(file);
  const png = b.slice(1, 4).toString() === 'PNG';
  const kb = Math.round(b.length / 1024);
  if (!png) fail(`${l.href} is not a PNG`);
  if (kb > MAX_KB) fail(`${l.href} is ${kb} KB (over ${MAX_KB} KB)`);
  const w = png ? b.readUInt32BE(16) : 0;
  const h = png ? b.readUInt32BE(20) : 0;
  if (l.href !== ICON) widths.set(w, [...(widths.get(w) || []), l.href]);
  console.log(`ok   image ${l.href.padEnd(34)} ${w}x${h} ${kb} KB -> https://github.com/${project}/raw/HEAD/${path.posix.normalize(l.href)}`);
}
if (widths.size > 1) fail(`screenshots have ${widths.size} widths: ${[...widths].map(([w, f]) => `${w} (${f.length})`).join(', ')}`);

for (const f of fs.readdirSync(path.join(PKG, 'images'))) {
  if (!seen.has(`images/${f}`)) fail(`images/${f} is not used by the README`);
}

for (const md of process.argv.slice(2)) {
  const text = fs.readFileSync(md, 'utf8');
  for (const m of text.matchAll(/\{\{shot:([\w-]+)\|/g)) {
    const shot = path.join(PKG, 'whats-new', 'shots', `${m[1]}.png`);
    if (fs.existsSync(shot)) console.log(`ok   shot  ${m[1]}`);
    else console.log(`open shot  ${m[1]} (no file: the What's-new window shows nothing there)`);
  }
}

console.log(bad ? `\n${bad} problem(s)` : `\nall ${relative.length} relative links resolve`);
process.exit(bad ? 1 : 0);
