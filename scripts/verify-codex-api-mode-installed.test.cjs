const assert = require('node:assert/strict')
const test = require('node:test')
const { assertApiModePassed } = require('./verify-codex-api-mode-installed.cjs')

test('API mode release failure distinguishes a test file from a named assertion', () => {
  const stdout = ['not ok 1 - scripts\\codex-api-onboarding.test.cjs',
    'not ok 2 - installed route restores local completion',
    'not ok 3 - scripts/codex-api-project-state.test.cjs',
    'not ok 4 - installed project owner is current', '# fail 4'].join('\n')
  assert.throws(() => assertApiModePassed({status: 1, stdout}), error => {
    assert.match(error.message, /2 file-level failure\(s\): codex-api-onboarding\.test\.cjs, codex-api-project-state\.test\.cjs/)
    assert.match(error.message, /2 named test failure\(s\): installed route restores local completion; installed project owner is current/)
    return true
  })
  assert.throws(() => assertApiModePassed({status: null, signal: 'SIGTERM'}), /SIGTERM/)
})

test('API mode release check requires actual renderer and backend tests without skips', () => {
  const stdout = 'ok 1 - installed native API Work fails before normalization\nok 2 - installed renderer bindings use native state\n# fail 0\n# skipped 0\n'
  assert.doesNotThrow(() => assertApiModePassed({ status: 0, stdout }))
  for (const result of [
    { status: 1, stdout }, { status: 0, stdout, error: Error('timeout') },
    { status: 0, stdout: stdout.replace('ok 2', 'not ok 2') },
    { status: 0, stdout: stdout.replace('native state', 'native state # SKIP missing') },
    { status: 0, stdout: stdout.replace('native state', 'native state # TODO later') },
    { status: 0, stdout: stdout.replace('# skipped 0', '# skipped 1') },
    { status: 0, stdout: stdout.replace('installed renderer', 'synthetic renderer') },
  ]) assert.throws(() => assertApiModePassed(result))
})

test('API mode release check requires native evidence for the selected renderer architecture', () => {
  const reports = {
    esm: 'ok 1 - installed native API Work fails before normalization\nok 2 - installed renderer bindings use native state\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n',
    webpack: 'ok 1 - installed webpack native settings use API Coding policy without granting account access\nok 2 - installed webpack renderer bindings use native state and setter without initializing modules\nok 3 - installed webpack native Coding selects Codex sidebar without rewriting home composer preference\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n',
  }
  const oldLeafReport = reports.webpack
  const added = [
    'real native RPC proxies restore API completion and Coding without assigning methods',
    'native scoped API hydration preserves only its reviewed shared completion whitelist',
    'native API hydration filters private atoms without relying on owner-state cleanup',
    'installed webpack mode events recognize only the committed native product selector',
    'installed webpack API mode captures native selector and portal events until account switch or disposal',
    'native direct welcome redirects home when shared completion is restored despite pending=true',
    'native first API onboarding is preserved and genuine completion still persists without a principal',
    'installed native onboarding restores a verified API completion receipt after an empty host hydration',
    'installed native onboarding keeps a fresh API identity on welcome without a receipt',
    'installed native project chain and final sidebar preserve projects and complete legacy memberships in pure API mode',
    'installed native project sidebar survives repeated API official API transitions without changing membership or account permissions',
    'installed native first-pass migration matches all Rust-restored local memberships beyond the pending queue',
    'installed native completed-read checkpoint restricts writes to pending memberships',
    'installed native completed migration never replays stale legacy assignments',
    'real main owner selection clears desktop catalog while app-server projects survive',
    'real native main services restore canonical API projects and memberships then CAS persist',
    'API rename removal and explicit projectless edits persist without replaying an older GET',
    'deleting every local project remains a persisted empty catalog across repeated polling',
    'native explicit assignment and projectless conflicts stay unverified and are not overwritten',
    'newer GET revisions cannot silently authorize overwriting a concurrent snapshot',
    'native owner change blocks hydration before any catalog write',
    'installed native project guard checks the active owner before accessing project data',
    'installed API project guard rejects legacy snapshots on the native shared store',
    'real native account switch closes old RPC before selecting another owner',
    'same API renderer stops on a different home',
    'full native message-port RPC restores catalog and membership without replacing service methods',
    'confirmed API snapshot conflicts with startup database membership remain visible and unmodified',
    'same-home settings revision renews authorization without replaying a deleted API project',
    "verified native checkpoint publishes one non-shared key only after successful CAS",
    "incomplete native hydration and rejected CAS never publish a checkpoint",
    "malformed CAS checkpoint receipts cannot authorize native exit capture",
    "delayed native checkpoint IPC retries the receipt without another snapshot commit",
    "subsequent CAS updates checkpoint revision and nonce without exposing the receipt in status",
    "native null-owner reset removes checkpoint even when the previous owner was already null",
    "disposing runtime preserves the verified native checkpoint for final exit capture",
    "home runtime grant and account changes during CAS prevent checkpoint publication",
    "checkpoint publication requires host hydration a valid receipt and current identity",
    "installed webpack graceful quit requires the current API grant and defers the native message",
    "installed webpack graceful quit rejects stale disabled unsupported and official sessions",
    "installed webpack queued graceful quit rechecks grant identity freshness and disposal before sending",
    "installed webpack graceful quit uses live API identity without restarting project polling",
    "first native hydration merges projects created before the bridge without dropping saved projects",
    "first native hydration keeps live same-ID edits and unions only valid catalog roots and labels",
    "a fresh guard honors matched native checkpoint deletions and membership changes",
    "a mismatched native checkpoint waits for a fresh snapshot before treating live deletions as authoritative",
    "foreign or malformed native checkpoints never authorize initial snapshot replay",
  ]
  reports.webpack = reports.webpack.replace('# fail 0', added.map((name, i) => `ok ${i + 4} - ${name}`).join('\n') + '\n# fail 0')
  assert.throws(() => assertApiModePassed({ status: 0, stdout: oldLeafReport }, 'webpack'), 'Leaf-only success no longer satisfies the release check')
  const fs = require('node:fs'), path = require('node:path');
  const legacy = new Set([...fs.readFileSync(path.join(__dirname, 'codex-api-project-state.test.cjs'), 'utf8').matchAll(/^run\('([^']+)'/gm)].map(match=>match[1]));
  assert.equal(legacy.size,26,'all legacy positive restore assertions must remain');
  const modern = [...fs.readFileSync(path.join(__dirname, 'codex-api-project-shared-state.test.cjs'), 'utf8').matchAll(/^run\('([^']+)'/gm)].map(match=>match[1]);
  const modernReport=reports.webpack.split('\n').filter(line=>!legacy.has(line.replace(/^ok \d+ - /,''))).join('\n')
    .replace('# fail 0',modern.map((name,i)=>'ok '+(200+i)+' - '+name).join('\n')+'\n# fail 0');
  assert.doesNotThrow(()=>assertApiModePassed({status:0,stdout:modernReport},'webpack','content-owner'));
  assert.throws(()=>assertApiModePassed({status:0,stdout:modernReport},'webpack','renderer-owner'));
  assert.throws(()=>assertApiModePassed({status:0,stdout:reports.webpack},'webpack','content-owner'));
  assert.throws(()=>assertApiModePassed({status:0,stdout:modernReport},'webpack','unreviewed'));
  for(const name of modern){
    const line=modernReport.split('\n').find(line=>line.endsWith(' - '+name));
    for(const replacement of ['',line+' # SKIP missing',line+' # TODO future',line.replace(/^ok /,'not ok ')])
      assert.throws(()=>assertApiModePassed({status:0,stdout:modernReport.replace(line,replacement)},'webpack','content-owner'));
  }

  const obsoleteReport=reports.webpack.replace('native scoped API hydration preserves only its reviewed shared completion whitelist','native scoped API hydration loses existing shared completion and renders welcome')
  assert.throws(() => assertApiModePassed({status:0,stdout:obsoleteReport},'webpack'), /Required native API mode check did not run/, 'An obsolete behavior name must not satisfy the reviewed native contract')
  for (let i = 4; i < 4 + added.length; i++) {
    const line = reports.webpack.split('\n').find(line => line.startsWith(`ok ${i} - `))
    for (const replacement of [line.replace(/^ok /, 'not ok '), line + ' # SKIP missing', line + ' # TODO later', line + ' unrelated suffix', line.replace(' - ', ' - unrelated prefix '), '']) {
      assert.throws(() => assertApiModePassed({ status: 0, stdout: reports.webpack.replace(line, replacement) }, 'webpack'))
    }
  }
  for (const format of ['esm', 'webpack']) {
    const stdout = reports[format]
    assert.doesNotThrow(() => assertApiModePassed({ status: 0, stdout }, format))
    assert.throws(() => assertApiModePassed({ status: 0, stdout: reports[format === 'esm' ? 'webpack' : 'esm'] }, format))
    for (const bad of [
      stdout.replace('ok 2', 'not ok 2'),
      ...(format === 'webpack' ? [stdout.replace('ok 3', 'not ok 3')] : []),
      stdout.replace('\n# fail', ' # SKIP missing\n# fail'),
      stdout.replace('\n# fail', ' # TODO later\n# fail'),
      stdout.replace('# skipped 0', '# skipped 1'),
      stdout.replace('# cancelled 0', '# cancelled 1'),
      stdout.replace('# todo 0', '# todo 1'),
    ]) assert.throws(() => assertApiModePassed({ status: 0, stdout: bad }, format))
  }
})
