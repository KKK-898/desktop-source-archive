# ============================================================================
#  高歌 Free —— 中转解锁日志一键导出
# ----------------------------------------------------------------------------
#  用途：从正在运行的 Codex 窗口里取出发送键额度门的运行时决策日志，
#        写到桌面上的一个 JSON 文件，发给客服排查。
#
#  数据来源：Gaoge Free 通过 CDP（本机调试端口）注入到 Codex 渲染进程里的
#            window.__gaogeCodexFuelRuntime.diagnostics()。整个过程是只读的：
#            不修改登录状态、不改配置、不碰应用文件、不发送任何消息。
#
#  隐私：只导出路由决策字段。不读取账号、邮箱、令牌、API Key、
#        请求头或对话内容。
# ============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Write-Step { param([string]$Text) Write-Host "  $Text" }
function Write-Ok   { param([string]$Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  $Text" -ForegroundColor Yellow }
function Write-Bad  { param([string]$Text) Write-Host "  $Text" -ForegroundColor Red }

function Stop-WithMessage {
    param([string]$Text)
    Write-Host ''
    Write-Bad $Text
    Write-Host ''
    Read-Host '按回车键关闭'
    exit 1
}

# ---------------------------------------------------------------------------
# 0. 准备
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '高歌 Free — 中转解锁日志导出' -ForegroundColor Cyan
Write-Host '------------------------------------------------------------'
Write-Host ''

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
}
if (-not (Test-Path -LiteralPath $desktop)) {
    Stop-WithMessage '找不到桌面文件夹，无法保存结果。'
}

# ---------------------------------------------------------------------------
# 1. 找调试端口
#    App 默认用 9239，但如果该端口被占用会临时换一个随机端口，
#    并把实际端口写进 %APPDATA%\Gaoge Free\codex-plugins-enabled。
#    所以先读文件，再退回默认端口，最后扫一遍常见候选端口。
# ---------------------------------------------------------------------------
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
        if ([int]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -gt 1) {
            $candidates.Add($parsed)
        }
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

请先确认：
  1) 高歌 Free 已经打开，并且 Codex 窗口是开着的（不是只开了高歌主界面）；
  2) 高歌 Free 里的「插件增强」是开启状态；
  3) 如果 Codex 窗口是刚打开的，等十几秒让它完全加载好再试一次。

如果还是不行，把这句话发回给客服：CDP 端口连不上。
'@
}

Write-Ok "已找到 Codex 调试端口：$usedPort"

# ---------------------------------------------------------------------------
# 2. 挑出 Codex 主页面
#    与 App 内部的选择规则保持一致：只取 type=page 且有调试地址的，
#    排除头像浮层那个辅助页面，优先 app://-/index.html。
# ---------------------------------------------------------------------------
function Get-PageRank {
    param($Target)
    $url = ([string]$Target.url).ToLower()
    $hay = ("$($Target.title) $($Target.url)").ToLower()
    $aux = $url.Contains('initialroute=%2favatar-overlay') -or
           $url.Contains('initialroute=/avatar-overlay') -or
           $url.Contains('/avatar-overlay')
    if ($url -eq 'app://-/index.html') { return 0 }
    if ($url.StartsWith('app://-/index.html') -and -not $aux) { return 1 }
    if ((-not $aux) -and ($hay.Contains('codex') -or $hay.Contains('localhost') -or $hay.Contains('file://'))) { return 2 }
    return 3
}

$pages = @($targets | Where-Object {
    $_.type -eq 'page' -and -not [string]::IsNullOrWhiteSpace($_.webSocketDebuggerUrl)
} | Sort-Object { Get-PageRank $_ })

if ($pages.Count -eq 0) {
    Stop-WithMessage '找到了调试端口，但里面没有可用的 Codex 页面。请确认 Codex 窗口已经加载完成，然后重试。'
}

$page = $pages[0]
Write-Ok "已定位 Codex 页面：$($page.url)"

# ---------------------------------------------------------------------------
# 3. 通过 WebSocket 向页面求值
# ---------------------------------------------------------------------------
$wsUrl = [string]$page.webSocketDebuggerUrl
$wsUrl = $wsUrl -replace '^ws://\[::1\]', 'ws://127.0.0.1'
if ($wsUrl -match '^ws://localhost') { $wsUrl = $wsUrl -replace '^ws://localhost', 'ws://127.0.0.1' }

$expression = @'
(() => {
  const rt = window.__gaogeCodexFuelRuntime;
  if (!rt) return JSON.stringify({ ok: false, error: "runtime-missing",
    hint: "插件未注入到 Codex 窗口" });
  const d = (typeof rt.diagnostics === "function") ? rt.diagnostics() : null;
  return JSON.stringify({
    ok: true,
    version: rt.version,
    enabled: rt.enabled,
    ready: rt.ready,
    reason: rt.reason,
    adapterMode: rt.adapterMode,
    discoveryError: rt.discoveryError,
    routeError: rt.routeError,
    submitScopeBound: rt.submitScopeBound,
    speedInstalled: rt.speedInstalled,
    usageCache: (d && d.usageCache) || rt.usageCache || null,
    health: (d && d.health) || rt.health || null,
    decisions: (d && d.decisions) || rt.decisions || []
  });
})()
'@

# 版本号从页面里问，不碰文件系统：这些全局量由 App 注入。
$versionExpression = @'
JSON.stringify({
  appVersion: window.__GAOGE_CODEX_APP_VERSION__ || null,
  runtimeRevision: window.__GAOGE_DESIRED_RUNTIME_REVISION__ || null,
  userAgent: navigator.userAgent
})
'@

Write-Step '正在读取日志…'

# 在一次连接里求两次值：日志字段 + 版本信息。
function Invoke-PageEvaluate {
    param(
        [string]$WsUrl,
        [int]$Port,
        [string]$Expression,
        [int]$Id = 1
    )
    $socket = $null
    try {
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        # 启动参数带 --remote-allow-origins，握手必须带这个 Origin，否则会被拒绝。
        $socket.Options.SetRequestHeader('Origin', "http://127.0.0.1:$Port")

        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter(15000)
        $token = $cts.Token

        $socket.ConnectAsync([Uri]$WsUrl, $token).GetAwaiter().GetResult() | Out-Null

        $payload = @{
            id     = $Id
            method = 'Runtime.evaluate'
            params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
        } | ConvertTo-Json -Depth 8 -Compress

        $outBytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $outSeg = [ArraySegment[byte]]::new($outBytes)
        $socket.SendAsync(
            $outSeg,
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true, $token
        ).GetAwaiter().GetResult() | Out-Null

        $buffer = New-Object byte[] 262144
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
        if ($reply.PSObject.Properties.Name -contains 'error') {
            throw ($reply.error.message)
        }
        if ($reply -and $reply.result -and $reply.result.result) {
            return $reply.result.result.value
        }
        return $null
    } finally {
        if ($socket) { $socket.Dispose() }
    }
}

$text = $null
try {
    $text = Invoke-PageEvaluate -WsUrl $wsUrl -Port $usedPort -Expression $expression -Id 1
} catch {
    Stop-WithMessage @"
连接 Codex 页面失败：$($_.Exception.Message)

请确认 Codex 窗口没有被关闭，然后重试。如果反复失败，
把这句话发回给客服：WebSocket 连接失败。
"@
}

if ([string]::IsNullOrWhiteSpace([string]$text)) {
    Stop-WithMessage 'Codex 页面没有返回任何内容。请确认 Codex 窗口正常显示，然后重试。'
}

# ---------------------------------------------------------------------------
# 4. 解析返回值
#    Invoke-PageEvaluate 已经把回包中的 value 取出来了，这里只需解析页面
#    自己返回的那段 JSON 字符串。
# ---------------------------------------------------------------------------
$data = $null
try { $data = [string]$text | ConvertFrom-Json } catch {
    Stop-WithMessage "日志内容格式无法解析。原始返回：$text"
}

if ($data -and ($data.PSObject.Properties.Name -contains 'ok') -and -not $data.ok) {
    Stop-WithMessage @"
没有在 Codex 窗口里找到插件运行时。

这通常说明插件增强没有生效。请：
  1) 回到高歌 Free 主界面，确认「插件增强」是开启的；
  2) 完全关闭 Codex 窗口，再重新打开一次；
  3) 等 Codex 界面完全加载后，重新双击本脚本。

如果还是不行，把这句话发回给客服：runtime-missing。
"@
}

$appInfo = $null
try {
    $infoText = Invoke-PageEvaluate -WsUrl $wsUrl -Port $usedPort -Expression $versionExpression -Id 2
    if (-not [string]::IsNullOrWhiteSpace([string]$infoText)) {
        $appInfo = [string]$infoText | ConvertFrom-Json
    }
} catch { }

# ---------------------------------------------------------------------------
# 5. 写明文件
# ---------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outPath = Join-Path $desktop "高歌中转日志-$stamp.json"

$record = [ordered]@{
    exportedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    app        = 'Gaoge Free'
    source     = "http://127.0.0.1:$usedPort"
    pageUrl    = [string]$page.url
    appVersion = if ($appInfo) { $appInfo.appVersion } else { $null }
    runtimeRevision = if ($appInfo) { $appInfo.runtimeRevision } else { $null }
    userAgent  = if ($appInfo) { $appInfo.userAgent } else { $null }
    fuel       = $data
}

# 带 BOM 存 UTF-8：Windows 记事本和多数工具都能正确识别中文。
$json = $record | ConvertTo-Json -Depth 12
$utf8Bom = New-Object Text.UTF8Encoding($true)
[IO.File]::WriteAllText($outPath, $json, $utf8Bom)

# ---------------------------------------------------------------------------
# 6. 给客户一个能看懂的结论
# ---------------------------------------------------------------------------
$decisions = @()
if ($data -and $data.decisions) { $decisions = @($data.decisions) }

Write-Host ''
Write-Host '------------------------------------------------------------'
Write-Ok '导出成功！'
Write-Host ''
Write-Host "文件已保存到桌面：$([IO.Path]::GetFileName($outPath))" -ForegroundColor White
Write-Host ''
Write-Host '本次记录：'
Write-Host "  运行时版本   : $($data.version)"
Write-Host "  适配模式     : $($data.adapterMode)"
Write-Host "  决策条数     : $($decisions.Count)"

if ($decisions.Count -gt 0) {
    $last = $decisions[-1]
    $state = if ($last.released) { '已放行' } else { '仍锁定' }
    Write-Host "  最后一次判断 : $state（原因：$($last.reason)）"
    Write-Host "  输入框类型   : $($last.kind)"
} else {
    Write-Host '  最后一次判断 : 无记录' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '请把这个 JSON 文件发给客服。' -ForegroundColor Cyan
Write-Host ''
Read-Host '按回车键关闭'
