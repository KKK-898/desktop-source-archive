import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchVerified, IntegrityError, NSIS_REQUIRED, prepareTools, assertChild, verifyProject, exportRuntimeEnvironment } from './prepare-release-tools.mjs';

const quiet = () => {};
const immediate = async () => {};
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
function fixture(name, content = name) {
  const bytes = Buffer.from(content);
  return { name, size: bytes.length, sha256: hash('sha256', bytes), sha1: hash('sha1', bytes),
    url: `https://github.com/test-fixtures/download/${name}`, api: `https://api.github.com/repos/test-fixtures/assets/${name}`, bytes };
}
function fetchFixtures(assets) {
  return async url => {
    const asset = assets.find(item => url === item.url || url === item.api);
    assert(asset, 'Offline tests must never request an unconfigured URL');
    return new Response(asset.bytes);
  };
}
async function temporary(t) {
  // Hosted Windows short paths and macOS /var aliases must match the physical cache paths.
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'gaoge-tools-offline-')));
  t.after(async () => {
    assertChild(tempRoot, root);
    assert(path.basename(root).startsWith('gaoge-tools-offline-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function fakeExtract(_archive, destination, omitted) {
  for (const relative of NSIS_REQUIRED.filter(item => item !== NSIS_REQUIRED[4] && item !== omitted)) {
    const target = path.join(destination, 'nsis-3.11', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `non-executable offline fixture: ${relative}`);
  }
}
function windowsOptions(cacheRoot, overrides = {}) {
  const assets = [fixture('nsis-3.11.zip'), fixture('nsis_tauri_utils.dll')];
  return { platform: 'win32', cacheRoot, assets, fetchImpl: fetchFixtures(assets), extractArchive: fakeExtract,
    sleep: immediate, retryDelayMs: 0, log: quiet, ...overrides };
}
async function seedOldCache(root) {
  await fs.mkdir(path.join(root, 'NSIS'), { recursive: true });
  await fs.writeFile(path.join(root, 'NSIS', 'original.txt'), 'existing-cache');
}
async function assertOldCache(root) {
  assert.equal(await fs.readFile(path.join(root, 'NSIS', 'original.txt'), 'utf8'), 'existing-cache');
  assert.deepEqual(await fs.readdir(root), ['NSIS']);
}

test('504 on the ordinary entry falls back to the official asset API within the attempt limit', async () => {
  const asset = fixture('tool.zip');
  const requests = [];
  const bytes = await fetchVerified(asset, {
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers.Accept, 'application/octet-stream');
      assert.equal(options.headers.Authorization, undefined);
      return url === asset.url ? new Response('gateway', { status: 504 }) : new Response(asset.bytes);
    }, sleep: immediate, log: quiet,
  });
  assert.deepEqual(requests, [asset.url, asset.url, asset.api]);
  assert.deepEqual(bytes, asset.bytes);
});

test('each timed out request is aborted and both entries have bounded attempts', async () => {
  const asset = fixture('tool.zip');
  let aborted = 0;
  await assert.rejects(fetchVerified(asset, {
    timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
    }), sleep: immediate, log: quiet,
  }), /official entries exhausted/);
  assert.equal(aborted, 4);
});

test('a SHA256 mismatch fails closed without trying a second entry', async () => {
  const asset = fixture('tool.zip');
  let requests = 0;
  await assert.rejects(fetchVerified({ ...asset, sha256: '0'.repeat(64) }, {
    fetchImpl: async () => { requests++; return new Response(asset.bytes); }, log: quiet,
  }), /sha256 mismatch/);
  assert.equal(requests, 1);
});

test('the Tauri SHA1 is checked even when SHA256 matches', async () => {
  const asset = fixture('tool.zip');
  await assert.rejects(fetchVerified({ ...asset, sha1: '0'.repeat(40) }, {
    fetchImpl: async () => new Response(asset.bytes), log: quiet,
  }), /sha1 mismatch/);
});

test('oversized responses are cancelled and are not accepted as fallback candidates', async () => {
  const asset = fixture('tiny');
  let cancelled = false;
  await assert.rejects(fetchVerified(asset, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(asset.size + 1)); },
      cancel() { cancelled = true; },
    })), log: quiet,
  }), IntegrityError);
  assert.equal(cancelled, true);
});

test('a short response is rejected before it can be installed', async () => {
  const asset = fixture('tool.zip');
  await assert.rejects(fetchVerified(asset, {
    fetchImpl: async () => new Response(asset.bytes.subarray(1)), log: quiet,
  }), /unexpected byte count/);
});

test('Windows installs a complete NSIS tree and the exact plugin without executing fixtures', async t => {
  const cacheRoot = await temporary(t);
  await seedOldCache(cacheRoot);
  const options = windowsOptions(cacheRoot);
  const result = await prepareTools(options);
  assert.deepEqual(result.installed, ['NSIS']);
  for (const relative of NSIS_REQUIRED) assert((await fs.stat(path.join(cacheRoot, 'NSIS', relative))).isFile());
  assert.deepEqual(await fs.readFile(path.join(cacheRoot, 'NSIS', NSIS_REQUIRED[4])), options.assets[1].bytes);
  assert.deepEqual(await fs.readdir(cacheRoot), ['NSIS']);
});

test('a missing required NSIS path preserves the old cache', async t => {
  const cacheRoot = await temporary(t);
  await seedOldCache(cacheRoot);
  await assert.rejects(prepareTools(windowsOptions(cacheRoot, {
    extractArchive: (archive, destination) => fakeExtract(archive, destination, 'Include/MUI2.nsh'),
  })), /ENOENT/);
  await assertOldCache(cacheRoot);
});

test('failed plugin verification preserves the cache and never calls extraction', async t => {
  const cacheRoot = await temporary(t);
  await seedOldCache(cacheRoot);
  const options = windowsOptions(cacheRoot);
  options.assets[1].sha256 = '0'.repeat(64);
  let extracted = false;
  options.extractArchive = async () => { extracted = true; };
  await assert.rejects(prepareTools(options), /sha256 mismatch/);
  assert.equal(extracted, false);
  await assertOldCache(cacheRoot);
});

test('a failed final rename restores the old Windows cache', async t => {
  const cacheRoot = await temporary(t);
  await seedOldCache(cacheRoot);
  let failed = false;
  const options = windowsOptions(cacheRoot, {
    rename: async (from, to) => {
      if (!failed && from.includes(`${path.sep}extracted${path.sep}`) && to === path.join(cacheRoot, 'NSIS')) {
        failed = true;
        throw new Error('simulated final rename failure');
      }
      await fs.rename(from, to);
    },
  });
  await assert.rejects(prepareTools(options), /simulated final rename failure/);
  assert.equal(failed, true);
  await assertOldCache(cacheRoot);
});

test('a cache junction is rejected before fetching any asset', async t => {
  const root = await temporary(t);
  const cacheRoot = path.join(root, 'cache');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cacheRoot);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'preserve');
  await fs.symlink(outside, path.join(cacheRoot, 'NSIS'), 'junction');
  let fetched = false;
  await assert.rejects(prepareTools(windowsOptions(cacheRoot, {
    fetchImpl: async () => { fetched = true; throw new Error('network forbidden'); },
  })), /symbolic link/);
  assert.equal(fetched, false);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'preserve');
});

test('cache operations reject the root itself and paths outside the declared directory', () => {
  const root = path.resolve('cache');
  assert.throws(() => assertChild(root, root), /escaped/);
  assert.throws(() => assertChild(root, path.join(root, '..', 'outside')), /escaped/);
  assert.doesNotThrow(() => assertChild(root, path.join(root, 'NSIS')));
});

test('project validation rejects a changed Tauri CLI or a different tools cache', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'node_modules', '@tauri-apps', 'cli'), { recursive: true });
  await fs.mkdir(path.join(root, 'src-tauri'));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@tauri-apps/cli': { version: '2.11.2' } } }));
  await fs.writeFile(path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), JSON.stringify({ version: '2.11.2' }));
  await fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ bundle: {} }));
  await verifyProject(root);
  await fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ bundle: { useLocalToolsDir: true } }));
  await assert.rejects(verifyProject(root), /default Tauri tools cache/);
  await fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ bundle: {} }));
  await fs.writeFile(path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), JSON.stringify({ version: '2.12.0' }));
  await assert.rejects(verifyProject(root), /only support/);
});

test('API authentication stays on the fixed API entry and never reaches the CDN', async () => {
  const asset = fixture('tool.zip');
  const requests = [];
  const token = 'offline-test-token';
  await fetchVerified(asset, {
    attempts: 1, token, log: quiet, fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization, redirect: options.redirect });
      if (url === asset.url) return new Response('gateway', { status: 504 });
      if (url === asset.api) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixed/tool.zip' } });
      assert.equal(url, 'https://release-assets.githubusercontent.com/fixed/tool.zip');
      return new Response(asset.bytes);
    },
  });
  assert.deepEqual(requests.map(request => request.authorization), [undefined, `Bearer ${token}`, undefined]);
  assert(requests.every(request => request.redirect === 'manual'));
});

test('raw Git blob fallback requests raw bytes with the correct media type', async () => {
  const asset = { ...fixture('plugin.sh'), apiAccept: 'application/vnd.github.raw+json' };
  await fetchVerified(asset, {
    attempts: 1, log: quiet, fetchImpl: async (url, options) => {
      if (url === asset.url) return new Response('gateway', { status: 504 });
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      return new Response(asset.bytes);
    },
  });
});

test('a redirect to HTTP or a non-official host fails before contacting that destination', async () => {
  for (const destination of ['http://github.com/unsafe', 'https://example.invalid/unsafe']) {
    const asset = fixture('tool.zip');
    let requests = 0;
    await assert.rejects(fetchVerified(asset, {
      log: quiet, fetchImpl: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: destination } });
      },
    }), /approved official HTTPS/);
    assert.equal(requests, 1);
  }
});

test('rate limits and redirect loops terminate without exposing the optional token', async () => {
  const asset = fixture('tool.zip');
  for (const status of [403, 302]) {
    const logs = [];
    let requests = 0;
    await assert.rejects(fetchVerified(asset, {
      token: 'private-offline-test-value', attempts: 1, log: message => logs.push(message),
      fetchImpl: async url => {
        requests++;
        return new Response(null, { status, headers: status === 302 ? { location: url } : {} });
      },
    }), /official entries exhausted/);
    assert.equal(requests, status === 302 ? 12 : 2);
    assert(!logs.join('\n').includes('private-offline-test-value'));
  }
});

function linuxFixtures() {
  return ['AppRun-x86_64', 'linuxdeploy-x86_64.AppImage', 'linuxdeploy-plugin-gtk.sh',
    'linuxdeploy-plugin-gstreamer.sh', 'linuxdeploy-plugin-appimage.AppImage', 'runtime-x86_64']
    .map(name => ({ ...fixture(name), cacheName: name, ...(name === 'runtime-x86_64' ? { mode: 0o644 } : {}) }));
}

test('Linux installs all six cache names with Tauri permissions and a readable runtime', async t => {
  const cacheRoot = await temporary(t);
  const assets = linuxFixtures();
  const modes = [];
  const result = await prepareTools({
    platform: 'linux', cacheRoot, assets, fetchImpl: fetchFixtures(assets), log: quiet,
    chmod: async (target, mode) => { modes.push(mode); await fs.chmod(target, mode); },
  });
  assert.deepEqual(result.installed, assets.map(asset => asset.cacheName));
  assert.deepEqual(modes, [0o770, 0o770, 0o770, 0o770, 0o770, 0o644]);
  assert.equal(result.runtimeFile, path.join(cacheRoot, 'runtime-x86_64'));
  for (const asset of assets) {
    const target = path.join(cacheRoot, asset.cacheName);
    assert.deepEqual(await fs.readFile(target), asset.bytes);
    if (process.platform === 'linux') assert.equal((await fs.stat(target)).mode & 0o777, asset.mode ?? 0o770);
  }
  assert.equal((await fs.readdir(cacheRoot)).length, 6);
});

test('a later Linux installation failure rolls back every previously installed file', async t => {
  const cacheRoot = await temporary(t);
  const assets = linuxFixtures();
  for (const asset of assets) await fs.writeFile(path.join(cacheRoot, asset.cacheName), `old-${asset.cacheName}`);
  let failed = false;
  await assert.rejects(prepareTools({
    platform: 'linux', cacheRoot, assets, fetchImpl: fetchFixtures(assets), log: quiet,
    rename: async (from, to) => {
      if (!failed && path.basename(from) === assets[2].name && to === path.join(cacheRoot, assets[2].cacheName)) {
        failed = true;
        throw new Error('simulated third tool installation failure');
      }
      await fs.rename(from, to);
    },
  }), /third tool installation failure/);
  assert.equal(failed, true);
  for (const asset of assets) assert.equal(await fs.readFile(path.join(cacheRoot, asset.cacheName), 'utf8'), `old-${asset.cacheName}`);
  assert.equal((await fs.readdir(cacheRoot)).length, 6);
});

test('the pinned runtime is passed to the next build step without environment-line injection', async t => {
  const root = await temporary(t);
  const environmentFile = path.join(root, 'github-env');
  const result = { platform: 'linux', runtimeFile: path.join(root, 'runtime-x86_64') };
  await exportRuntimeEnvironment(result, environmentFile);
  const expected = `LDAI_RUNTIME_FILE=${result.runtimeFile}\n`;
  assert.equal(await fs.readFile(environmentFile, 'utf8'), expected);
  await assert.rejects(exportRuntimeEnvironment({ ...result, runtimeFile: `${result.runtimeFile}\nINJECTED=value` }, environmentFile), /Invalid Linux runtime/);
  assert.equal(await fs.readFile(environmentFile, 'utf8'), expected);
  await assert.rejects(exportRuntimeEnvironment(result, 'relative-file'), /absolute GITHUB_ENV/);
});
