const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

// Explicit opt-in only: all profile data, rollouts and keys are synthetic.
// Production verification: --app <native exe> --rust-test <compiled test exe>.
// --diagnostic-restore exercises native APIs manually and is never a release gate.
const appIndex = process.argv.indexOf('--app');
if (appIndex < 0 || !process.argv[appIndex + 1]) throw new Error('Pass --app <absolute native executable>');
assert.ok(path.isAbsolute(process.argv[appIndex + 1]), '--app must be absolute');
const app = path.resolve(process.argv[appIndex + 1]);
const observe = process.argv.includes('--observe');
const diagnosticRestore = process.argv.includes('--diagnostic-restore');
const rustTestIndex = process.argv.indexOf('--rust-test');
const rustTest = rustTestIndex < 0 ? null : process.argv[rustTestIndex + 1];
if (rustTestIndex >= 0) assert.ok(rustTest && path.isAbsolute(rustTest), '--rust-test requires an absolute compiled test executable');
assert.ok(!(diagnosticRestore && rustTest), 'Diagnostic restoration and production Rust verification are separate runs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const questionnaire = /What type of work do you do\?|Customize ChatGPT to fit the way you work/;
const checkpointKey = 'gaoge:api-local-projects-hydrated-v1';
const execFile = (file, args, options = {}) => new Promise((resolve, reject) => {
  cp.execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  });
});
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Test writes must stay inside its isolated root');
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gaoge-native-api-smoke-'));
  const evidence = { projectlessCompleted: true, completedAt: Math.floor(Date.now() / 1000) - 60 };
  const productionCode = (await Promise.all(['codex_api_mode_bindings.js', 'codex_api_mode_runtime.js']
    .map(file => fs.readFile(path.join(__dirname, '../src-tauri/src', file), 'utf8')))).join('\n');
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Isolated smoke test blocks upstream requests' } }));
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = 'http://127.0.0.1:' + server.address().port;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(OPENAI_|CODEX_|AZURE_OPENAI_|CHATGPT_|ANTHROPIC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(key)));
  const report = { root, app, startedAt: new Date().toISOString(), isolated: true, realAccountUsed: false, diagnosticOnly: diagnosticRestore,
    codeSha256: crypto.createHash('sha256').update(productionCode).digest('hex'),
    smokeScriptSha256: crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex'), projectPersistence: rustTest ? { kind: 'production-rust-module', executable: rustTest } : null, stages: [], passed: false };
  if (rustTest) report.projectPersistence.sha256 = crypto.createHash('sha256').update(await fs.readFile(rustTest)).digest('hex');
  let child = null, browser = null, rustRequestIndex = 0;
  async function rustCommand(selected, command, extra = {}) {
    assert.ok(rustTest, 'Production Rust test executable required');
    inside(root, selected.home);
    const name = 'rust-project-' + String(++rustRequestIndex).padStart(4, '0');
    const input = path.join(root, name + '-input.json'), output = path.join(root, name + '-output.json');
    inside(root, input); inside(root, output);
    for (const database of extra.statePaths ?? []) inside(root, database);
    await fs.writeFile(input, JSON.stringify({ home: selected.home, command, ...extra, output }));
    await execFile(rustTest, ['codex_api_local_projects::tests::isolated_api_project_command', '--exact', '--ignored', '--nocapture'],
      { env: { ...cleanEnv, GAOGE_API_PROJECT_TEST_REQUEST: input }, timeout: 20000 });
    const result = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(result.ok, true, 'Production Rust ' + command + ': ' + (result.error || 'unknown failure'));
    return result.value;
  }
  function bridgeState(selected) {
    return { ok: true, apiCodingModeEnabled: true, apiLocalOnboarding: selected.completed ? evidence : null,
      ...(rustTest && selected.projectSnapshot ? { apiLocalProjects: { ...selected.projectSnapshot,
        scope: selected.bridgeScope, runtimeRevision: selected.runtimeRevision } } : {}) };
  }
  async function profile(name, completed) {
    const directory = path.join(root, name), home = path.join(directory, 'codex-home');
    const userData = path.join(directory, 'electron-user-data'), workspace = path.join(directory, 'synthetic-workspace');
    const userHome = path.join(directory, 'synthetic-user-home'), appData = path.join(userHome, 'AppData', 'Roaming');
    const localAppData = path.join(userHome, 'AppData', 'Local'), temp = path.join(directory, 'tmp');
    for (const dir of [home, userData, workspace, userHome, appData, localAppData, temp]) { inside(root, dir); await fs.mkdir(dir, { recursive: true }); }
    await fs.writeFile(path.join(home, '.gaoge-isolated-project-smoke'), 'synthetic-isolated-smoke-profile');
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-isolated-smoke-key' }));
    await fs.writeFile(path.join(home, 'config.toml'), 'model = "gpt-5.5"\nmodel_provider = "isolated"\ncli_auth_credentials_store = "file"\n[model_providers.isolated]\nname = "Isolated smoke"\nbase_url = "' + relay + '/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
    await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify({
      'electron-account-renderer-state-v1': { owner: 'a'.repeat(64), inactive: {} },
      'electron-persisted-atom-state': completed ? { 'electron:onboarding-projectless-completed': true, last_completed_onboarding: evidence.completedAt } : {},
    }));
    return { home, userData, workspace, userHome, appData, localAppData, temp, completed,
      bridgeScope: crypto.createHash('sha256').update((await fs.realpath(home)).replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase()).digest('hex'), runtimeRevision: 0 };
  }
  async function stop({ graceful = false, gracefulGrant = null } = {}) {
    const owned = child;
    const isRunning = () => owned && owned.exitCode === null && owned.signalCode === null;
    let quitRequested = false, exitedNormally = false, nativeExitWaitMs = null;
    if (graceful && isRunning() && browser) {
      const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('app://-/index.html'));
      assert.ok(page, 'Graceful close needs the owned native window');
      // The installed preload exposes this same message for the native Quit UI.
      // It only addresses this isolated Electron instance, not another process.
      if (gracefulGrant) {
        const response = await page.evaluate(grant => window.__isolatedSmokeRuntime.requestGracefulExit(grant), gracefulGrant);
        assert.equal(response?.requested, true, 'Production runtime must authorize this native graceful exit');
      } else {
        await page.evaluate(() => { void window.electronBridge.sendMessageFromView({ type: 'quit-app' }); });
      }
      quitRequested = true;
      const nativeExitStarted = Date.now();
      for (let attempt = 0; isRunning() && attempt < 150; attempt++) await wait(100);
      exitedNormally = !isRunning();
      nativeExitWaitMs = Date.now() - nativeExitStarted;
    }
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    if (isRunning()) {
      // Only the PID returned by this script's spawn is eligible for termination.
      // taskkill may report a child race even after the entire owned tree exits.
      let terminationError;
      await execFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F']).catch(error => { terminationError = error; });
      for (let attempt = 0; isRunning() && attempt < 40; attempt++) await wait(100);
      if (isRunning() && terminationError) throw terminationError;
      assert.equal(isRunning(), false, 'Owned native process must exit before seeding its database');
    }
    child = null;
    await wait(1200);
    if (graceful) assert.ok(quitRequested && exitedNormally, 'The fast-close test must use native app.quit without force termination');
    return { quitRequested, exitedNormally, nativeExitWaitMs, mechanism: gracefulGrant ? 'production-runtime-requestGracefulExit' : graceful ? 'native-preload-quit' : 'owned-force-stop' };
  }
  async function nativeDisk(selected) {
    return JSON.parse(await fs.readFile(path.join(selected.home, '.codex-global-state.json'), 'utf8'));
  }
  async function waitForNativeDisk(selected, predicate, message) {
    const deadline = Date.now() + 15000;
    let value;
    while (Date.now() < deadline) {
      try { value = await nativeDisk(selected); if (predicate(value)) return value; }
      catch (_) { /* Atomic native file replacement may be in flight. */ }
      await wait(100);
    }
    assert.ok(value && predicate(value), message);
    return value;
  }
  async function nativeSnapshot(page) {
    return page.evaluate(async () => {
      for (const url of codexApiModeWebpackEntryUrls()) {
        const module = await import(url);
        if (typeof module.__webpack_require__ !== 'function') continue;
        const bindings = codexApiModeWebpackBindings({ module, document, window });
        if (bindings.error) continue;
        const services = bindings.appServices, settings = services.settings, access = services.workModeAccess;
        // Do not reflect/stringify RPC facades: those can invoke remote methods.
        return { stable: { services: bindings.appServices === services, settings: services.settings === settings,
          access: services.workModeAccess === access, write: settings.write === settings.write, publish: access.publish === access.publish },
        scopes: bindings.scopes().map(scope => { const value = bindings.read(scope); return {
          authMethod: value.authMethod, authLoading: value.authLoading, hasChatGptToken: value.hasChatGptToken,
          accountPresent: value.identity?.accountId != null, authAccountPresent: value.authAccountId != null,
          authenticatedAccountPresent: value.authenticatedAccountId != null, detailLevel: value.detailLevel,
          localAccess: value.localAccess?.status, workModeAccess: value.access?.status,
        }; }) };
      }
      return null;
    });
  }
  async function nativeProjectSnapshot(page) {
    return page.evaluate(async () => {
      for (const url of codexApiModeWebpackEntryUrls()) {
        const module = await import(url);
        if (typeof module.__webpack_require__ !== 'function') continue;
        const bindings = codexApiModeWebpackBindings({ module, document, window });
        if (bindings.error) continue;
        const services = bindings.appServices;
        return { catalog: await services.projectCatalog.readLocalProjects(),
          memberships: await services.threadProjectAssignments.readMemberships(),
          workspaceRoots: await services.workspaceRoots.read(crypto.randomUUID(), { hostId: 'local', canonicalizeRoots: [] }) };
      }
      throw Error('Native project bindings unavailable');
    });
  }
  async function exerciseFastClose(page, selected, projectSeed, stage, bridgePending) {
    assert.ok(rustTest, 'Fast-close proof requires the production Rust helper');
    const receiptDisk = await waitForNativeDisk(selected, native => { const marker = native['electron-persisted-atom-state']?.[checkpointKey];
      return marker?.scope === selected.bridgeScope && marker.revision === selected.projectSnapshot.revision
        && marker.nonce === selected.projectSnapshot.checkpoint?.nonce; },
      'A successful native hydration checkpoint must reach the native state file');
    stage.checkpointBeforeFastClose = receiptDisk['electron-persisted-atom-state'][checkpointKey];
    await page.evaluate(async () => {
      if (window.__isolatedSmokeRuntimeTimerIds?.length !== 1) throw Error('Expected exactly one owned runtime polling timer');
      for (const timer of window.__isolatedSmokeRuntimeTimerIds) window.clearInterval(timer);
      await window.__isolatedSmokeRuntime.refresh();
    });
    await Promise.all([...bridgePending]);
    assert.equal(await page.evaluate(() => window.__isolatedSmokeRuntime.disposed), false);
    stage.persistencePollingStopped = true;
    const sidecarPath = path.join(selected.home, '.gaoge-api-local-projects.json');
    const sidecarBefore = await fs.readFile(sidecarPath);
    const commitsBefore = stage.productionBridgeCommits || 0;
    const renamed = projectSeed.projects.find(project => projectSeed.threads.some(thread => thread.projectId === project.id));
    assert.ok(renamed, 'An assigned project is required for fast-close membership removal');
    const removed = projectSeed.projects.filter(project => project.id !== renamed.id).at(-1);
    const unassigned = projectSeed.threads.find(thread => thread.projectId === renamed.id);
    const reassigned = projectSeed.threads.find(thread => thread.projectId === null);
    assert.ok(unassigned && reassigned && renamed.id !== removed.id, 'Fast-close synthetic project cases');
    const createdName = stage.label.includes('force') ? 'Smoke project Zeta force close' : 'Smoke project Epsilon fast close';
    const createdRoot = projectSeed.projects[1].root;
    const newName = renamed.name + ' fast close';
    let editsDone = false, editValue, editFailure;
    const editOperation = page.evaluate(async args => {
      for (const url of codexApiModeWebpackEntryUrls()) {
        const module = await import(url);
        if (typeof module.__webpack_require__ !== 'function') continue;
        const bindings = codexApiModeWebpackBindings({ module, document, window });
        if (bindings.error) continue;
        const services = bindings.appServices;
        const renamed = await services.projects.renameLocal({ projectId: args.renamedId, name: args.newName });
        await services.threadProjectAssignments.setMembership({ threadId: args.unassignedId, assignment: null, projectless: true, hostId: 'local' });
        const removed = await services.projects.removeLocal(args.removedId);
        const created = await services.projects.createLocal({ name: args.createdName, sources: [args.createdRoot],
          appearance: null, initializeDefaultWorkspaceGitRepository: false, setActive: false });
        if (!created?.projectId) throw Error('Native project creation did not return an identity');
        await services.threadProjectAssignments.setMembership({ threadId: args.reassignedId,
          assignment: { projectKind: 'local', projectId: created.projectId }, projectless: false, hostId: 'local' });
        return { renamed, removed, created };
      }
      throw Error('Native fast-close project services unavailable');
    }, { renamedId: renamed.id, newName, removedId: removed.id, unassignedId: unassigned.id,
      reassignedId: reassigned.id, createdName, createdRoot }).then(value => { editValue = value; editsDone = true; }, failure => { editFailure = failure; editsDone = true; });
    const editDeadline = Date.now() + 20000;
    while (!editsDone && Date.now() < editDeadline) {
      const trustDialog = page.getByRole('dialog').filter({ hasText: createdRoot });
      const trustButton = trustDialog.getByRole('button', { name: 'Trust folder', exact: true });
      if (await trustButton.isVisible()) {
        inside(root, createdRoot);
        assert.ok(createdRoot.startsWith(selected.workspace + path.sep), 'Only this synthetic workspace may be trusted');
        await trustButton.click();
        stage.confirmedSyntheticFolder = createdRoot;
      }
      if (!editsDone) await wait(50);
    }
    assert.ok(editsDone, 'Native synthetic project editing must finish before its API grant expires');
    await editOperation;
    if (editFailure) throw editFailure;
    stage.fastCloseEdits = editValue;
    const createdId = stage.fastCloseEdits.created.projectId;
    const readback = await nativeProjectSnapshot(page);
    assert.equal(readback.catalog[renamed.id].name, newName);
    assert.equal(readback.catalog[removed.id], undefined);
    assert.equal(readback.catalog[createdId].name, createdName);
    assert.equal(readback.memberships.assignments[unassigned.id], undefined);
    assert.ok(readback.memberships.projectlessThreadIds.includes(unassigned.id));
    assert.deepEqual(readback.memberships.assignments[reassigned.id], { projectKind: 'local', projectId: createdId });
    stage.nativeReadbackAfterFastCloseEdits = readback;
    stage.fastCloseDiskBeforeQuit = await waitForNativeDisk(selected, native => {
      const catalog = native['local-projects'];
      const memberships = native['thread-project-assignments'];
      return catalog?.[renamed.id]?.name === newName && !catalog?.[removed.id] && catalog?.[createdId]?.name === createdName
        && !memberships?.[unassigned.id] && native['projectless-thread-ids']?.includes(unassigned.id)
        && memberships?.[reassigned.id]?.projectId === createdId;
    }, 'Native edits must be durably saved before the normal native Quit');
    assert.deepEqual(stage.fastCloseDiskBeforeQuit['electron-persisted-atom-state']?.[checkpointKey], stage.checkpointBeforeFastClose);
    assert.deepEqual(await fs.readFile(sidecarPath), sidecarBefore, 'Native changes must not have reached Rust CAS before final capture');
    assert.equal(stage.productionBridgeCommits || 0, commitsBefore, 'No interval/CAS may save the fast-close edits');
    stage.fastCloseExpected = { renamedId: renamed.id, newName, removedId: removed.id,
      unassignedId: unassigned.id, reassignedId: reassigned.id, createdName, createdRoot, createdLegacyId: createdId };
    stage.fastCloseSnapshotRevision = selected.projectSnapshot.revision;
    stage.fastCloseSnapshotSha256 = crypto.createHash('sha256').update(sidecarBefore).digest('hex');
    stage.assertions.push('hydrated-native-checkpoint-present-before-monitor-stop', 'native-edits-not-saved-by-background-cas',
      'native-create-rename-delete-and-membership-edits-durable-before-quit');
  }
  async function createBeforeHydration(page, selected, projectSeed, stage) {
    assert.ok(rustTest && selected.projectSnapshot, 'Startup merge proof requires the production Rust snapshot');
    assert.equal(await page.evaluate(() => window.__isolatedSmokeRuntime), undefined, 'The restoration runtime must not be installed yet');
    const sidecarPath = path.join(selected.home, '.gaoge-api-local-projects.json');
    const sidecarBefore = await fs.readFile(sidecarPath);
    const createdRoot = path.join(selected.workspace, 'Startup-race');
    const createdName = 'Smoke project Eta before hydration';
    inside(root, createdRoot);
    await fs.mkdir(createdRoot, { recursive: true });
    let creationDone = false, creationValue, creationFailure;
    const operation = page.evaluate(async args => {
      for (const url of codexApiModeWebpackEntryUrls()) {
        const module = await import(url);
        if (typeof module.__webpack_require__ !== 'function') continue;
        const bindings = codexApiModeWebpackBindings({ module, document, window });
        if (bindings.error) continue;
        return await bindings.appServices.projects.createLocal({ name: args.name, sources: [args.root],
          appearance: null, initializeDefaultWorkspaceGitRepository: false, setActive: false });
      }
      throw Error('Native startup project services unavailable');
    }, { name: createdName, root: createdRoot }).then(value => { creationValue = value; creationDone = true; },
      failure => { creationFailure = failure; creationDone = true; });
    const deadline = Date.now() + 20000;
    while (!creationDone && Date.now() < deadline) {
      const button = page.getByRole('dialog').filter({ hasText: createdRoot }).getByRole('button', { name: 'Trust folder', exact: true });
      if (await button.isVisible()) {
        assert.ok(createdRoot.startsWith(selected.workspace + path.sep), 'Only this synthetic workspace may be trusted');
        await button.click();
        stage.confirmedSyntheticFolder = createdRoot;
      }
      if (!creationDone) await wait(50);
    }
    assert.ok(creationDone, 'Native startup project creation must finish');
    await operation;
    if (creationFailure) throw creationFailure;
    assert.ok(creationValue?.projectId, 'Native createLocal must return its project identity');
    const native = await nativeProjectSnapshot(page);
    assert.deepEqual(Object.keys(native.catalog), [creationValue.projectId], 'Exactly the early-created project must precede hydration');
    assert.equal(native.catalog[creationValue.projectId].name, createdName);
    await waitForNativeDisk(selected, state => state['local-projects']?.[creationValue.projectId]?.name === createdName
      && state['electron-persisted-atom-state']?.[checkpointKey] == null,
    'The early native project must persist without a hydration receipt');
    assert.deepEqual(await fs.readFile(sidecarPath), sidecarBefore, 'Early native creation must not rewrite the restoration snapshot');
    assert.equal(stage.productionBridgeCommits || 0, 0);
    const expected = { id: creationValue.projectId, name: createdName, root: createdRoot };
    projectSeed.projects.push(expected);
    stage.startupCreation = { project: expected, snapshotRevision: selected.projectSnapshot.revision,
      snapshotSha256: crypto.createHash('sha256').update(sidecarBefore).digest('hex'), native };
    stage.assertions.push('native-project-created-before-runtime-without-hydration-receipt-or-snapshot-write');
  }
  async function launch(label, selected, { inject = true, mustStartQuestionnaire = false, projectSeed = null, mutateProjects = false, fastClose = false, forceClose = false, partialHydration = false, startupCreation = false } = {}) {
    assert.equal(child, null);
    selected.runtimeRevision++;
    if (rustTest && selected.projectSnapshot) selected.projectSnapshot = await rustCommand(selected, 'read');
    const beforeState = JSON.parse(await fs.readFile(path.join(selected.home, '.codex-global-state.json'), 'utf8'));
    const port = await freePort();
    const env = { ...cleanEnv, CODEX_HOME: selected.home, CODEX_ELECTRON_USER_DATA_PATH: selected.userData,
      USERPROFILE: selected.userHome, HOME: selected.userHome, HOMEDRIVE: path.parse(selected.userHome).root.slice(0, 2),
      HOMEPATH: selected.userHome.slice(2), APPDATA: selected.appData, LOCALAPPDATA: selected.localAppData, TEMP: selected.temp, TMP: selected.temp,
      HTTP_PROXY: relay, HTTPS_PROXY: relay, ALL_PROXY: relay, NO_PROXY: '127.0.0.1,localhost', DO_NOT_TRACK: '1' };
    child = cp.spawn(app, ['--user-data-dir=' + selected.userData, '--remote-debugging-port=' + port,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      '--disable-background-networking', '--no-first-run', '--lang=en-US'],
    { cwd: selected.workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let childLog = '', launchError;
    const logPart = part => { childLog = (childLog + String(part)).slice(-20000); };
    child.stdout.on('data', logPart); child.stderr.on('data', logPart);
    child.once('error', error => { launchError = error; });
    const endpoint = 'http://127.0.0.1:' + port;
    const stage = { label, pid: child.pid, profile: selected.home, diagnostics: [], assertions: [] };
    const bridgePending = new Set();
    stage.beforeDiskState = beforeState;
    report.stages.push(stage);
    try {
      const deadline = Date.now() + 45000;
      let connected = false;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error('Isolated app exited: ' + child.exitCode);
        try { await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }).then(response => response.json()); connected = true; break; }
        catch { await wait(300); }
      }
      assert.ok(connected, 'Isolated debugging endpoint must open');
      browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
      let page;
      const pageDeadline = Date.now() + 30000;
      while (Date.now() < pageDeadline) {
        page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('app://-/index.html'));
        if (page) break;
        await wait(300);
      }
      assert.ok(page, 'Isolated native app page');
      page.on('pageerror', error => stage.diagnostics.push(String(error.message).slice(0, 1200)));
      page.on('requestfailed', request => stage.diagnostics.push(request.url().slice(0, 300) + ': ' + request.failure()?.errorText));
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => document.body?.innerText?.trim().length > 10, undefined, { timeout: 45000 });
      stage.before = await page.evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 12000) }));
      stage.beforeScreenshot = path.join(root, label + '-before.png');
      await page.screenshot({ path: stage.beforeScreenshot });
      if (mustStartQuestionnaire) {
        assert.match(stage.before.text, questionnaire, 'Must reproduce native questionnaire before injection');
        stage.assertions.push('native-questionnaire-before-patch');
      }
      if (partialHydration) {
        assert.ok(rustTest && selected.projectSnapshot, 'Partial hydration needs an existing production snapshot');
        assert.equal(inject, false, 'Partial hydration must not start the recovery runtime');
        const sidecarPath = path.join(selected.home, '.gaoge-api-local-projects.json');
        const beforeBytes = await fs.readFile(sidecarPath);
        stage.snapshotBeforePartialSha256 = crypto.createHash('sha256').update(beforeBytes).digest('hex');
        await page.evaluate(productionCode);
        stage.beforeNativeProjects = await nativeProjectSnapshot(page);
        assert.equal(Object.keys(stage.beforeNativeProjects.catalog ?? {}).length, 0);
        const snapshot = selected.projectSnapshot;
        const projectId = Object.keys(snapshot.globals['local-projects'])[0];
        assert.ok(Object.keys(snapshot.globals['local-projects']).length > 1);
        const partialCatalog = { [projectId]: snapshot.globals['local-projects'][projectId] };
        stage.partialHydration = await page.evaluate(async ({ catalog, projectId, snapshot, checkpointKey }) => {
          for (const url of codexApiModeWebpackEntryUrls()) {
            const module = await import(url);
            if (typeof module.__webpack_require__ !== 'function') continue;
            const bindings = codexApiModeWebpackBindings({ module, document, window });
            if (bindings.error) continue;
            const services = bindings.appServices;
            const beforeAtoms = await services.applicationState.read('electron-persisted-atom-state');
            if (beforeAtoms?.value?.[checkpointKey] != null) throw Error('The new native generation retained a stale checkpoint');
            // Deliberately interrupt the equivalent native hydration sequence:
            // only one project and at most one member are written, with no CAS.
            await services.applicationState.write('electron-saved-workspace-roots', catalog[projectId].rootPaths);
            await services.applicationState.write('electron-workspace-root-labels', {});
            await services.applicationState.write('local-projects', catalog);
            const member = Object.entries(snapshot.memberships.assignments).find(([, value]) => value.projectId === projectId);
            if (member) await services.threadProjectAssignments.assignIfUnassigned([
              { threadId: member[0], assignment: member[1], projectless: false, hostId: 'local' }
            ]);
            const atoms = await services.applicationState.read('electron-persisted-atom-state');
            return { catalog: await services.projectCatalog.readLocalProjects(),
              memberships: await services.threadProjectAssignments.readMemberships(), checkpoint: atoms?.value?.[checkpointKey] ?? null };
          }
          throw Error('Native partial-hydration services unavailable');
        }, { catalog: partialCatalog, projectId, snapshot, checkpointKey });
        assert.equal(stage.partialHydration.checkpoint, null);
        assert.deepEqual(Object.keys(stage.partialHydration.catalog), [projectId]);
        await waitForNativeDisk(selected, native => Object.keys(native['local-projects'] ?? {}).length === 1
          && native['local-projects']?.[projectId] != null
          && native['electron-persisted-atom-state']?.[checkpointKey] == null, 'Incomplete native state must reach disk without a hydration checkpoint');
        assert.deepEqual(await fs.readFile(sidecarPath), beforeBytes);
        stage.assertions.push('native-new-generation-clears-hydration-checkpoint', 'incomplete-native-project-hydration-is-on-disk-without-cas');
      }
      if (inject) {
        if (rustTest) await page.exposeBinding('__isolatedProjectBridge', async (_source, route, request) => {
          if (route === '/fuel/status') return bridgeState(selected);
          assert.equal(route, '/projects/local-state', 'Only the production local snapshot endpoint is allowed');
          assert.equal(request.scope, selected.bridgeScope); assert.equal(request.runtimeRevision, selected.runtimeRevision);
          const pending = rustCommand(selected, 'commit', { revision: request.expectedRevision,
            globals: request.globals, memberships: request.memberships });
          bridgePending.add(pending);
          let value;
          try { value = await pending; } finally { bridgePending.delete(pending); }
          selected.projectSnapshot = value;
          stage.productionBridgeCommits = (stage.productionBridgeCommits || 0) + 1;
          return bridgeState(selected);
        });
        await page.evaluate(productionCode);
        if (projectSeed) {
          stage.beforeNativeProjects = await nativeProjectSnapshot(page);
          assert.equal(Object.keys(stage.beforeNativeProjects.catalog ?? {}).length, 0, 'Must reproduce native null-owner catalog reset before recovery');
          stage.assertions.push('native-main-project-reset-before-recovery');
          if (startupCreation) await createBeforeHydration(page, selected, projectSeed, stage);
        }
        await page.evaluate(({ initialState, productionBridge }) => {
          const assetUrl = name => [...document.scripts].map(script => script.src).find(url => url.split('/').at(-1).split('?')[0] === name) || '';
          const nativeSetInterval = window.setInterval;
          const pollingTimers = [];
          window.setInterval = function (...args) { const timer = Reflect.apply(nativeSetInterval, window, args); pollingTimers.push(timer); return timer; };
          try {
            window.__isolatedSmokeRuntime = installCodexApiModeRuntime({ state: initialState, assetUrl,
              loadModule: name => import(assetUrl(name)), bridge: productionBridge
                ? (route, request) => window.__isolatedProjectBridge(route, request) : async () => initialState });
          } finally { window.setInterval = nativeSetInterval; }
          window.__isolatedSmokeRuntimeTimerIds = pollingTimers;
        }, { initialState: bridgeState(selected), productionBridge: Boolean(rustTest) });
        await page.waitForFunction(() => window.__isolatedSmokeRuntime?.status()?.ready === true, undefined, { timeout: 30000 });
        if (selected.completed) {
          await page.waitForFunction(() => !/What type of work do you do\?|Customize ChatGPT to fit the way you work/.test(document.body?.innerText ?? '')
            && /\bCodex\b/.test(document.body?.innerText ?? '') && /Projects/.test(document.body?.innerText ?? ''), undefined, { timeout: 30000 });
        } else await wait(3000);
        stage.after = await page.evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 12000), runtime: window.__isolatedSmokeRuntime?.status() }));
        assert.equal(stage.after.runtime.ready, true);
        assert.equal(stage.after.runtime.reason, 'coding');
        if (rustTest && selected.projectSnapshot) {
          assert.equal(stage.after.runtime.localProjects?.ready, true);
          assert.equal(stage.after.runtime.localProjects?.reason, 'local-projects-verified');
          stage.assertions.push('production-runtime-and-rust-project-state-verified');
        }
        if (selected.completed) {
          assert.doesNotMatch(stage.after.text, questionnaire, 'Recorded completion must remove repeated questionnaire');
          assert.match(stage.after.text, /\bCodex\b/); assert.match(stage.after.text, /Projects/);
          assert.equal(stage.after.runtime.localOnboarding?.ready, true);
          stage.assertions.push('completed-profile-opens-codex');
        } else {
          assert.match(stage.after.text, questionnaire, 'Fresh users must still complete native onboarding');
          assert.equal(stage.after.runtime.localOnboarding, undefined);
          stage.assertions.push('fresh-profile-keeps-native-questionnaire');
        }
        stage.nativeServices = await nativeSnapshot(page);
        assert.ok(stage.nativeServices?.scopes.length > 0, 'Real committed native API scope must be observable');
        for (const scope of stage.nativeServices.scopes) {
          assert.equal(scope.authMethod, 'apikey'); assert.equal(scope.authLoading, false);
          assert.equal(scope.hasChatGptToken, false); assert.equal(scope.accountPresent, false);
          assert.equal(scope.authAccountPresent, false); assert.equal(scope.authenticatedAccountPresent, false);
        }
        stage.assertions.push('native-api-identity-without-official-account-or-token');
        if (projectSeed) {
          stage.beforeNativeProjects ??= await nativeProjectSnapshot(page);
          if (diagnosticRestore) {
            // Diagnostic opt-in exercises native APIs only; it is NOT proof that
            // the production runtime has restored its persisted project state.
            stage.diagnosticNativeRestore = await page.evaluate(async ({ globals, memberships }) => {
              for (const url of codexApiModeWebpackEntryUrls()) {
                const module = await import(url);
                if (typeof module.__webpack_require__ !== 'function') continue;
                const bindings = codexApiModeWebpackBindings({ module, document, window });
                if (bindings.error) continue;
                const services = bindings.appServices, results = {};
                for (const key of ['local-projects', 'electron-saved-workspace-roots', 'electron-workspace-root-labels'])
                  results[key] = await services.applicationState.write(key, globals[key]);
                results.assignments = await services.threadProjectAssignments.assignIfUnassigned([
                  ...Object.entries(memberships.assignments).map(([threadId, assignment]) => ({ threadId, assignment, projectless: false, hostId: 'local' })),
                  ...memberships.projectlessThreadIds.map(threadId => ({ threadId, assignment: null, projectless: true, hostId: 'local' })),
                ]);
                return results;
              }
              throw Error('Native project bindings unavailable');
            }, selected.projectSnapshot);
          }
          stage.nativeProjects = await nativeProjectSnapshot(page);
          assert.deepEqual(Object.keys(stage.nativeProjects.catalog ?? {}).sort(), projectSeed.projects.map(project => project.id).sort(), 'Native catalog must contain exactly the remaining projects');
          for (const thread of projectSeed.threads) {
            const assignment = stage.nativeProjects.memberships.assignments[thread.id];
            if (thread.projectId === null) {
              assert.equal(assignment, undefined, 'Explicitly removed project membership must stay removed');
              assert.ok(stage.nativeProjects.memberships.projectlessThreadIds.includes(thread.id));
            } else assert.deepEqual(assignment, { projectKind: 'local', projectId: thread.projectId });
          }
          for (const project of projectSeed.projects) await page.getByText(project.name, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
          for (const project of projectSeed.projects) {
            const thread = projectSeed.threads.find(thread => thread.projectId === project.id);
            const container = page.locator('div[data-sidebar-project-kind="local"][data-sidebar-project-container-id]')
              .filter({ has: page.getByText(project.name, { exact: true }) }).first();
            if (thread && !await container.getByText(thread.title, { exact: true }).isVisible()) await page.getByText(project.name, { exact: true }).first().click();
          }
          await page.waitForFunction(({ projects, threads }) => projects.every(project => {
            const members = threads.filter(thread => thread.projectId === project.id);
            return [...document.querySelectorAll('div[data-sidebar-project-kind="local"][data-sidebar-project-container-id]')]
              .some(element => element.dataset.sidebarProjectContainerId.includes(project.id)
                && members.every(thread => element.innerText.includes(thread.title)));
          }), projectSeed, { timeout: 15000 });
          stage.projectUi = await page.evaluate(({ projects, threads }) => {
            const containers = [...document.querySelectorAll('div[data-sidebar-project-kind="local"][data-sidebar-project-container-id]')];
            const text = document.body.innerText;
            return { projectNames: projects.filter(project => text.includes(project.name)).map(project => project.name),
              threadTitles: threads.filter(thread => text.includes(thread.title)).map(thread => thread.title),
              groups: projects.map(project => ({ projectId: project.id,
                threadIds: threads.filter(thread => containers.some(element =>
                  element.dataset.sidebarProjectContainerId.includes(project.id) && element.innerText.includes(thread.title))).map(thread => thread.id) })) };
          }, projectSeed);
          assert.equal(stage.projectUi.projectNames.length, projectSeed.projects.length);
          assert.equal(stage.projectUi.threadTitles.length, projectSeed.threads.length);
          for (const project of projectSeed.projects) assert.deepEqual(stage.projectUi.groups.find(group => group.projectId === project.id).threadIds,
            projectSeed.threads.filter(thread => thread.projectId === project.id).map(thread => thread.id));
          stage.assertions.push('native-projects-and-their-conversations-visible-in-project-containers');
          if (startupCreation) {
            await Promise.all([...bridgePending]);
            const persisted = await rustCommand(selected, 'read');
            const catalog = persisted.globals['local-projects'];
            const created = Object.values(catalog).filter(project => project.name === stage.startupCreation.project.name);
            assert.equal(created.length, 1, 'Early-created project must have one canonical persisted identity');
            assert.equal(Object.keys(catalog).length, projectSeed.projects.length, 'Startup merge must preserve every prior project and the new project');
            for (const project of projectSeed.projects.filter(project => project.id !== stage.startupCreation.project.id))
              assert.equal(catalog[project.id]?.name, project.name, 'An early creation must not turn prior projects into deletions');
            for (const thread of projectSeed.threads) {
              if (thread.projectId !== null) assert.deepEqual(persisted.memberships.assignments[thread.id], { projectKind: 'local', projectId: thread.projectId });
              else assert.ok(persisted.memberships.projectlessThreadIds.includes(thread.id));
            }
            stage.startupCreation.canonicalProjectId = created[0].id;
            stage.startupCreation.persistedRevision = persisted.revision;
            stage.startupCreation.persistedProjectCount = Object.keys(catalog).length;
            selected.projectSnapshot = persisted;
            projectSeed.projects = projectSeed.projects.map(project => project.id === stage.startupCreation.project.id
              ? { ...project, id: created[0].id } : project);
            stage.assertions.push('production-startup-merge-preserves-prior-projects-early-creation-and-memberships');
          }
          stage.after.text = await page.locator('body').innerText();
          if (fastClose) await exerciseFastClose(page, selected, projectSeed, stage, bridgePending);
          if (mutateProjects) {
            stage.groupedScreenshot = path.join(root, label + '-grouped.png');
            await page.screenshot({ path: stage.groupedScreenshot });
            const renamed = projectSeed.projects[0], removed = projectSeed.projects.at(-1);
            const unassigned = projectSeed.threads.find(thread => thread.projectId === projectSeed.projects[2].id);
            const newName = renamed.name + ' renamed';
            stage.nativeEdits = await page.evaluate(async ({ renamedId, newName, removedId, unassignedId }) => {
              for (const url of codexApiModeWebpackEntryUrls()) {
                const module = await import(url);
                if (typeof module.__webpack_require__ !== 'function') continue;
                const bindings = codexApiModeWebpackBindings({ module, document, window });
                if (bindings.error) continue;
                const services = bindings.appServices;
                return { renamed: await services.projects.renameLocal({ projectId: renamedId, name: newName }),
                  unassigned: await services.threadProjectAssignments.setMembership({ threadId: unassignedId, assignment: null, projectless: true, hostId: 'local' }),
                  removed: await services.projects.removeLocal(removedId) };
              }
              throw Error('Native project edit bindings unavailable');
            }, { renamedId: renamed.id, newName, removedId: removed.id, unassignedId: unassigned.id });
            await page.getByText(newName, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
            await page.getByText(removed.name, { exact: true }).first().waitFor({ state: 'hidden', timeout: 15000 });
            const readback = await nativeProjectSnapshot(page);
            assert.equal(readback.catalog[renamed.id].name, newName);
            assert.equal(readback.catalog[removed.id], undefined);
            assert.equal(readback.memberships.assignments[unassigned.id], undefined);
            assert.ok(readback.memberships.projectlessThreadIds.includes(unassigned.id));
            stage.nativeReadbackAfterEdits = readback;
            if (diagnosticRestore) {
              selected.projectSnapshot = { version: 1, revision: selected.projectSnapshot.revision + 1,
                globals: { 'local-projects': readback.catalog, 'electron-saved-workspace-roots': readback.workspaceRoots.roots,
                  'electron-workspace-root-labels': readback.workspaceRoots.labels || {} }, memberships: readback.memberships };
              const snapshotPath = path.join(root, 'diagnostic-project-readback.json');
              await fs.writeFile(snapshotPath, JSON.stringify(selected.projectSnapshot, null, 2));
              stage.diagnosticReadbackFile = snapshotPath;
            } else {
              assert.ok(rustTest, 'Native edits require production or diagnostic persistence');
              const deadline = Date.now() + 20000;
              const persisted = () => selected.projectSnapshot?.globals?.['local-projects']?.[renamed.id]?.name === newName
                && !selected.projectSnapshot?.globals?.['local-projects']?.[removed.id]
                && !selected.projectSnapshot?.memberships?.assignments?.[unassigned.id]
                && selected.projectSnapshot?.memberships?.projectlessThreadIds?.includes(unassigned.id);
              while (!persisted() && Date.now() < deadline) await wait(200);
              assert.ok(persisted(), 'Production runtime must commit native edits before restart');
              stage.persistedAfterEdits = await rustCommand(selected, 'read');
              assert.equal(stage.persistedAfterEdits.globals['local-projects'][renamed.id].name, newName);
              assert.equal(stage.persistedAfterEdits.globals['local-projects'][removed.id], undefined);
              assert.equal(stage.persistedAfterEdits.memberships.assignments[unassigned.id], undefined);
              await page.waitForFunction(() => window.__isolatedSmokeRuntime?.status()?.localProjects?.ready === true, undefined, { timeout: 15000 });
              stage.runtimeAfterEdits = await page.evaluate(() => window.__isolatedSmokeRuntime.status());
              stage.assertions.push('production-rust-cas-persisted-native-edits');
            }
            projectSeed.projects = projectSeed.projects.filter(project => project.id !== removed.id)
              .map(project => project.id === renamed.id ? { ...project, name: newName } : project);
            projectSeed.threads = projectSeed.threads.map(thread =>
              thread.id === unassigned.id || thread.projectId === removed.id ? { ...thread, projectId: null } : thread);
            stage.assertions.push('native-rename-project-delete-project-and-explicitly-unassign-conversation');
          }
        }
      }
      const auth = JSON.parse(await fs.readFile(path.join(selected.home, 'auth.json'), 'utf8'));
      assert.equal(auth.auth_mode, 'apikey'); assert.equal(auth.OPENAI_API_KEY, 'synthetic-isolated-smoke-key'); assert.equal(auth.tokens, undefined);
      stage.assertions.push('disk-auth-stays-synthetic-api-key-only');
      stage.screenshot = path.join(root, label + '-after.png');
      await page.screenshot({ path: stage.screenshot });
      stage.passed = true;
      console.log(JSON.stringify({ label, passed: true, assertions: stage.assertions, screenshot: stage.screenshot }));
    } catch (error) {
      stage.error = String(error.stack || error);
      if (browser) {
        const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('app://-/index.html'));
        if (page) {
          stage.failureText = await page.locator('body').innerText().catch(() => '');
          stage.failureRuntime = await page.evaluate(() => window.__isolatedSmokeRuntime?.status()).catch(() => null);
          stage.failureNativeProjects = await nativeProjectSnapshot(page).catch(error => ({ error: String(error.message) }));
          stage.failureScreenshot = path.join(root, label + '-failed.png');
          await page.screenshot({ path: stage.failureScreenshot }).catch(() => {});
        }
      }
      throw error;
    } finally {
      await fs.writeFile(path.join(root, label + '-process.log'), childLog);
      try {
        stage.nativeClose = await stop({ graceful: (fastClose && !forceClose) || partialHydration,
          gracefulGrant: fastClose && !forceClose ? { scope: selected.bridgeScope, runtimeRevision: selected.runtimeRevision } : null });
      } catch (error) { stage.passed = false; stage.closeError = String(error.stack || error); throw error; }
      if (fastClose && !forceClose) stage.assertions.push('production-runtime-requested-and-completed-native-graceful-exit');
      if (forceClose) stage.assertions.push('owned-force-stop-after-native-disk-proof');
      stage.afterDiskState = await nativeDisk(selected);
    }
    return stage;
  }
  async function finalizeFastClose(selected, projectSeed, stage) {
    const expected = stage.fastCloseExpected;
    assert.ok(expected, 'Fast-close native edit proof is required');
    const finalized = await rustCommand(selected, 'finalize');
    assert.ok(finalized, 'The production finalizer must accept the exact native hydration receipt');
    assert.ok(finalized.revision > stage.fastCloseSnapshotRevision, 'Final capture must persist the unsaved native changes');
    const catalog = finalized.globals['local-projects'];
    assert.equal(catalog[expected.renamedId]?.name, expected.newName);
    assert.equal(catalog[expected.removedId], undefined);
    const created = Object.values(catalog).find(project => project.name === expected.createdName);
    assert.ok(created, 'The native-created project must receive its canonical server identity');
    assert.equal(finalized.memberships.assignments[expected.unassignedId], undefined);
    assert.ok(finalized.memberships.projectlessThreadIds.includes(expected.unassignedId));
    assert.deepEqual(finalized.memberships.assignments[expected.reassignedId], { projectKind: 'local', projectId: created.id });
    selected.projectSnapshot = finalized;
    projectSeed.projects = projectSeed.projects.filter(project => project.id !== expected.removedId)
      .map(project => project.id === expected.renamedId ? { ...project, name: expected.newName } : project);
    projectSeed.projects.push({ id: created.id, name: created.name, root: expected.createdRoot });
    projectSeed.threads = projectSeed.threads.map(thread => thread.id === expected.reassignedId ? { ...thread, projectId: created.id }
      : thread.id === expected.unassignedId || thread.projectId === expected.removedId ? { ...thread, projectId: null } : thread);
    stage.finalizedProjectState = finalized;
    stage.assertions.push('production-finalizer-captured-native-edits-without-background-cas');
  }
  async function seedProjects(selected) {
    assert.equal(child, null, 'Native app must be stopped before fixture writes');
    inside(root, selected.home);
    const request = { root, home: selected.home, projects: [], threads: [] };
    const timestamp = new Date().toISOString();
    for (const [index, name] of ['Alpha', 'Beta', 'Gamma', 'Delta'].entries()) {
      const project = { id: crypto.randomUUID(), name: 'Smoke project ' + name, root: path.join(selected.workspace, name.toLowerCase()) };
      inside(root, project.root); await fs.mkdir(project.root, { recursive: true });
      const thread = { id: crypto.randomUUID(), projectId: project.id, cwd: project.root, title: 'Smoke conversation ' + name,
        timestamp, createdAt: Math.floor(Date.now() / 1000) + index };
      thread.rolloutPath = path.join(selected.home, 'sessions', 'isolated-smoke', 'rollout-' + thread.id + '.jsonl');
      inside(root, thread.rolloutPath); await fs.mkdir(path.dirname(thread.rolloutPath), { recursive: true });
      const payload = { id: thread.id, timestamp, cwd: project.root, originator: 'isolated-smoke-fixture', cli_version: '0.0.0',
        source: 'vscode', model_provider: 'isolated', history_mode: 'legacy' };
      await fs.writeFile(thread.rolloutPath, [{ timestamp, type: 'session_meta', payload },
        { timestamp, type: 'event_msg', payload: { type: 'user_message', message: thread.title, images: [] } }]
        .map(row => JSON.stringify(row)).join('\n') + '\n');
      request.projects.push(project); request.threads.push(thread);
    }
    const manifest = path.join(root, 'project-seed-input.json');
    await fs.writeFile(manifest, JSON.stringify(request));
    const result = await execFile('python', [path.join(__dirname, 'codex-api-isolated-seed.py'), manifest], { timeout: 15000 });
    report.projectSeed = JSON.parse(result.stdout.trim());
    const source = JSON.parse(await fs.readFile(path.join(selected.home, '.codex-global-state.json'), 'utf8'));
    selected.projectSnapshot = { version: 1, revision: 1,
      globals: Object.fromEntries(['local-projects', 'electron-saved-workspace-roots', 'electron-workspace-root-labels'].map(key => [key, source[key]])),
      memberships: { assignments: source['thread-project-assignments'], projectlessThreadIds: source['projectless-thread-ids'] } };
    if (rustTest) {
      selected.projectSnapshot = await rustCommand(selected, 'prepare', { source, statePaths: [report.projectSeed.database] });
      assert.ok(selected.projectSnapshot, 'Production capture must preserve the native fixture');
      report.projectSeed.productionSnapshot = selected.projectSnapshot;
    }
    return request;
  }
  try {
    if (!observe && !process.argv.includes('--projects-only')) { const fresh = await profile('fresh', false); await launch('fresh-api', fresh, { mustStartQuestionnaire: true }); }
    const completed = await profile('completed', true);
    await launch('completed-api', completed, { inject: !observe, mustStartQuestionnaire: true });
    if (!observe) {
      if (!process.argv.includes('--single')) await launch('completed-api-restart', completed, { mustStartQuestionnaire: true });
      const projects = await seedProjects(completed);
      await launch('completed-api-projects', completed, { projectSeed: projects, mutateProjects: Boolean(diagnosticRestore || rustTest) });
      if (diagnosticRestore || rustTest) await launch('completed-api-project-edits-restart', completed, { projectSeed: projects });
      if (rustTest) {
        const fast = await launch('completed-api-fast-close-edits', completed, { projectSeed: projects, fastClose: true });
        await finalizeFastClose(completed, projects, fast);
        const forced = await launch('completed-api-fast-close-restart-and-force-edits', completed,
          { projectSeed: projects, fastClose: true, forceClose: true });
        await finalizeFastClose(completed, projects, forced);
        await launch('completed-api-force-close-edits-restart', completed, { projectSeed: projects });
        const partial = await launch('completed-api-partial-hydration', completed, { inject: false, partialHydration: true });
        const before = await fs.readFile(path.join(completed.home, '.gaoge-api-local-projects.json'));
        const refused = await rustCommand(completed, 'finalize');
        assert.equal(refused, null, 'The production finalizer must defer incomplete hydration without a checkpoint');
        assert.deepEqual(await fs.readFile(path.join(completed.home, '.gaoge-api-local-projects.json')), before);
        assert.equal(crypto.createHash('sha256').update(before).digest('hex'), partial.snapshotBeforePartialSha256);
        partial.assertions.push('production-finalizer-refused-partial-hydration-with-byte-identical-snapshot');
        await launch('completed-api-partial-hydration-recovery', completed, { projectSeed: projects });
        await launch('completed-api-startup-create-before-hydration', completed, { projectSeed: projects, startupCreation: true });
        const startupRestart = await launch('completed-api-startup-created-project-restart', completed, { projectSeed: projects });
        startupRestart.assertions.push('startup-merged-projects-survive-native-restart-with-canonical-identities');
      }
    }
    report.passed = report.stages.every(stage => stage.passed);
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    let cleanupError;
    try { await stop(); } catch (error) { cleanupError = error; report.cleanupError = String(error.stack || error); report.passed = false; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(root, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: reportPath, passed: report.passed, stages: report.stages.length }));
    if (cleanupError) throw cleanupError;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
