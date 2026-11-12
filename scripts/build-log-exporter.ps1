#Requires -Version 5.1
<#
    生成「一键日志导出器」的打包脚本（在 Windows 上运行）

    用途
    ----
    把同目录下的 export-fuel-log.ps1 打包成一个客户可以直接双击的单个 exe。
    客户双击后，JSON 自动生成到桌面。

    为什么用 base64 内嵌
    --------------------
    最早的写法是把 ps1 原文塞进 C# 的逐字字符串里，再把双引号翻倍。这个做法
    有两个坑：正文里 here-string 的结束标记 "@ 会被当成 C# 字符串的结束符，
    编译直接报错；正文里的反斜杠和 $ 也要逐个处理才不出事。改成 base64 之后，
    正文里只剩 A-Za-z0-9+/=，引号、反引号、$ 全部天然安全。

    运行方式
    --------
    在脚本所在目录打开 PowerShell，执行：
        powershell -NoProfile -ExecutionPolicy Bypass -File .\build-log-exporter.ps1
    或右键本文件 -> 使用 PowerShell 运行。

    产出（放在本目录）
    ------------------
    方案 A（默认）：gaoge-log-export.exe
        单文件，不依赖外部 ps1。用 Windows 自带的 csc.exe 编译。
    方案 B（-Method B）：gaoge-log-export-selfextract.exe
        IExpress 自解压包，内含 bat + ps1。方案 A 失败时的备用。

    本脚本只读取同目录的 export-fuel-log.ps1，调用 Windows 自带工具，
    不修改任何项目文件，不联网，不读取账号、令牌或对话内容。
#>

[CmdletBinding()]
param(
    [ValidateSet('A', 'B', 'Both')]
    [string]$Method = 'A',

    [string]$SourceScript
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($SourceScript)) {
    $SourceScript = Join-Path $scriptDir 'export-fuel-log.ps1'
}

function Write-Head { param([string]$Text) Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [! ] $Text" -ForegroundColor Yellow }
function Write-Bad  { param([string]$Text) Write-Host "  [X ] $Text" -ForegroundColor Red }

Write-Head '=== 高歌日志导出器 打包工具 ==='

# ---------------------------------------------------------------------------
# 0. 读取源脚本（按原始字节，BOM 保留在字节流里）
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $SourceScript)) {
    Write-Bad "找不到源脚本：$SourceScript"
    Write-Host '  请确认 export-fuel-log.ps1 与本脚本在同一个文件夹里。'
    Read-Host '按回车键关闭'
    exit 1
}

$rawBytes = [IO.File]::ReadAllBytes($SourceScript)
$hasBom = $rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF

Write-Host "  源脚本 : $SourceScript"
Write-Host "  大小   : $($rawBytes.Length) 字节"
if ($hasBom) {
    Write-Ok '源脚本带 UTF-8 BOM（中文能正确显示）'
} else {
    Write-Warn '源脚本没有 UTF-8 BOM，打包后中文可能乱码。建议先加 BOM。'
}

$nulCount = 0
for ($bi = 0; $bi -lt $rawBytes.Length; $bi++) {
    if ($rawBytes[$bi] -eq 0) { $nulCount++ }
}
if ($nulCount -gt 0) {
    Write-Bad "源脚本里有 $nulCount 个空字符，可能是编码错了，中止。"
    Read-Host '按回车键关闭'
    exit 1
}

# ---------------------------------------------------------------------------
# 1. 找 C# 编译器（Windows 自带，不需要装任何东西）
# ---------------------------------------------------------------------------
function Find-Csc {
    $roots = @($env:WINDIR, "$env:ProgramFiles", "${env:ProgramFiles(x86)}") |
             Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    foreach ($root in $roots) {
        foreach ($sub in @('Microsoft.NET\Framework64', 'Microsoft.NET\Framework')) {
            $fw = Join-Path $root $sub
            if (-not (Test-Path -LiteralPath $fw)) { continue }
            $found = Get-ChildItem -LiteralPath $fw -Directory -Filter 'v4*' -ErrorAction SilentlyContinue |
                     Sort-Object Name -Descending |
                     ForEach-Object { Join-Path $_.FullName 'csc.exe' } |
                     Where-Object { Test-Path -LiteralPath $_ } |
                     Select-Object -First 1
            if ($found) { return $found }
        }
    }
    return $null
}

$csc = Find-Csc
if ($csc) { Write-Ok "找到 C# 编译器：$csc" }
else      { Write-Warn '没找到 csc.exe，方案 A 会跳过' }

# ---------------------------------------------------------------------------
# 2. C# 模板
#    用单引号 here-string（@' ... '@）：不做变量展开，里面的引号和反斜杠
#    全部原样保留，不会被 PowerShell 解析器碰到。
#    __PAYLOAD__ 是占位符，运行时替换成 base64 常量声明。
# ---------------------------------------------------------------------------
$csharpTemplate = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class GaogeLogExporter
{
__PAYLOAD__

    private static int Main(string[] args)
    {
        string tempFile = null;
        try
        {
            // 解出来就是源 ps1 的原始字节，与源文件逐字节一致（BOM 也在里面），
            // 所以 PowerShell 5.1 会正确按 UTF-8 解码，中文提示不会乱码。
            byte[] bytes = Convert.FromBase64String(PayloadB64);

            tempFile = Path.Combine(Path.GetTempPath(),
                                    "gaoge-log-export-" + Guid.NewGuid().ToString("N") + ".ps1");
            File.WriteAllBytes(tempFile, bytes);

            return Run(tempFile);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[X] 启动失败：" + ex.Message);
            return 1;
        }
        finally
        {
            // finally 里不能 throw，否则会盖掉真正的返回值
            if (tempFile != null)
            {
                try { File.Delete(tempFile); } catch (Exception) { }
            }
        }
    }

    private static int Run(string ps1)
    {
        // 先试 Windows PowerShell，再试 PowerShell 7
        string[] hosts = new string[] { "powershell.exe", "pwsh.exe" };
        Exception last = null;

        foreach (string host in hosts)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName        = host;
                psi.Arguments       = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"";
                psi.UseShellExecute = false;   // 复用当前控制台，客户能看到进度

                Process proc = Process.Start(psi);
                proc.WaitForExit();
                return proc.ExitCode;
            }
            catch (Exception ex)
            {
                last = ex;
            }
        }

        Console.Error.WriteLine("[X] 找不到可用的 PowerShell：" + last.Message);
        return 1;
    }
}
'@

# ---------------------------------------------------------------------------
# 3. 方案 A：编译单文件 exe
# ---------------------------------------------------------------------------
function Build-SchemeA {
    param([string]$CscPath, [byte[]]$PayloadBytes, [string]$WorkDir, [string]$OutPath)

    Write-Head '方案 A：编译单文件 exe'

    $b64 = [Convert]::ToBase64String($PayloadBytes)

    # 折成 C# 常量声明。每行 100 字符，C# 里用 + 拼接。
    $nl = "`r`n"
    $declLines = New-Object Collections.Generic.List[string]
    $declLines.Add('    private const string PayloadB64 =')
    $chunkSize = 100
    for ($ci = 0; $ci -lt $b64.Length; $ci += $chunkSize) {
        $len = [Math]::Min($chunkSize, $b64.Length - $ci)
        $chunk = $b64.Substring($ci, $len)
        $tail = if (($ci + $len) -ge $b64.Length) { ';' } else { ' +' }
        $declLines.Add('        "' + $chunk + '"' + $tail)
    }
    $decl = [string]::Join($nl, $declLines.ToArray())

    $source = $csharpTemplate.Replace('__PAYLOAD__', $decl)

    $csFile = Join-Path $WorkDir 'GaogeLogExporter.cs'
    # csc 靠 BOM 判断编码，带 BOM 写出才能正确读到里面的中文。
    [IO.File]::WriteAllText($csFile, $source, (New-Object Text.UTF8Encoding($true)))

    $cscArgs = @(
        '/nologo'
        '/target:exe'
        '/platform:anycpu'
        '/optimize+'
        "/out:$OutPath"
        $csFile
    )

    $result = & $CscPath @cscArgs 2>&1
    $exit = $LASTEXITCODE

    if ($exit -ne 0 -or -not (Test-Path -LiteralPath $OutPath)) {
        Write-Bad "编译失败（csc 退出码 $exit）"
        $result | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        return $false
    }

    $size = (Get-Item -LiteralPath $OutPath).Length
    Write-Ok "已生成：$OutPath（$([math]::Round($size / 1KB, 1)) KB）"
    return $true
}

# ---------------------------------------------------------------------------
# 4. 方案 B：IExpress 自解压包（备用，不需要 csc）
# ---------------------------------------------------------------------------
function Build-SchemeB {
    param([string]$WorkDir, [string]$OutPath, [string]$Ps1Path)

    Write-Head '方案 B：IExpress 自解压包'

    $iexpress = Join-Path $env:WINDIR 'System32\iexpress.exe'
    if (-not (Test-Path -LiteralPath $iexpress)) {
        Write-Warn '系统里没有 iexpress.exe，跳过方案 B'
        return $false
    }

    $stage = Join-Path $WorkDir 'stage'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -LiteralPath $Ps1Path -Destination (Join-Path $stage 'export-fuel-log.ps1') -Force

    # 自解压包里用 ASCII 文件名和 ASCII 内容，避免解压路径出现中文
    $launcher = @(
        '@echo off'
        'chcp 65001 >nul 2>&1'
        'setlocal'
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export-fuel-log.ps1"'
        'if errorlevel 1 ('
        '  echo.'
        '  echo Export failed. Please screenshot this window and send it back.'
        '  pause'
        ')'
        'endlocal'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $stage 'export-fuel-log.bat'), $launcher, [Text.Encoding]::ASCII)

    # SED 描述文件。TargetName 用裸文件名 + 指定工作目录，避开路径里带空格的坑。
    $sed = @(
        '[Version]'
        'Class=IEXPRESS'
        'SEDVersion=3'
        '[Options]'
        'PackagePurpose=InstallApp'
        'ShowInstallProgramWindow=1'
        'HideExtractAnimation=0'
        'UseLongFileName=1'
        'InsideCompressed=0'
        'CAB_FixedSize=0'
        'CAB_ResvCodeSigning=0'
        'RebootMode=N'
        'InstallPrompt='
        'DisplayLicense='
        'FinishMessage='
        ('TargetName=' + (Split-Path -Leaf $OutPath))
        'FriendlyName=Gaoge Log Export'
        'AppLaunched=export-fuel-log.bat'
        'PostInstallCmd=<None>'
        'AdminQuietInstCmd='
        'UserQuietInstCmd='
        'SourceFiles=SourceFiles'
        '[Strings]'
        'FILE0="export-fuel-log.bat"'
        'FILE1="export-fuel-log.ps1"'
        '[SourceFiles]'
        ('SourceFiles0=' + $stage + '\')
        '[SourceFiles0]'
        '%FILE0%='
        '%FILE1%='
    ) -join "`r`n"

    $sedFile = Join-Path $WorkDir 'gaoge.sed'
    [IO.File]::WriteAllText($sedFile, $sed, [Text.Encoding]::ASCII)

    $proc = Start-Process -FilePath $iexpress -ArgumentList @('/N', '/Q', $sedFile) `
                          -WorkingDirectory $WorkDir -Wait -PassThru

    $produced = Join-Path $WorkDir (Split-Path -Leaf $OutPath)
    if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $produced)) {
        Write-Bad "IExpress 失败（退出码 $($proc.ExitCode)）"
        return $false
    }

    Move-Item -LiteralPath $produced -Destination $OutPath -Force
    $size = (Get-Item -LiteralPath $OutPath).Length
    Write-Ok "已生成：$OutPath（$([math]::Round($size / 1KB, 1)) KB）"
    return $true
}

# ---------------------------------------------------------------------------
# 5. 跑起来
# ---------------------------------------------------------------------------
$workDir = Join-Path $env:TEMP ('gaoge-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$made = New-Object Collections.Generic.List[string]

try {
    if (($Method -eq 'A' -or $Method -eq 'Both') -and $csc) {
        $outA = Join-Path $scriptDir 'gaoge-log-export.exe'
        if (Build-SchemeA -CscPath $csc -PayloadBytes $rawBytes -WorkDir $workDir -OutPath $outA) {
            $made.Add($outA)
        }
    }

    if ($Method -eq 'B' -or $Method -eq 'Both') {
        $outB = Join-Path $scriptDir 'gaoge-log-export-selfextract.exe'
        if (Build-SchemeB -WorkDir $workDir -OutPath $outB -Ps1Path $SourceScript) {
            $made.Add($outB)
        }
    }
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Head '=== 结果 ==='
if ($made.Count -eq 0) {
    Write-Bad '什么都没生成。'
    if ($Method -eq 'A' -and -not $csc) {
        Write-Host ''
        Write-Host '  这台机器上没有 csc.exe，可以改用方案 B：' -ForegroundColor Yellow
        Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-log-exporter.ps1 -Method B' -ForegroundColor Yellow
    } else {
        Write-Host '  把本窗口截图发回来看。'
    }
    Read-Host '按回车键关闭'
    exit 1
}

foreach ($f in $made) {
    Write-Ok ([IO.Path]::GetFileName($f))
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor White
Write-Host '  1) 先在你这台机器上双击跑一次，确认桌面出现 JSON。'
Write-Host '  2) 没跑通过之前不要发给客户。'
Write-Host ''
Write-Host '客户那边可能弹「Windows 已保护你的电脑」：' -ForegroundColor Yellow
Write-Host '  点「更多信息」->「仍要运行」。' -ForegroundColor Yellow
Write-Host ''
Read-Host '按回车键关闭'
