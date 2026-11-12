//! Native DPAPI storage compatible with PowerShell's default SecureString format.
//!
//! PowerShell protects UTF-16LE bytes (without a terminator), using CurrentUser
//! scope and no optional entropy, then writes the protected bytes as hex.
//! See: https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/security/SecureStringHelper.cs

use std::ptr;
use std::sync::atomic::{compiler_fence, Ordering};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const INVALID_CIPHERTEXT: &str = "Windows 安全存储密文格式无效。";
const INVALID_PLAINTEXT: &str = "Windows 安全存储中的明文不是有效的 UTF-16LE 文本。";
const ALLOCATION_FAILED: &str = "Windows 安全存储无法分配所需内存。";

/// Temporary copies of plaintext are wiped on every return path.
struct SecretBytes(Vec<u8>);

impl Drop for SecretBytes {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// Also wipes a partially decoded UTF-8 string if its UTF-16 input is invalid.
struct SecretString(String);

impl Drop for SecretString {
    fn drop(&mut self) {
        // SAFETY: overwriting every byte with zero preserves valid UTF-8. No
        // references to the string survive this exclusive drop operation.
        unsafe { wipe(self.0.as_mut_vec()) };
    }
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: each byte is a valid, uniquely borrowed byte in this slice.
        // Volatile writes prevent an unused-memory optimization removing the wipe.
        unsafe { ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// Owns only buffers allocated by DPAPI, which must be released with LocalFree.
struct DpapiBuffer(CRYPT_INTEGER_BLOB);

impl DpapiBuffer {
    fn new() -> Self {
        Self(CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        })
    }

    fn bytes(&self) -> Result<&[u8], String> {
        let length = self.0.cbData as usize;
        if length == 0 {
            return Ok(&[]);
        }
        if self.0.pbData.is_null() || length > isize::MAX as usize {
            return Err("Windows 安全存储返回了无效的数据缓冲区。".to_string());
        }
        // SAFETY: a successful DPAPI call initializes cbData bytes at pbData.
        // This slice cannot outlive this owner or its LocalFree allocation.
        Ok(unsafe { std::slice::from_raw_parts(self.0.pbData, length) })
    }
}

impl Drop for DpapiBuffer {
    fn drop(&mut self) {
        if !self.0.pbData.is_null() {
            // SAFETY: DPAPI owns the allocation until it transfers it to this
            // guard. Wipe it before returning it to its matching Windows heap.
            unsafe {
                for offset in 0..self.0.cbData as usize {
                    ptr::write_volatile(self.0.pbData.add(offset), 0);
                }
                compiler_fence(Ordering::SeqCst);
                LocalFree(self.0.pbData.cast());
            }
        }
    }
}

pub(crate) fn encrypt(secret: &str) -> Result<String, String> {
    let byte_length = secret
        .encode_utf16()
        .count()
        .checked_mul(2)
        .ok_or_else(|| "Windows 安全存储明文过长。".to_string())?;
    u32::try_from(byte_length).map_err(|_| "Windows 安全存储明文过长。".to_string())?;
    let mut plaintext = SecretBytes(Vec::new());
    plaintext
        .0
        .try_reserve_exact(byte_length)
        .map_err(|_| ALLOCATION_FAILED.to_string())?;
    for unit in secret.encode_utf16() {
        plaintext.0.extend_from_slice(&unit.to_le_bytes());
    }
    let protected = protect_bytes(&mut plaintext.0)?;
    encode_hex(protected.bytes()?)
}

pub(crate) fn decrypt(encrypted: &str) -> Result<String, String> {
    let mut ciphertext = decode_hex(encrypted.trim())?;
    let native_length =
        u32::try_from(ciphertext.len()).map_err(|_| "Windows 安全存储密文过长。".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: native_length,
        pbData: ciphertext.as_mut_ptr(),
    };
    let mut plaintext = DpapiBuffer::new();
    // SAFETY: input borrows the ciphertext for the duration of this synchronous
    // call, and the output guard owns any allocation returned by Windows. No
    // description, additional entropy, UI, or machine-wide protection is used.
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut plaintext.0,
        )
    };
    if succeeded == 0 {
        // Capture the Windows error before dropping any allocated buffers.
        let error = std::io::Error::last_os_error();
        return Err(format!("Windows 安全存储解密失败：{error}"));
    }
    decode_utf16le(plaintext.bytes()?)
}

fn protect_bytes(plaintext: &mut [u8]) -> Result<DpapiBuffer, String> {
    let native_length =
        u32::try_from(plaintext.len()).map_err(|_| "Windows 安全存储明文过长。".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: native_length,
        pbData: plaintext.as_mut_ptr(),
    };
    let mut protected = DpapiBuffer::new();
    // SAFETY: the input buffer remains alive for this synchronous call; DPAPI
    // returns its allocation into the guard. Omitting LOCAL_MACHINE preserves
    // the CurrentUser scope used by existing PowerShell-encrypted credentials.
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut protected.0,
        )
    };
    if succeeded == 0 {
        let error = std::io::Error::last_os_error();
        return Err(format!("Windows 安全存储加密失败：{error}"));
    }
    Ok(protected)
}

fn encode_hex(bytes: &[u8]) -> Result<String, String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let capacity = bytes
        .len()
        .checked_mul(2)
        .ok_or_else(|| "Windows 安全存储密文过长。".to_string())?;
    let mut encoded = String::new();
    encoded
        .try_reserve_exact(capacity)
        .map_err(|_| ALLOCATION_FAILED.to_string())?;
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(encoded)
}

fn decode_hex(encrypted: &str) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() || encrypted.len() % 2 != 0 {
        return Err(INVALID_CIPHERTEXT.to_string());
    }
    let mut decoded = Vec::new();
    decoded
        .try_reserve_exact(encrypted.len() / 2)
        .map_err(|_| ALLOCATION_FAILED.to_string())?;
    for pair in encrypted.as_bytes().chunks_exact(2) {
        let high = hex_digit(pair[0]).ok_or_else(|| INVALID_CIPHERTEXT.to_string())?;
        let low = hex_digit(pair[1]).ok_or_else(|| INVALID_CIPHERTEXT.to_string())?;
        decoded.push((high << 4) | low);
    }
    Ok(decoded)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_utf16le(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err(INVALID_PLAINTEXT.to_string());
    }
    // Three UTF-8 bytes per UTF-16 code unit is an upper bound, including pairs
    // of surrogates. Reserving first avoids relocating plaintext while growing.
    let capacity = (bytes.len() / 2)
        .checked_mul(3)
        .ok_or_else(|| ALLOCATION_FAILED.to_string())?;
    let mut decoded = SecretString(String::new());
    decoded
        .0
        .try_reserve_exact(capacity)
        .map_err(|_| ALLOCATION_FAILED.to_string())?;
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
    for character in char::decode_utf16(units) {
        decoded
            .0
            .push(character.map_err(|_| INVALID_PLAINTEXT.to_string())?);
    }
    Ok(std::mem::take(&mut decoded.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_plaintext_without_trimming() {
        for secret in ["", "test-key-123", "  test-key\r\n\t", " \t\r\n", "a\0b"] {
            let encrypted = encrypt(secret).expect("DPAPI encryption should succeed");
            assert!(encrypted.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(decrypt(&encrypted).unwrap(), secret);
        }
    }

    #[test]
    fn roundtrips_unicode_and_surrogate_pairs() {
        let secret = "中文密钥 / café / e\u{301} / 🔑🎨 / \u{10ffff}";
        assert_eq!(decrypt(&encrypt(secret).unwrap()).unwrap(), secret);
    }

    #[test]
    fn roundtrips_secret_larger_than_a_process_pipe_buffer() {
        let secret = "test-密钥-🔑\n".repeat(16_384);
        assert!(secret.len() > 64 * 1024);
        assert_eq!(decrypt(&encrypt(&secret).unwrap()).unwrap(), secret);
    }

    #[test]
    fn accepts_uppercase_hex_and_surrounding_whitespace() {
        let encrypted = encrypt("compatibility-test").unwrap().to_uppercase();
        assert_eq!(
            decrypt(&format!(" \r\n{encrypted}\t ")).unwrap(),
            "compatibility-test"
        );
    }

    #[test]
    fn rejects_empty_odd_nonhex_and_corrupt_ciphertext_without_echoing_it() {
        for invalid in ["", " \t", "0", "abc", "gg", "0x00", "00 00", "中文", "00"] {
            let error = decrypt(invalid).expect_err("invalid data must be rejected");
            if !invalid.is_empty() {
                assert!(!error.contains(invalid));
            }
        }
    }

    #[test]
    fn rejects_truncated_and_tampered_dpapi_ciphertext() {
        let encrypted = encrypt("tamper-test").unwrap();
        assert!(decrypt(&encrypted[..encrypted.len() - 2]).is_err());
        let mut protected = decode_hex(&encrypted).unwrap();
        let last = protected.last_mut().unwrap();
        *last ^= 0x80;
        assert!(decrypt(&encode_hex(&protected).unwrap()).is_err());
    }

    #[test]
    fn rejects_dpapi_plaintext_with_invalid_utf16le() {
        for mut bytes in [vec![0x41], vec![0x00, 0xd8], vec![0x41, 0x00, 0x00, 0xdc]] {
            let protected = protect_bytes(&mut bytes).unwrap();
            let encrypted = encode_hex(protected.bytes().unwrap()).unwrap();
            assert_eq!(decrypt(&encrypted).unwrap_err(), INVALID_PLAINTEXT);
        }
    }
}

#[cfg(test)]
#[path = "windows_secure_storage_compat_tests.rs"]
mod compatibility_tests;
