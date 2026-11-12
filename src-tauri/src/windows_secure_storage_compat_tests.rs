//! Real Windows PowerShell 5.1 compatibility checks using fabricated secrets only.
//! These tests intentionally fail if Windows PowerShell is missing or unusable.

use super::{decrypt, encrypt};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::{self, Read, Write};
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const POWERSHELL_TEST_TIMEOUT: Duration = Duration::from_secs(30);

// The wrapper handles empty values before entering Windows secure storage. All
// fixtures here are nonempty and exercise values accepted by the old cmdlets.
const FIXTURES: &[&str] = &[
    "fake-image-key-for-compatibility-only-123",
    "中文测试密钥 / image 🎨🔐 / 𠮷",
    " \t  leading and trailing whitespace  \r\n\t ",
    "quotes ' \" dollar $ backtick ` slash \\ punctuation ; & | < >",
    "第一行\r\nsecond line\n第三行\t🙂",
];

enum PipeResult {
    Input(io::Result<()>),
    Stdout(io::Result<Vec<u8>>),
    Stderr(io::Result<Vec<u8>>),
}

fn read_pipe(mut pipe: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn run_legacy_powershell(body: &str, input_lines: &[String]) -> Result<Vec<String>, String> {
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') {{
    throw 'Compatibility tests require Windows PowerShell 5.1 Desktop.'
}}
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
{body}
"#
    );
    let deadline = Instant::now() + POWERSHELL_TEST_TIMEOUT;
    let mut child = crate::hidden_command("powershell.exe")
        // A parent PowerShell 7 process can prepend its incompatible modules.
        // Let Windows PowerShell rebuild its own path, then explicitly import
        // its system Security module instead of relying on module autoloading.
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!("Windows PowerShell 5.1 compatibility test could not start: {error}")
        })?;

    let mut stdin = child.stdin.take().expect("piped PowerShell stdin");
    let stdout = child.stdout.take().expect("piped PowerShell stdout");
    let stderr = child.stderr.take().expect("piped PowerShell stderr");
    let input = input_lines.join("\n");
    let (sender, receiver) = mpsc::channel();
    let input_sender = sender.clone();
    thread::spawn(move || {
        let result = stdin.write_all(input.as_bytes());
        // Closing stdin is essential: the script reads until EOF.
        drop(stdin);
        let _ = input_sender.send(PipeResult::Input(result));
    });
    let stdout_sender = sender.clone();
    thread::spawn(move || {
        let _ = stdout_sender.send(PipeResult::Stdout(read_pipe(stdout)));
    });
    thread::spawn(move || {
        let _ = sender.send(PipeResult::Stderr(read_pipe(stderr)));
    });

    // Drain both output pipes while the process runs. Waiting for process exit
    // before reading them can deadlock once either pipe reaches its capacity.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Windows PowerShell compatibility test exceeded 30 seconds".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Windows PowerShell compatibility test wait failed: {error}"
                ));
            }
        }
    };

    let mut stdout = None;
    let mut stderr = None;
    let mut input_error = None;
    for _ in 0..3 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining).map_err(|error| {
            format!("PowerShell compatibility test pipe did not finish: {error}")
        })? {
            PipeResult::Input(result) => input_error = result.err(),
            PipeResult::Stdout(result) => {
                stdout =
                    Some(result.map_err(|error| format!("PowerShell stdout failed: {error}"))?);
            }
            PipeResult::Stderr(result) => {
                stderr =
                    Some(result.map_err(|error| format!("PowerShell stderr failed: {error}"))?);
            }
        }
    }
    let stderr = stderr.expect("received PowerShell stderr");
    if !status.success() {
        return Err(format!(
            "Windows PowerShell compatibility test exited with {status}: {}",
            String::from_utf8_lossy(&stderr)
        ));
    }
    if let Some(error) = input_error {
        return Err(format!(
            "PowerShell compatibility test stdin failed: {error}"
        ));
    }
    let stdout = String::from_utf8(stdout.expect("received PowerShell stdout"))
        .map_err(|error| format!("PowerShell returned non-ASCII test data: {error}"))?;
    Ok(stdout.lines().map(str::to_owned).collect())
}

fn utf16_base64(value: &str) -> String {
    let bytes: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

#[test]
fn decrypts_existing_windows_powershell_51_ciphertext_without_migration() {
    let input: Vec<String> = FIXTURES.iter().map(|value| utf16_base64(value)).collect();
    let encrypted = run_legacy_powershell(
        r#"foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {
    $plain = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($line))
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    try {
        [Console]::Out.WriteLine((ConvertFrom-SecureString -SecureString $secure))
    } finally {
        $secure.Dispose()
    }
}"#,
        &input,
    )
    .expect("legacy Windows PowerShell encryption must work on the test machine");

    assert_eq!(encrypted.len(), FIXTURES.len());
    for (index, (ciphertext, expected)) in encrypted.iter().zip(FIXTURES).enumerate() {
        assert!(
            ciphertext.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "legacy fixture {index} must use the existing hexadecimal format"
        );
        assert_eq!(
            decrypt(ciphertext).expect("native DPAPI must read unchanged legacy ciphertext"),
            *expected,
            "legacy fixture {index} must preserve every UTF-16 character"
        );
    }
}

#[test]
fn native_ciphertext_remains_readable_by_windows_powershell_51() {
    let encrypted: Vec<String> = FIXTURES
        .iter()
        .map(|value| encrypt(value).expect("native DPAPI encryption must succeed"))
        .collect();
    for ciphertext in &encrypted {
        assert!(!ciphertext.is_empty());
        assert_eq!(ciphertext.len() % 2, 0);
        assert!(
            ciphertext.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "native ciphertext must keep the legacy raw hexadecimal format"
        );
    }

    let plaintext = run_legacy_powershell(
        r#"Add-Type -AssemblyName System.Security
foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {
    $secure = ConvertTo-SecureString -String $line
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($plain))
        $bytes = New-Object byte[] ($line.Length / 2)
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            $bytes[$i] = [Convert]::ToByte($line.Substring($i * 2, 2), 16)
        }
        $unprotected = [Security.Cryptography.ProtectedData]::Unprotect(
            $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ([Convert]::ToBase64String($unprotected) -cne $encoded) {
            throw 'Native ciphertext differs from explicit CurrentUser/no-entropy DPAPI plaintext.'
        }
        [Console]::Out.WriteLine($encoded)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $secure.Dispose()
    }
}"#,
        &encrypted,
    )
    .expect("legacy Windows PowerShell must read native ciphertext without conversion");

    assert_eq!(plaintext.len(), FIXTURES.len());
    for (index, (encoded, expected)) in plaintext.iter().zip(FIXTURES).enumerate() {
        assert_eq!(
            *encoded,
            utf16_base64(expected),
            "native fixture {index} must preserve text when read by the old client"
        );
    }
}
