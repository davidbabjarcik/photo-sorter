// Príprava pre Synology NAS.
//   node scripts/synology.mjs zip            -> photo-sorter-synology.zip (nahraj cez File Station)
//   node scripts/synology.mjs copy <cieľ>    -> skopíruje dist/ priamo na zdieľaný priečinok NAS
// Cieľ môže byť aj v premennej SYNOLOGY_PATH, napr.:
//   Windows: \\NAS\web\photo-sorter   (alebo namapovaný disk Z:\photo-sorter)
//   macOS:   /Volumes/web/photo-sorter
import { existsSync, readdirSync, rmSync, cpSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIST = resolve('dist');
const [cmd, argTarget] = process.argv.slice(2);

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) fail('Chýba dist/ – najprv spusti „npm run build“.');

if (cmd === 'zip') {
  const out = resolve('photo-sorter-synology.zip');
  rmSync(out, { force: true });
  // bsdtar s -a vie vytvoriť ZIP – na Windows 10+ je v System32 (nie GNU tar z Git Bash), na macOS je predvolený
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-a', '-c', '-f', out, '-C', DIST, '.'], { stdio: 'inherit' });
  console.log(`✔ Balík pripravený: ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  console.log('  Nahraj ho cez File Station do priečinka web/photo-sorter a rozbaľ (pravý klik → Rozbaliť → Rozbaliť sem).');
} else if (cmd === 'copy') {
  const target = argTarget || process.env.SYNOLOGY_PATH;
  if (!target) fail('Zadaj cieľ: npm run synology:copy -- "\\\\NAS\\web\\photo-sorter"  (alebo nastav SYNOLOGY_PATH)');
  const parent = resolve(target, '..');
  if (!existsSync(parent)) fail(`Priečinok ${parent} nie je dostupný. Je NAS pripojený a zdieľaný priečinok „web“ namapovaný?`);
  if (existsSync(target)) {
    const items = readdirSync(target).filter((f) => !f.startsWith('@') && !f.startsWith('.') && f !== '#recycle');
    // bezpečnosť: premaž len priečinok, v ktorom je už nasadená táto appka (alebo je prázdny)
    if (items.length && !items.includes('index.html')) {
      fail(`${target} nie je prázdny a nevyzerá ako Photo Sorter (chýba index.html). Nič som nezmenil.`);
    }
    for (const f of items) rmSync(join(target, f), { recursive: true, force: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
  cpSync(DIST, target, { recursive: true });
  console.log(`✔ Nasadené do ${target}`);
} else {
  fail('Použitie: node scripts/synology.mjs zip | copy <cieľ>');
}
