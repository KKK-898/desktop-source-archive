# ===========================================================================
#  高歌 Free —— Codex 发送按钮诊断探针（开发者用，不是客户版）
#
#  和 export-fuel-log.ps1 的区别：这份不写给客户，只给开发者定位"按钮为什么灰"。
#  仍然只读：不修改登录状态、设置、应用文件，不发送任何消息，不联网。
#
#  隐私：只记录"输入框有没有内容"这样的布尔/长度，不记录任何输入文字、
#        账号、邮箱、令牌、API Key、请求头或对话内容。
#        页面提示只按固定文案做匹配，导出的是提示类别名（如 quota-exhausted-zh），
#        不是页面原文 —— 早先版本扫关键词时误把对话气泡写进了报告，已修。
#
#  用法：在这个文件所在目录打开 PowerShell，执行
#      powershell -NoProfile -ExecutionPolicy Bypass -File .\probe-diag.ps1
#  或直接双击 probe-diag.bat
# ===========================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
}
if (-not (Test-Path -LiteralPath $desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
}
if (-not (Test-Path -LiteralPath $desktop)) { $desktop = (Get-Location).Path }

function Write-Step { param([string]$T) Write-Host ''; Write-Host "  $T" -ForegroundColor Cyan }
function Write-Ok   { param([string]$T) Write-Host "  $T" -ForegroundColor Green }
function Write-Bad  { param([string]$T) Write-Host "  $T" -ForegroundColor Red }

function Stop-WithMessage {
    param([string]$Message)
    Write-Host ''
    Write-Host $Message -ForegroundColor Yellow
    Write-Host ''
    Read-Host '按回车键关闭'
    exit 1
}

Write-Host ''
Write-Host '高歌 Free — 发送按钮诊断' -ForegroundColor White
Write-Host ('-' * 62)

$portFile = Join-Path $env:APPDATA 'Gaoge Free\codex-plugins-enabled'

function Test-CdpPort {
    param([int]$Port)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 `
             -Uri "http://127.0.0.1:$Port/json/list"
        if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
    } catch { }
    return $null
}

Write-Step '正在查找 Codex 调试端口…'

$candidates = New-Object System.Collections.Generic.List[int]
if (Test-Path -LiteralPath $portFile) {
    $raw = (Get-Content -LiteralPath $portFile -Raw -ErrorAction SilentlyContinue)
    if ($raw) {
        $parsed = 0
        if ([int]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -gt 1) { $candidates.Add($parsed) }
    }
}
foreach ($p in @(9239, 9240, 9241, 9222)) {
    if (-not $candidates.Contains($p)) { $candidates.Add($p) }
}

$targets = $null
$usedPort = 0
foreach ($p in $candidates) {
    $t = Test-CdpPort -Port $p
    if ($t) { $targets = $t; $usedPort = $p; break }
}

if (-not $targets) {
    Stop-WithMessage @'
没能连上 Codex 窗口。

请先确认高歌 Free 已经打开、Codex 窗口也开着，然后重试。
'@
}
Write-Ok "调试端口：$usedPort"

# ---------------------------------------------------------------------------
# 选页面：优先级与 Rust 侧 cdp_page_target_priority 一致
# ---------------------------------------------------------------------------
function Get-PageRank {
    param($Target)
    $url = [string]$Target.url
    if ($url -eq 'app://-/index.html') { return 0 }
    if ($url.StartsWith('app://-/index.html')) { return 1 }
    $aux = ($url -match 'avatar') -and ($url -match 'overlay')
    if ((-not $aux) -and ($url -match 'codex|localhost|file://')) { return 2 }
    return 3
}

$pages = @($targets | Where-Object { $_.webSocketDebuggerUrl })
if (-not $pages.Count) { Stop-WithMessage '没找到可调试的页面。' }
$ranked = $pages | Sort-Object { Get-PageRank $_ }
$page = $ranked[0]
$wsUrl = [string]$page.webSocketDebuggerUrl
$wsUrl = $wsUrl -replace '^ws://\[::1\]', 'ws://127.0.0.1'
$wsUrl = $wsUrl -replace '^ws://localhost', 'ws://127.0.0.1'
Write-Ok "页面：$($page.url)"

Write-Step '正在读取诊断数据…'

function Invoke-PageEvaluate {
    param([string]$WsUrl, [int]$Port, [string]$Expression, [int]$Id = 1)
    $socket = $null
    try {
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        $socket.Options.SetRequestHeader('Origin', "http://127.0.0.1:$Port")
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter(20000)
        $token = $cts.Token
        $socket.ConnectAsync([Uri]$WsUrl, $token).GetAwaiter().GetResult() | Out-Null

        $payload = @{
            id     = $Id
            method = 'Runtime.evaluate'
            params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
        } | ConvertTo-Json -Depth 8 -Compress

        $outBytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $outSeg = [ArraySegment[byte]]::new($outBytes)
        $socket.SendAsync($outSeg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $token
        ).GetAwaiter().GetResult() | Out-Null

        $buffer = New-Object byte[] 524288
        $seg = [ArraySegment[byte]]::new($buffer)
        $sb = New-Object Text.StringBuilder
        while ($true) {
            $result = $socket.ReceiveAsync($seg, $token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
            [void]$sb.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
            if ($result.EndOfMessage) { break }
        }
        $raw = $sb.ToString()
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        $reply = $raw | ConvertFrom-Json
        if ($reply.PSObject.Properties.Name -contains 'error') { throw ($reply.error.message) }
        if ($reply -and $reply.result -and $reply.result.result) { return $reply.result.result.value }
        return $null
    } finally {
        if ($socket) { $socket.Dispose() }
    }
}

# ---------------------------------------------------------------------------
# 探针 1：补丁运行态
# ---------------------------------------------------------------------------
$runtimeExpression = @'
(() => {
  const rt = window.__gaogeCodexFuelRuntime;
  if (!rt) return JSON.stringify({ present: false });
  // v9 根本没有 decisions 这个字段，读出来是 undefined。
  // 不区分"字段不存在"和"字段存在但为空"，就会把 v9 的缺失误读成"闸门从未关闭"。
  const hasBuffer = Object.prototype.hasOwnProperty.call(rt, 'decisions') && rt.decisions !== undefined;
  // diagnostics() 是官方给的汇总口，顺手取一份做交叉核对。
  let diag = null;
  try { if (typeof rt.diagnostics === 'function') diag = rt.diagnostics(); } catch (e) { diag = String(e && e.message); }
  return JSON.stringify({
    present: true,
    diagnostics: diag,
    version: rt.version, enabled: rt.enabled, ready: rt.ready,
    reason: rt.reason, adapterMode: rt.adapterMode, hasAdapter: rt.hasAdapter,
    discoveryError: rt.discoveryError, routeError: rt.routeError, error: rt.error,
    submitScopeBound: rt.submitScopeBound,
    speedInstalled: rt.speedInstalled,
    hasDecisionBuffer: hasBuffer,
    decisionCount: hasBuffer && rt.decisions ? rt.decisions.length : null,
    decisions: (rt.decisions || []).slice(-24),
    // v11 及更早：闸门关着却永远不进路由分支的几条路都不写 decisions，
    // 于是"空日志"和"补丁根本没加载"看起来一模一样。
    // v12 起补上这两个口：分支清单 + 计数器。
    hasBranchRecord: Object.prototype.hasOwnProperty.call(rt, 'branches') && rt.branches !== undefined,
    branches: (rt.branches || []).slice(-12),
    stats: (() => {
      const s = rt.stats;
      if (!s) return null;
      // 只搬运诊断用的字段，值一律是计数 / 类型标签 / 内部 kind 枚举。
      const out = {};
      for (const key of ['resolveCalls', 'resolveSkipped', 'noContext', 'remoteKind',
        'rootBranch', 'derivedEvals', 'derivedNativeNotBlocked', 'derivedNativeOpen',
        'derivedDisposed', 'derivedBlocked', 'released', 'kept',
        'lastNativeType', 'lastNativeShape', 'lastKind', 'lastReason']) {
        if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key];
      }
      return out;
    })(),
    // 这两个值由 Rust 侧注入，用来确认"跑的到底是哪个构建"。
    appVersion: window.__GAOGE_CODEX_APP_VERSION__ || null,
    runtimeRevision: window.__GAOGE_DESIRED_RUNTIME_REVISION__ || null
  });
})()
'@

# ---------------------------------------------------------------------------
# 探针 2：输入框与发送按钮的真实 DOM 状态
#    只记录布尔值与长度，绝不记录输入内容本身。
# ---------------------------------------------------------------------------
$domExpression = @'
(() => {
  const editors = Array.from(document.querySelectorAll("[contenteditable='true'], textarea"));
  const composerText = (node) => {
    if (!node) return '';
    return node.value != null ? String(node.value) : String(node.textContent || '');
  };

  // 之前只报第一个 editor —— 这次实测 editorCount=2，报错的那一个可能不是我们看的那个。
  // 改成把每个 editor 都列出来，谁有文字一目了然。
  const editorList = editors.map((e, i) => ({
    index: i,
    tag: e.tagName,
    placeholder: e.getAttribute('placeholder') || null,
    hasText: composerText(e).trim().length > 0,
    textLength: composerText(e).length,
    // 刻意不导出文字内容
    contenteditable: e.getAttribute('contenteditable'),
    disabled: e.disabled === true,
    ariaDisabled: e.getAttribute('aria-disabled'),
    visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
  }));

  // 有文字的那个才是真正的输入框；都没有就取可见的第一个。
  const focused = editorList.find(e => e.hasText)
    || editorList.find(e => e.visible)
    || editorList[0] || null;
  const editor = focused ? editors[focused.index] : null;

  const buttonInfo = (b) => ({
    testid: b.getAttribute('data-testid') || null,
    aria: b.getAttribute('aria-label') || null,
    title: b.title || null,
    text: (b.textContent || '').trim().slice(0, 24) || null,
    type: b.getAttribute('type') || null,
    disabled: b.disabled,
    ariaDisabled: b.getAttribute('aria-disabled'),
    dataState: b.getAttribute('data-state'),
    // 按钮靠哪个属性变灰，答案就在这里
    classHint: (b.className || '').toString().slice(0, 200) || null,
    // 灰化到底是不是纯样式（Tailwind 的 disabled: 变体不写 HTML 的 disabled 属性）。
    // 之前这里直接对整串 className 做正则，而 Codex 的按钮类名里本来就带
    // `disabled:opacity-50` 这种变体前缀，于是恒为 true，这个字段一直是个误报。
    // 现在先按空白切词、去掉变体前缀，只留真正生效的类，并给出命中的那个词。
    disabledClassToken: (() => {
      const tokens = (b.className || '').toString().split(/\s+/).filter(Boolean);
      const state = tokens.filter(t => !t.includes(':'));
      const hit = state.find(t => t === 'disabled' || /^(opacity-[0-9]+|cursor-not-allowed|pointer-events-none)$/.test(t));
      return hit || null;
    })()
  });

  const buttons = Array.from(document.querySelectorAll('button')).map(buttonInfo).filter(b => /send|submit|发送/i.test(
    String(b.testid) + String(b.aria) + String(b.title) + String(b.text)
  ));

  // 输入框所在 form 里的所有按钮（发送按钮通常在这里）
  const form = editor && editor.closest ? editor.closest('form') : null;
  const formButtons = form ? Array.from(form.querySelectorAll('button')).map(buttonInfo) : null;

  // 之前这里按关键词扫全页叶子文本，结果把用户自己打的对话内容也写进了报告，
  // 和"不含对话内容"的承诺相矛盾。现在只做固定文案匹配，返回枚举名而不是原文。
  const known = [
    { id: 'quota-exhausted-zh',   re: /使用额度已用完/ },
    { id: 'quota-exhausted-en',   re: /usage (limit|has been) reached|out of usage|usage limit reached/i },
    { id: 'upgrade-now-zh',       re: /立即升级/ },
    { id: 'upgrade-now-en',       re: /upgrade for more/i },
    { id: 'reset-wait-zh',        re: /等待使用量于/ },
    { id: 'reset-wait-en',        re: /wait for usage to reset/i },
    { id: 'switch-account-zh',    re: /切换账号|更换账号/ },
    { id: 'switch-account-en',    re: /switch account|change account/i }
  ];
  const hits = [];
  // 只在 main / 顶层容器里找提示条，跳过对话列表和编辑器区域。
  const zones = Array.from(document.querySelectorAll('main, [role="alert"], [role="status"]'))
    .filter(z => !z.closest('[contenteditable="true"]'))
    .slice(0, 12);
  for (const zone of zones) {
    const text = String(zone.textContent || '');
    for (const k of known) {
      if (k.re.test(text) && !hits.includes(k.id)) hits.push(k.id);
    }
  }

  return JSON.stringify({
    pageUrl: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    editorCount: editors.length,
    editors: editorList,
    editor: focused,
    sendLikeButtons: buttons,
    formButtons: formButtons,
    // 只报"页面上出现了哪一种已知提示"，不报页面原文。
    quotaHints: hits
  });
})()
'@

# ---------------------------------------------------------------------------
# 探针 3：补丁接管到的上下文（判断 refresh 有没有扫到输入框）
# ---------------------------------------------------------------------------
$contextExpression = @'
(() => {
  const rt = window.__gaogeCodexFuelRuntime;
  const chains = [];
  const seenFibers = new Set();
  const seenChains = new Set();
  let duplicateCount = 0;

  const collect = (chainLike) => {
    const map = chainLike instanceof Map ? chainLike
              : (chainLike && chainLike.chain instanceof Map ? chainLike.chain : null);
    if (!map) return;
    for (const node of map.values()) {
      if (!node || !(node.familyBindings instanceof Map)) continue;
      // familyBindings 是 Map<family对象, Map<cacheKey字符串, descriptor>>。
      // maitai.* 那些符号挂在 family 对象上，不是挂在 Map 上，
      // 所以必须遍历 Map 的 key 去读 —— 读 Map 本身永远得到空数组。
      const families = [];
      for (const family of node.familyBindings.keys()) {
        if (!family || (typeof family !== 'object' && typeof family !== 'function')) continue;
        const symbols = Object.getOwnPropertySymbols(family)
          .map(k => String(k.description || ''))
          .filter(d => d.indexOf('maitai.') === 0);
        const members = node.familyBindings.get(family);
        families.push({
          symbols: symbols,
          // 补丁只给 hardBlocked 这个 family 写过 .scope，可用来认人。
          hasScope: Object.prototype.hasOwnProperty.call(family, 'scope'),
          scopeSet: family.scope != null,
          memberKeys: members instanceof Map ? Array.from(members.keys()).slice(0, 6) : null,
          memberCount: members instanceof Map ? members.size : null
        });
      }
      // 关键：token.id 是 Symbol，String() 之后每个 chain 都变成 "Symbol()"，
      // 之前按 nodeId 去重导致 contextCount 恒为 1，后面所有 chain 都被丢掉了。
      // 按 Map 实例本身去重，并把每个 chain 的 kind 都报出来。
      const kinds = [];
      for (const cand of map.values()) {
        const k = cand && cand.value ? cand.value.kind : null;
        if (k && !kinds.includes(k)) kinds.push(k);
      }
      const familiesWrapped = [];
      for (const family of node.familyBindings.keys()) {
        const rk = Object.getOwnPropertySymbols(family)
          .find(s => s.description === 'maitai.resolveFamilyMemberInternal');
        // 补丁把 resolve 换成了自己的函数，函数名可用来确认补丁真的装上了。
        familiesWrapped.push(rk ? String(family[rk] && family[rk].name || 'anonymous') : 'no-resolve');
      }
      const entry = { nodeId: String(node.token && node.token.id != null ? node.token.id : '?'),
                      kinds: kinds,
                      size: map.size,
                      hasStore: !!node.store,
                      familyCount: families.length,
                      resolveFns: familiesWrapped.slice(0, 6),
                      hasContextKind: kinds.some(k => ['local', 'new', 'cloud', 'chatgpt'].includes(k)),
                      families: families.slice(0, 4) };
      if (seenChains.has(map)) { duplicateCount++; }
      else { seenChains.add(map); chains.push(entry); }
    }
  };

  const roots = [document.body,
    ...Array.from(document.querySelectorAll("[contenteditable='true'], form, main")).slice(0, 80),
    ...Array.from(document.querySelectorAll('button')).slice(0, 80)];

  for (const element of roots) {
    if (!element) continue;
    let start = null;
    for (let c = element, d = 0; c && d < 6; c = c.parentElement, d++) {
      const k = Object.keys(c).find(n => n.startsWith('__reactFiber$') || n.startsWith('__reactInternalInstance$'));
      if (k) { start = c[k]; break; }
    }
    for (let fiber = start, d = 0; fiber && d < 100; fiber = fiber.return, d++) {
      for (const cur of [fiber, fiber.alternate]) {
        if (!cur || seenFibers.has(cur)) continue;
        seenFibers.add(cur);
        collect(cur.memoizedProps && cur.memoizedProps.value);
        collect(cur.pendingProps && cur.pendingProps.value);
        let dep = cur.dependencies && cur.dependencies.firstContext;
        for (let i = 0; dep && i < 20; i++, dep = dep.next) collect(dep.memoizedValue);
      }
    }
  }

  return JSON.stringify({
    runtimePresent: !!rt,
    submitScopeBound: rt ? rt.submitScopeBound : null,
    fiberCount: seenFibers.size,
    contextCount: chains.length,
    // 如果这个数不为 0，说明有 chain 因去重被折叠掉了 —— 报告里必须能看到。
    duplicateChains: duplicateCount,
    contexts: chains.slice(0, 10)
  });
})()
'@

$report = [ordered]@{}

foreach ($probe in @(
    @{ key = 'runtime';  expr = $runtimeExpression;  id = 1 },
    @{ key = 'dom';      expr = $domExpression;      id = 2 },
    @{ key = 'contexts'; expr = $contextExpression;  id = 3 })) {
    try {
        $value = Invoke-PageEvaluate -WsUrl $wsUrl -Port $usedPort -Expression $probe.expr -Id $probe.id
        if ([string]::IsNullOrWhiteSpace([string]$value)) {
            $report[$probe.key] = $null
        } else {
            $report[$probe.key] = ([string]$value | ConvertFrom-Json)
        }
    } catch {
        $report[$probe.key] = @{ probeError = $_.Exception.Message }
    }
}

# ---------------------------------------------------------------------------
# 汇总成一份文件
# ---------------------------------------------------------------------------
# 版本标识优先取页面里由 Rust 侧注入的真值，探针自己不再硬编码 null。
$rtInfo = $report['runtime']
$appVersion = $null
$runtimeRevision = $null
# 注意：PowerShell 5.1 不允许把 if(...){}else{} 直接写成哈希表的值，必须先算好再放进去。
$runtimeVersion = $null
if ($rtInfo -and $rtInfo.present) {
    if ($rtInfo.appVersion) { $appVersion = [string]$rtInfo.appVersion }
    if ($rtInfo.runtimeRevision) { $runtimeRevision = [string]$rtInfo.runtimeRevision }
    if ($rtInfo.version) { $runtimeVersion = $rtInfo.version }
}

$record = [ordered]@{
    exportedAt      = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    app             = 'Gaoge Free'
    kind            = 'send-button-diagnosis'
    source          = "http://127.0.0.1:$usedPort"
    pageUrl         = [string]$page.url
    appVersion      = $appVersion
    runtimeRevision = $runtimeRevision
    runtimeVersion  = $runtimeVersion
    note            = '只读诊断。不含输入文字、账号、令牌或对话内容。'
    runtime         = $report['runtime']
    dom             = $report['dom']
    contexts        = $report['contexts']
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outPath = Join-Path $desktop "高歌发送诊断-$stamp.json"
$utf8Bom = New-Object Text.UTF8Encoding($true)
[IO.File]::WriteAllText($outPath, ($record | ConvertTo-Json -Depth 14), $utf8Bom)

# ---------------------------------------------------------------------------
# 屏幕上直接给一份人话结论
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ('-' * 62)
Write-Ok '诊断完成！'
Write-Host ''
Write-Host "文件已保存到桌面：$(Split-Path -Leaf $outPath)" -ForegroundColor White

$rt = $report['runtime']
$dom = $report['dom']

if ($rt -and $rt.present) {
    Write-Host ''
    Write-Host '  —— 补丁状态 ——' -ForegroundColor Cyan
    Write-Host "  运行时版本   : $($rt.version)  (>=10 才有决策缓冲)"
    Write-Host "  应用版本     : $($rt.appVersion)"
    Write-Host "  期望修订     : $($rt.runtimeRevision)"
    Write-Host "  已启用       : $($rt.enabled)"
    Write-Host "  适配模式     : $($rt.adapterMode)"
    Write-Host "  前置条件     : $($rt.reason)"
    Write-Host "  作用域已接管 : $($rt.submitScopeBound)"
    if ($rt.routeError) { Write-Host "  路由错误     : $($rt.routeError)" -ForegroundColor Red }
    if ($rt.discoveryError) { Write-Host "  发现错误     : $($rt.discoveryError)" -ForegroundColor Red }

    $usage = $rt.diagnostics.usageCache
    if ($usage) {
        Write-Host ''
        Write-Host '  —— 额度缓存（与注入状态分开）——' -ForegroundColor Cyan
        Write-Host "  已安装 / 启用 : $($usage.installed) / $($usage.enabled)"
        Write-Host "  判定原因      : $($usage.reason)"
        Write-Host "  识别 / 改写数 : $($usage.supported) / $($usage.unlocked)"
        Write-Host "  可见输入框    : $($usage.visibleEditors)；隐藏输入框：$($usage.hiddenEditors)"
        Write-Host "  可见会话      : $($usage.visibleComposers)；未识别输入框：$($usage.unresolvedEditors)"
        if ($usage.error) {
            Write-Host "  缓存错误      : $($usage.error)" -ForegroundColor Red
        } elseif (-not $usage.enabled) {
            Write-Host '  → 已注入不等于已解锁；当前额度缓存没有启用改写。' -ForegroundColor Yellow
        } elseif ($usage.unlocked -gt 0) {
            Write-Host '  → 已改写界面读取的额度缓存；按钮可能还有上传等其他禁用条件。' -ForegroundColor Green
        } else {
            Write-Host '  → 当前没有缓存被改写，需结合查询数量和发送按钮状态判断。' -ForegroundColor Yellow
        }
    }

    if (-not $rt.hasDecisionBuffer) {
        # v9 没有这个字段。绝不能把"字段不存在"读成"闸门从未关闭"。
        Write-Host '  决策缓冲     : 这个版本没有该字段（v9），本次无法据此判断闸门状态。' -ForegroundColor Yellow
    } else {
        $count = if ($rt.decisionCount -ne $null) { $rt.decisionCount } else { 0 }
        Write-Host "  决策条数     : $count"
        if ($count -eq 0) {
            Write-Host '  → 此额度分支尚无放行记录；普通账号额度和按钮状态请看上面的缓存与下方按钮诊断。' -ForegroundColor Yellow
        } else {
            foreach ($d in @($rt.decisions)) {
                $rel = if ($d.released) { '放行' } else { '保留原生值' }
                Write-Host "    · kind=$($d.kind) $rel ($($d.reason))"
            }
        }
    }

    # v12 新增。空日志有两种完全不同的原因，计数器能把它们分开。
    if (-not $rt.hasBranchRecord) {
        Write-Host '  分支记录     : 这个版本没有该字段（v11 及更早），无法区分"补丁没跑到"和"补丁没加载"。' -ForegroundColor Yellow
    } else {
        $branches = @($rt.branches)
        if ($branches.Count -eq 0) {
            Write-Host '  分支记录     : 空（wrapper 走过，但没有一条记录分支）。'
        } else {
            foreach ($b in $branches) { Write-Host "    · $($b.branch)" }
        }
        $s = $rt.stats
        if ($s) {
            Write-Host ("  计数         : resolve={0} 跳过={1} 无上下文={2} 远端kind={3} 根兜底={4}" -f `
                $s.resolveCalls, $s.resolveSkipped, $s.noContext, $s.remoteKind, $s.rootBranch)
            Write-Host ("                 derived求值={0} 未关闭={1} 本就开着={2} 关着={3} | 放行={4} 保留={5}" -f `
                $s.derivedEvals, $s.derivedNativeNotBlocked, $s.derivedNativeOpen, $s.derivedBlocked, $s.released, $s.kept)
            if ($s.lastNativeType) {
                Write-Host ("                 原生值类型={0} 形态={1} 最后一次kind={2}" -f `
                    $s.lastNativeType, $s.lastNativeShape, $s.lastKind)
            }
            # 一次性判读：只有这里能说清按钮为什么是灰的。
            if ($s.resolveCalls -eq 0) {
                Write-Host '  → wrapper 一次都没被调用：补丁没装上，或这个 composer 不经由该 family。' -ForegroundColor Yellow
            } elseif ($s.derivedEvals -eq 0 -and $s.rootBranch -eq 0 -and $s.remoteKind -eq 0 -and $s.noContext -eq 0) {
                Write-Host '  → wrapper 被调用了，但 React 从未求值它返回的 derived。' -ForegroundColor Yellow
            } elseif ($s.remoteKind -gt 0 -and $s.released -eq 0) {
                Write-Host '  → 这条 composer 的 kind 被判为远端，补丁根本不接管，原生闸门原样生效。' -ForegroundColor Yellow
            } elseif ($s.rootBranch -gt 0 -and $s.released -eq 0) {
                Write-Host '  → 走的是根作用域兜底分支：该订阅没有任务作用域，路由检查根本没执行。' -ForegroundColor Yellow
            } elseif ($s.derivedNativeNotBlocked -gt 0 -and $s.derivedBlocked -eq 0) {
                Write-Host '  → 原生值不是布尔 true，路由分支进不去，按钮灰是原生值直接带出来的。' -ForegroundColor Yellow
            } elseif ($s.derivedBlocked -gt 0 -and $s.released -gt 0) {
                Write-Host '  → 闸门确实关着，补丁也确实放行了；此时按钮还灰说明另有阻塞项。' -ForegroundColor Green
            }
        }
    }
} else {
    Write-Bad '  补丁未注入：页面上没有 __gaogeCodexFuelRuntime。'
}

if ($dom) {
    Write-Host ''
    Write-Host '  —— 输入框 / 发送按钮 ——' -ForegroundColor Cyan
    $editors = @($dom.editors)
    if ($editors.Count -eq 0) {
        Write-Host '  没找到输入框' -ForegroundColor Yellow
    } else {
        foreach ($e in $editors) {
            $vis = if ($e.visible) { '可见' } else { '隐藏' }
            Write-Host ("  [{0}] {1} {2} | 有内容={3} | 长度={4}" -f `
                $e.index, $e.tag, $vis, $e.hasText, $e.textLength)
        }
        $any = @($editors | Where-Object { $_.hasText }).Count
        if ($any -eq 0) {
            Write-Host '  → 所有输入框都是空的：此时发送按钮灰是正常行为，测不到问题。' -ForegroundColor Yellow
        }
    }
    Write-Host "  输入框数量   : $($dom.editorCount)"
    $send = @($dom.sendLikeButtons)
    if ($send.Count -eq 0) {
        Write-Host '  没找到疑似发送按钮' -ForegroundColor Yellow
    } else {
        foreach ($b in $send) {
            # PowerShell 5.1 没有空值合并运算符，用显式判断代替。
            $label = if ($b.testid) { $b.testid } elseif ($b.aria) { $b.aria } else { $b.text }
            $ariaDisabled = if ($b.ariaDisabled) { $b.ariaDisabled } else { '-' }
            $dataState = if ($b.dataState) { $b.dataState } else { '-' }
            Write-Host ("  按钮 {0} | disabled={1} | aria-disabled={2} | data-state={3}" -f `
                $label, $b.disabled, $ariaDisabled, $dataState)
        }
    }
    if ($dom.quotaHints -and @($dom.quotaHints).Count) {
        Write-Host ''
        Write-Host '  —— 页面上出现的已知额度提示 ——' -ForegroundColor Cyan
        foreach ($h in @($dom.quotaHints)) { Write-Host "  · $h" }
    }
}

$ctx = $report['contexts']
if ($ctx) {
    Write-Host ''
    Write-Host '  —— 补丁接管到的上下文 ——' -ForegroundColor Cyan
    Write-Host "  扫描到 fiber : $($ctx.fiberCount)"
    Write-Host "  上下文数量   : $($ctx.contextCount)"
    if ($ctx.contextCount -eq 0) {
        Write-Host '  → 一个上下文都没扫到：refresh 拿不到输入框所在的 fiber。' -ForegroundColor Yellow
    } else {
        foreach ($c in @($ctx.contexts)) {
            $kindStr = if (@($c.kinds).Count) { (@($c.kinds) -join ',') } else { '(无 composer kind)' }
            Write-Host "  · chain=$($c.size) store=$($c.hasStore) family数=$($c.familyCount) | kind: $kindStr"
            if (-not $c.hasContextKind) {
                Write-Host '      → 这条 chain 里没有 local/new/cloud/chatgpt 节点，补丁认不出 composer。' -ForegroundColor Yellow
            }
            $rf = if (@($c.resolveFns).Count) { (@($c.resolveFns) -join ',') } else { '(无)' }
            Write-Host "      resolve 函数: $rf"
            foreach ($f in @($c.families)) {
                $sym = if (@($f.symbols).Count) { (@($f.symbols) -join ',') } else { '(无 maitai 符号)' }
                $sc = if ($f.scopeSet) { '已绑定 scope' } else { '未绑定 scope' }
                Write-Host "      - $sym | $sc | 成员 $($f.memberCount)"
            }
        }
    }
}

Write-Host ''
Write-Host '请把这个 JSON 文件发回来。' -ForegroundColor White
Write-Host ''
Read-Host '按回车键关闭'
