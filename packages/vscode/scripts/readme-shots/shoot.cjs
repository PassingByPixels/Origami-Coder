// README and What's-new screenshots from the real built webview bundle.
//
//   cd packages/vscode
//   node esbuild.js                                   # build out/webview first
//   node scripts/readme-shots/shoot.cjs [name ...]    # all scenes, or only these
//
// Each scene (scenes/*.cjs) opens one view with fictional sample data, may click
// or post more host messages, then saves a PNG under packages/vscode/. Before it
// saves, the rendered text of every frame is checked: a scene that shows the
// user name, the home folder, an e-mail address or a word in READMESHOTS_DENY
// (comma list), or text such as "undefined" or "NaN", is not saved.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const lib = require('./lib.cjs');

const PKG = path.join(__dirname, '..', '..');
const README_VIEW = { width: 960, scale: 1.5 }; // every README image: 1440 px wide
const WHATSNEW_SCALE = 2;

function loadScenes() {
  const dir = path.join(__dirname, 'scenes');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort()
    .flatMap((f) => require(path.join(dir, f)));
}

function denyList() {
  const words = [os.userInfo().username, path.basename(os.homedir())];
  for (const w of (process.env.READMESHOTS_DENY || '').split(',')) if (w.trim()) words.push(w.trim());
  return [...new Set(words.filter((w) => w && w.length > 2))];
}

const BROKEN = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /Invalid Date/];
const HOME = /[A-Z]:\\Users\\|\/Users\/|\/home\//;
const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

async function textOf(page) {
  const parts = [];
  for (const f of page.frames()) {
    try {
      parts.push(await f.evaluate(() => {
        const attrs = [...document.querySelectorAll('[title],[aria-label],[placeholder]')]
          .map((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder')].join(' '));
        return (document.body ? document.body.innerText : '') + '\n' + attrs.join('\n');
      }));
    } catch { /* detached frame */ }
  }
  return parts.join('\n');
}

function check(text, deny) {
  const bad = [];
  for (const w of deny) if (text.toLowerCase().includes(w.toLowerCase())) bad.push(`private word "${w}"`);
  if (HOME.test(text)) bad.push(`home path "${text.match(HOME)[0]}"`);
  const mail = text.match(EMAIL);
  if (mail) bad.push(`e-mail "${mail[0]}"`);
  for (const r of BROKEN) if (r.test(text)) bad.push(`broken text ${r}`);
  return bad;
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kb: Math.round(b.length / 1024) };
}

(async () => {
  const only = process.argv.slice(2);
  const scenes = loadScenes().filter((s) => !only.length || only.includes(s.name));
  if (!scenes.length) throw new Error('no scene matches ' + only.join(' '));
  const deny = denyList();
  const browser = await lib.launch();
  let failed = 0;
  for (const s of scenes) {
    const whatsnew = s.out.startsWith('whats-new/');
    const view = whatsnew
      ? { scale: WHATSNEW_SCALE, ...s.view }
      : { ...s.view, ...README_VIEW };
    const { ctx, page, errors, frame } = await lib.openView(browser, view);
    try {
      if (s.act) await s.act(page, { frame, post: lib.post });
      await page.waitForTimeout(s.wait ?? 250);
      const bad = check(await textOf(page), deny);
      if (errors.length) bad.push('page error: ' + errors[0]);
      if (bad.length) {
        failed++;
        console.log(`FAIL ${s.name}: ${bad.join('; ')}`);
        continue;
      }
      const file = path.join(PKG, s.out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (s.clip) {
        const el = typeof s.clip === 'string' ? await frame(s.clipFrame).$(s.clip) : null;
        if (typeof s.clip === 'string' && !el) throw new Error(`${s.name}: clip ${s.clip} not found`);
        if (el) await el.screenshot({ path: file });
        else await page.screenshot({ path: file, clip: s.clip });
      } else {
        await page.screenshot({ path: file });
      }
      const z = pngSize(file);
      console.log(`ok   ${s.name.padEnd(22)} ${s.out.padEnd(38)} ${z.w}x${z.h} ${z.kb} KB`);
    } finally {
      await ctx.close();
    }
  }
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
