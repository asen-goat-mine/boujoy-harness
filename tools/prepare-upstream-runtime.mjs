// Create a private wrapper around the pinned engine. Existing runtimes stay usable.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {prepareLegacyDescriptors} from './migrate-legacy-descriptors.mjs';

const [upstreamArg, source, destArg, backupArg, ...extra] = process.argv.slice(2);
const fresh = source === '--fresh';
if (!upstreamArg || !source || !destArg || (!fresh && !backupArg) || (fresh && backupArg) || extra.length) {
  throw Error('Usage: node tools/prepare-upstream-runtime.mjs UPSTREAM --fresh NEW_RUNTIME, or UPSTREAM OLD_RUNTIME NEW_RUNTIME NEW_BACKUP');
}
const upstreamRoot = await fs.realpath(upstreamArg);
const oldRoot = fresh ? null : await fs.realpath(source);
const version = JSON.parse(await fs.readFile(path.join(upstreamRoot, 'node_modules/@deepseek-ai/dsh/package.json'))).version;
if (version !== '0.2.1-alpha.2') throw Error('Expected @deepseek-ai/dsh@0.2.1-alpha.2');
async function newPath(arg) {
  const dest = path.resolve(arg);
  return path.join(await fs.realpath(path.dirname(dest)), path.basename(dest));
}
const runtimeRoot = await newPath(destArg);
const backupRoot = fresh ? null : await newPath(backupArg);
const roots = [upstreamRoot, oldRoot, runtimeRoot, backupRoot].filter(Boolean);
for (const [i, a] of roots.entries()) {
  for (const b of roots.slice(i + 1)) {
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('Use separate, non-nested directories');
  }
}
const yaml = createRequire(path.join(upstreamRoot, 'package.json'))('yaml');
const migrations = [];
await fs.mkdir(runtimeRoot, {mode: 0o700});
try {
  if (backupRoot) await fs.mkdir(backupRoot, {mode: 0o700});
  for (const name of ['home', 'clean-home']) {
    const home = path.join(runtimeRoot, name);
    if (fresh) await fs.mkdir(home, {mode: 0o700});
    else {
      const originals = path.join(oldRoot, name);
      await fs.cp(originals, home, {recursive: true, errorOnExist: true, force: false, filter: async file => {
        if ((await fs.lstat(file)).isSymbolicLink()) throw Error('A source home contains a symbolic link; use a standalone copy');
        return true;
      }});
    }
    const settings = path.join(home, 'settings.yaml');
    const config = fresh ? {} : yaml.parse(await fs.readFile(settings, 'utf8')) || {};
    config['session-log-deepseek'] = {enabled: false};
    await fs.writeFile(settings, yaml.stringify(config), {mode: 0o600});
    if (!fresh) migrations.push({mode: name, changes: await prepareLegacyDescriptors({home, upstreamRoot, backupDir: path.join(backupRoot, 'descriptors', name)})});
  }
  for (const dir of ['bin','lib','node_modules/.bin','runtime/bin']) await fs.mkdir(path.join(runtimeRoot, dir), {recursive: true});
  for (const file of ['dsh-compat.mjs','boujoy-upstream.patch.yml']) await fs.copyFile(new URL(file, import.meta.url), path.join(runtimeRoot,'lib',file));
  await fs.writeFile(path.join(runtimeRoot,'boujoy-runtime.json'), JSON.stringify({upstreamRoot,version,node:process.execPath},null,2));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const launcher = '#!/bin/sh\nexport BOUJOY_DSH_ROOT='+quote(runtimeRoot)+'\nexec '+quote(process.execPath)+' '+quote(path.join(runtimeRoot,'lib/dsh-compat.mjs'))+' "$@"\n';
  await fs.writeFile(path.join(runtimeRoot,'bin/dsh'), launcher, {mode:0o755});
  await fs.symlink('../../bin/dsh',path.join(runtimeRoot,'node_modules/.bin/dsh'));
  await fs.symlink(process.execPath,path.join(runtimeRoot,'runtime/bin/node'));
  if (backupRoot) await fs.writeFile(path.join(backupRoot,'migration.json'), JSON.stringify(migrations,null,2), {mode:0o600,flag:'wx'});
} catch (error) {
  await fs.rm(runtimeRoot, {recursive:true, force:true});
  throw error;
}
console.log('Prepared Boujoy runtime', runtimeRoot, 'using DSH', version);
