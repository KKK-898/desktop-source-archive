//! Build-time deployment metadata, not a general-purpose dotenv loader.
//!
//! Only DEPLOYMENT_KEYS can be emitted. Process values win, including an explicit
//! empty value. Local `.env.local` is optional and never read when CI or
//! GITHUB_ACTIONS is present. The local grammar is one KEY=VALUE per line, with
//! optional `export `, surrounding whitespace, whole-line comments and optional
//! matching single/double quotes. Quotes are literal: no escaping, interpolation,
//! multiline values or trailing inline comments. Duplicate selected keys fail.

pub const DEPLOYMENT_KEYS: [&str; 3] = [
    "GAOGE_DEFAULT_API_BASE_URL",
    "GAOGE_ACCOUNT_RELAY_URL",
    "GAOGE_MOBILE_COMPONENT_MANIFEST_URL",
];
pub const CI_KEYS: [&str; 2] = ["CI", "GITHUB_ACTIONS"];

fn validate_value(key: &str, value: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        return Err(format!(
            "Deployment variable {key} must not contain control characters"
        ));
    }
    Ok(())
}

fn local_values(content: &str, needed: &[bool]) -> Result<Vec<Option<String>>, String> {
    let mut values = vec![None; DEPLOYMENT_KEYS.len()];
    for (line_index, raw_line) in content.trim_start_matches('\u{feff}').lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let (raw_key, raw_value) = match line.split_once('=') {
            Some(pair) => pair,
            None => {
                if DEPLOYMENT_KEYS
                    .iter()
                    .enumerate()
                    .any(|(i, key)| needed[i] && line == *key)
                {
                    return Err(format!(
                        "Missing '=' in local deployment configuration at line {}",
                        line_index + 1
                    ));
                }
                continue;
            }
        };
        let Some(index) = DEPLOYMENT_KEYS
            .iter()
            .position(|key| *key == raw_key.trim())
        else {
            continue;
        };
        if !needed[index] {
            continue;
        }
        if values[index].is_some() {
            return Err(format!(
                "Duplicate local deployment variable {}",
                DEPLOYMENT_KEYS[index]
            ));
        }
        let raw_value = raw_value.trim();
        let value = match raw_value.chars().next() {
            Some(quote @ ('\'' | '"')) => {
                if raw_value.len() < 2 || !raw_value.ends_with(quote) {
                    return Err(format!(
                        "Invalid single-line quoting for local deployment variable {}",
                        DEPLOYMENT_KEYS[index]
                    ));
                }
                &raw_value[1..raw_value.len() - 1]
            }
            _ => raw_value,
        };
        validate_value(DEPLOYMENT_KEYS[index], value)?;
        values[index] = Some(value.to_owned());
    }
    Ok(values)
}

/// Both callbacks are lazy and errors must not contain configuration values.
/// A loader is never called in CI or when all three process variables are set.
pub fn resolve<F, L>(
    mut environment: F,
    load_local: L,
) -> Result<Vec<(&'static str, String)>, String>
where
    F: FnMut(&str) -> Result<Option<String>, String>,
    L: FnOnce() -> Result<Option<String>, String>,
{
    let mut values = Vec::with_capacity(DEPLOYMENT_KEYS.len());
    for key in DEPLOYMENT_KEYS {
        let value = environment(key)?;
        if let Some(ref value) = value {
            validate_value(key, value)?;
        }
        values.push(value);
    }
    let mut ci = false;
    for key in CI_KEYS {
        // Presence is intentionally conservative: even CI="false" disables fallback.
        ci |= environment(key)?.is_some();
    }
    let needed: Vec<bool> = values.iter().map(Option::is_none).collect();
    if !ci && needed.iter().any(|needed| *needed) {
        if let Some(content) = load_local()? {
            for (index, local) in local_values(&content, &needed)?.into_iter().enumerate() {
                if needed[index] {
                    values[index] = local;
                }
            }
        }
    }
    Ok(DEPLOYMENT_KEYS
        .into_iter()
        .zip(values.into_iter().map(Option::unwrap_or_default))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration(
        environment: &[(&str, &str)],
        local: Option<&str>,
    ) -> Result<Vec<(&'static str, String)>, String> {
        resolve(
            |key| {
                Ok(environment
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_owned()))
            },
            || Ok(local.map(str::to_owned)),
        )
    }

    #[test]
    fn missing_configuration_is_explicitly_empty() {
        let values = configuration(&[], None).unwrap();
        assert_eq!(values.len(), 3);
        assert!(values.iter().all(|(_, value)| value.is_empty()));
    }

    #[test]
    fn process_values_win_including_explicit_empty() {
        let values = configuration(
            &[(DEPLOYMENT_KEYS[0], "https://process.example.invalid/v1"), (DEPLOYMENT_KEYS[1], "")],
            Some("GAOGE_DEFAULT_API_BASE_URL=https://local.example.invalid/v1\nGAOGE_ACCOUNT_RELAY_URL=https://local.example.invalid/mobile\nGAOGE_MOBILE_COMPONENT_MANIFEST_URL=https://local.example.invalid/components/stable.json"),
        ).unwrap();
        assert_eq!(values[0].1, "https://process.example.invalid/v1");
        assert!(values[1].1.is_empty());
        assert_eq!(
            values[2].1,
            "https://local.example.invalid/components/stable.json"
        );
    }

    #[test]
    fn simple_quotes_crlf_comments_and_export_are_supported() {
        let values = configuration(&[], Some("\u{feff}# local values\r\n GAOGE_DEFAULT_API_BASE_URL = 'https://api.example.invalid/v1' \r\nexport GAOGE_ACCOUNT_RELAY_URL=\"https://api.example.invalid/mobile\"\r\nGAOGE_MOBILE_COMPONENT_MANIFEST_URL=\r\n")).unwrap();
        assert_eq!(values[0].1, "https://api.example.invalid/v1");
        assert_eq!(values[1].1, "https://api.example.invalid/mobile");
        assert!(values[2].1.is_empty());
    }

    #[test]
    fn arbitrary_environment_and_local_secrets_are_not_selected() {
        let values = resolve(
            |key| {
                assert!(DEPLOYMENT_KEYS.contains(&key) || CI_KEYS.contains(&key));
                Ok(None)
            },
            || Ok(Some("SECRET_TOKEN=secret\nTAURI_SIGNING_PRIVATE_KEY=private\nGAOGE_UNKNOWN_KEY=hidden\nGAOGE_DEFAULT_API_BASE_URL=https://api.example.invalid/v1".to_owned())),
        ).unwrap();
        assert_eq!(
            values.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            DEPLOYMENT_KEYS
        );
        assert!(!format!("{values:?}").contains("secret"));
        assert!(!format!("{values:?}").contains("private"));
    }

    #[test]
    fn ci_never_reads_the_local_file_even_when_false_or_empty() {
        for (flag, value) in [
            ("CI", "true"),
            ("CI", "false"),
            ("CI", ""),
            ("GITHUB_ACTIONS", "true"),
        ] {
            let values = resolve(
                |key| Ok((key == flag).then(|| value.to_owned())),
                || panic!("CI must not open .env.local"),
            )
            .unwrap();
            assert!(values.iter().all(|(_, value)| value.is_empty()));
        }
    }

    #[test]
    fn complete_process_configuration_never_reads_local_file() {
        let values = resolve(
            |key| Ok(DEPLOYMENT_KEYS.contains(&key).then(String::new)),
            || panic!("Explicit empty values still override local file"),
        )
        .unwrap();
        assert!(values.iter().all(|(_, value)| value.is_empty()));
    }

    #[test]
    fn process_values_cannot_inject_cargo_directives() {
        for bad in [
            "https://example.invalid\ncargo:rustc-env=SECRET=bad",
            "https://example.invalid\rcargo:warning=bad",
            "https://example.invalid\0",
            "https://example.invalid\t",
        ] {
            let error = configuration(&[(DEPLOYMENT_KEYS[0], bad)], None).unwrap_err();
            assert!(error.contains("control characters"));
            assert!(!error.contains("example.invalid"));
            assert!(!error.contains("SECRET"));
        }
    }

    #[test]
    fn local_values_cannot_inject_cargo_directives_or_multiline_values() {
        for bad in [
            "GAOGE_DEFAULT_API_BASE_URL=\"https://example.invalid\ncargo:rustc-env=SECRET=bad\"",
            "GAOGE_DEFAULT_API_BASE_URL=https://example.invalid\rcargo:warning=bad",
            "GAOGE_DEFAULT_API_BASE_URL=\"https://example.invalid\" # trailing comment",
            "GAOGE_DEFAULT_API_BASE_URL",
        ] {
            let error = configuration(&[], Some(bad)).unwrap_err();
            assert!(!error.contains("example.invalid"));
            assert!(!error.contains("SECRET"));
        }
    }

    #[test]
    fn local_duplicates_fail_without_disclosing_values() {
        let error = configuration(
            &[],
            Some("GAOGE_DEFAULT_API_BASE_URL=one\nGAOGE_DEFAULT_API_BASE_URL=two"),
        )
        .unwrap_err();
        assert!(error.contains("Duplicate local deployment variable"));
        assert!(!error.contains("one"));
        assert!(!error.contains("two"));
    }

    #[test]
    fn quotes_do_not_interpolate_or_unescape() {
        let values = configuration(
            &[],
            Some(
                r#"GAOGE_DEFAULT_API_BASE_URL="${SECRET}/$TOKEN\n"
GAOGE_ACCOUNT_RELAY_URL='${OTHER}/\n'"#,
            ),
        )
        .unwrap();
        assert_eq!(values[0].1, r"${SECRET}/$TOKEN\n");
        assert_eq!(values[1].1, r"${OTHER}/\n");
    }

    #[test]
    fn overridden_local_values_are_not_parsed() {
        let values = configuration(
            &[(DEPLOYMENT_KEYS[0], "")],
            Some("GAOGE_DEFAULT_API_BASE_URL=\"unterminated\nGAOGE_DEFAULT_API_BASE_URL=duplicate"),
        )
        .unwrap();
        assert!(values[0].1.is_empty());
    }
}
