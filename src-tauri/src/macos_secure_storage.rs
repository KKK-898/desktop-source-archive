//! Encrypt local credentials with a persistent, per-user Keychain key.
//! Only nonce + authenticated ciphertext are written to application files.
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rand::{rngs::OsRng, RngCore};

const PREFIX: &str = "gaoge-macos-keychain-v1:";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
type MasterKey = [u8; KEY_LEN];

trait KeyStore {
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    /// Create only: an existing master key must never be overwritten.
    fn create(&self, key: &MasterKey) -> Result<(), String>;
}

fn load_key(store: &impl KeyStore, allow_create: bool) -> Result<MasterKey, String> {
    let bytes = match store.load()? {
        Some(bytes) => bytes,
        None if allow_create => {
            let mut key = [0; KEY_LEN];
            OsRng
                .try_fill_bytes(&mut key)
                .map_err(|_| "生成 macOS 安全凭据密钥失败，请重试。".to_string())?;
            let created = store.create(&key);
            // Read the persisted key back before using it. If another process
            // won creation, use its key; never replace it with our candidate.
            store.load()?.ok_or_else(|| {
                created.err().unwrap_or_else(|| {
                    "macOS 安全凭据密钥保存后无法读取，已取消凭据写入。".to_string()
                })
            })?
        }
        None => {
            return Err(
                "找不到 macOS 安全凭据密钥，请确认使用原 macOS 用户及其钥匙串后重试。".to_string(),
            )
        }
    };
    bytes
        .try_into()
        .map_err(|_| "macOS 安全凭据密钥格式异常，未覆盖原密钥或认证。".to_string())
}

fn encrypt_with_key(key: &MasterKey, secret: &str) -> Result<String, String> {
    let mut nonce = [0; NONCE_LEN];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| "生成 macOS 凭据加密随机数失败，请重试。".to_string())?;
    let ciphertext = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret.as_bytes(),
                aad: PREFIX.as_bytes(),
            },
        )
        .map_err(|_| "加密 macOS 凭据失败，未保存明文凭据。".to_string())?;
    let mut payload = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(&nonce);
    payload.extend_from_slice(&ciphertext);
    Ok(format!(
        "{PREFIX}{}",
        general_purpose::STANDARD.encode(payload)
    ))
}

fn decode_payload(encrypted: &str) -> Result<Vec<u8>, String> {
    let encoded = encrypted
        .trim()
        .strip_prefix(PREFIX)
        .ok_or_else(|| "无法识别 macOS 安全凭据格式，未修改原认证。".to_string())?;
    let payload = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "macOS 安全凭据编码异常，未修改原认证。".to_string())?;
    if payload.len() < NONCE_LEN + TAG_LEN {
        return Err("macOS 安全凭据不完整，未修改原认证。".to_string());
    }
    Ok(payload)
}

fn decrypt_payload(key: &MasterKey, payload: &[u8]) -> Result<String, String> {
    let (nonce, ciphertext) = payload.split_at(NONCE_LEN);
    let plaintext = Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: PREFIX.as_bytes(),
            },
        )
        .map_err(|_| "macOS 安全凭据解密或校验失败，未修改原认证。".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "macOS 安全凭据内容异常，未修改原认证。".to_string())
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::*;
    use security_framework::os::macos::{keychain::SecKeychain, passwords::find_generic_password};
    use std::sync::Mutex;

    const SERVICE: &str = "cn.gaoge.free.secure-storage";
    const ACCOUNT: &str = "credential-encryption-key-v1";
    const ITEM_NOT_FOUND: i32 = -25300;
    static CACHED_KEY: Mutex<Option<MasterKey>> = Mutex::new(None);

    struct LoginKeychain;

    fn keychain_error(error: security_framework::base::Error) -> String {
        format!(
            "无法访问 macOS 钥匙串（系统错误 {}）。请解锁“登录”钥匙串，或在系统提示中允许 Gaoge Free 访问后重试。",
            error.code(),
        )
    }

    #[cfg(test)]
    fn test_keychain() -> Result<Option<SecKeychain>, String> {
        let Some(path) = std::env::var_os("GAOGE_TEST_KEYCHAIN_PATH") else {
            return Ok(None);
        };
        let path = std::path::Path::new(&path);
        if !path.is_absolute() {
            return Err("The isolated test keychain path must be absolute.".to_string());
        }
        // Authentication tests replace HOME to isolate all application files.
        // Open CI's real keychain explicitly so that isolation cannot replace
        // the OS default-keychain preference. Production never reads this env.
        SecKeychain::open(path).map(Some).map_err(keychain_error)
    }

    impl KeyStore for LoginKeychain {
        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            #[cfg(test)]
            let selected = test_keychain()?;
            #[cfg(test)]
            let keychains = selected.as_ref().map(std::slice::from_ref);
            #[cfg(not(test))]
            let keychains = None;
            match find_generic_password(keychains, SERVICE, ACCOUNT) {
                Ok((password, _item)) => Ok(Some(password.to_vec())),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(keychain_error(error)),
            }
        }

        fn create(&self, key: &MasterKey) -> Result<(), String> {
            // add_generic_password is deliberately create-only. The upsert
            // API could replace a concurrently created key and strand backups.
            #[cfg(test)]
            let keychain = match test_keychain()? {
                Some(keychain) => keychain,
                None => SecKeychain::default().map_err(keychain_error)?,
            };
            #[cfg(not(test))]
            let keychain = SecKeychain::default().map_err(keychain_error)?;
            keychain
                .add_generic_password(SERVICE, ACCOUNT, key)
                .map_err(keychain_error)
        }
    }

    pub(super) fn master_key(allow_create: bool) -> Result<MasterKey, String> {
        let mut cached = CACHED_KEY
            .lock()
            .map_err(|_| "macOS 安全凭据状态锁失败，请重启软件后重试。".to_string())?;
        if let Some(key) = *cached {
            return Ok(key);
        }
        let key = load_key(&LoginKeychain, allow_create)?;
        *cached = Some(key);
        Ok(key)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn encrypt(secret: &str) -> Result<String, String> {
    encrypt_with_key(&keychain::master_key(true)?, secret)
}

#[cfg(target_os = "macos")]
pub(super) fn decrypt(encrypted: &str) -> Result<String, String> {
    let payload = decode_payload(encrypted)?;
    decrypt_payload(&keychain::master_key(false)?, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct MemoryKeychain {
        key: RefCell<Option<Vec<u8>>>,
        creates: Cell<usize>,
    }

    impl KeyStore for MemoryKeychain {
        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.key.borrow().clone())
        }

        fn create(&self, key: &MasterKey) -> Result<(), String> {
            self.creates.set(self.creates.get() + 1);
            self.key.replace(Some(key.to_vec()));
            Ok(())
        }
    }

    #[test]
    fn credentials_restore_with_persisted_key_after_restart() {
        let store = MemoryKeychain::default();
        let auth = r#"{"auth_mode":"apikey","OPENAI_API_KEY":"personal-key","label":"原登录🥰"}"#;
        let encrypted = encrypt_with_key(&load_key(&store, true).unwrap(), auth).unwrap();
        assert!(!encrypted.contains("personal-key"));
        assert!(!encrypted.contains("原登录"));
        // A fresh reader only has persisted Keychain data and the backup file.
        let restarted = MemoryKeychain {
            key: RefCell::new(store.key.borrow().clone()),
            ..Default::default()
        };
        let restored = decrypt_payload(
            &load_key(&restarted, false).unwrap(),
            &decode_payload(&encrypted).unwrap(),
        )
        .unwrap();
        assert_eq!(restored, auth);
        assert_eq!(restarted.creates.get(), 0);
        assert_eq!(
            load_key(&store, true).unwrap(),
            load_key(&restarted, false).unwrap()
        );
        assert_eq!(store.creates.get(), 1);
    }

    #[test]
    fn repeated_backups_use_distinct_nonces() {
        let key = [23; KEY_LEN];
        let first = encrypt_with_key(&key, "same-credential").unwrap();
        let second = encrypt_with_key(&key, "same-credential").unwrap();
        assert_ne!(first, second);
        for encrypted in [first, second] {
            assert_eq!(
                decrypt_payload(&key, &decode_payload(&encrypted).unwrap()).unwrap(),
                "same-credential"
            );
        }
    }

    #[test]
    fn tampered_ciphertext_nonce_and_wrong_key_are_rejected() {
        let key = [23; KEY_LEN];
        let payload = decode_payload(&encrypt_with_key(&key, "original-auth").unwrap()).unwrap();
        assert!(decrypt_payload(&[24; KEY_LEN], &payload).is_err());
        for index in [0, NONCE_LEN, payload.len() - 1] {
            let mut tampered = payload.clone();
            tampered[index] ^= 1;
            assert!(decrypt_payload(&key, &tampered).is_err());
        }
        for value in [
            "",
            "dpapi-from-windows",
            "gaoge-macos-keychain-v2:AAAA",
            "gaoge-macos-keychain-v1:!",
            "gaoge-macos-keychain-v1:AAAA",
        ] {
            assert!(decode_payload(value).is_err());
        }
    }

    #[test]
    fn missing_or_malformed_keys_are_never_replaced_during_restore() {
        let store = MemoryKeychain::default();
        assert!(load_key(&store, false).is_err());
        assert_eq!(store.creates.get(), 0);
        store.key.replace(Some(vec![42; KEY_LEN - 1]));
        assert!(load_key(&store, false).is_err());
        assert!(load_key(&store, true).is_err());
        assert_eq!(store.creates.get(), 0);
        assert_eq!(store.key.borrow().as_ref().unwrap().len(), KEY_LEN - 1);
    }

    #[test]
    fn keychain_access_failures_do_not_create_replacement_keys() {
        struct LockedKeychain;
        impl KeyStore for LockedKeychain {
            fn load(&self) -> Result<Option<Vec<u8>>, String> {
                Err("locked".to_string())
            }
            fn create(&self, _: &MasterKey) -> Result<(), String> {
                panic!("must not overwrite a locked key")
            }
        }
        assert_eq!(load_key(&LockedKeychain, true).unwrap_err(), "locked");
        assert_eq!(load_key(&LockedKeychain, false).unwrap_err(), "locked");
    }

    #[test]
    fn concurrently_created_key_is_reused_and_failed_save_is_rejected() {
        struct RacingKeychain(Cell<bool>);
        impl KeyStore for RacingKeychain {
            fn load(&self) -> Result<Option<Vec<u8>>, String> {
                Ok(self.0.get().then(|| vec![71; KEY_LEN]))
            }
            fn create(&self, _: &MasterKey) -> Result<(), String> {
                self.0.set(true);
                Err("duplicate".to_string())
            }
        }
        assert_eq!(
            load_key(&RacingKeychain(Cell::new(false)), true).unwrap(),
            [71; KEY_LEN]
        );
        struct FailingKeychain;
        impl KeyStore for FailingKeychain {
            fn load(&self) -> Result<Option<Vec<u8>>, String> {
                Ok(None)
            }
            fn create(&self, _: &MasterKey) -> Result<(), String> {
                Err("save denied".to_string())
            }
        }
        assert_eq!(load_key(&FailingKeychain, true).unwrap_err(), "save denied");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_keychain_round_trip() {
        let secret = "gaoge-macos-native-test-原认证";
        let encrypted = super::encrypt(secret).expect("macOS Keychain encryption must be usable");
        assert!(encrypted.starts_with(PREFIX));
        assert_eq!(super::decrypt(&encrypted).unwrap(), secret);
    }
}
