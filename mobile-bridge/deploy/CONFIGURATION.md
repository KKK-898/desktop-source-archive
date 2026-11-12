# Deployment configuration

These templates contain example destinations only. Replace `relay.example.invalid`
with an HTTPS host you operate; never ship account-verification secrets or a
production operator configuration with a public source snapshot.

The desktop supplies `GAOGE_ACCOUNT_RELAY_URL` to the mobile component. An empty
value means there is no default or account-trusted relay. An explicit enrollment
URL remains supported, but it does not become trusted for software account tokens.
The server separately requires `GAOGE_ACCOUNT_VERIFY_URL`; clients cannot override
that verifier. Keep HTTPS, origin validation, signature checks and revocation.

The Nginx HTTP block must define the connection-upgrade map used by the snippet:

```nginx
map $http_upgrade $relay_connection_upgrade {
    default upgrade;
    '' close;
}
```

`setup-update-mirrors.py --config /private/mirror-settings.json` requires explicit
`source`, `targets` (name-to-directory map), `sites` (same names to Nginx site files),
`sharedSnippet`, `backupRoot`, and `owner` (`user:group`). It has no production host
or automatic deployment target. Review paths and locale/proxy aliases before
running it on a server; the `/gaogeaii/` URL prefix is a compatibility route, not a
production address. Keep the JSON outside the published checkout.

Component packaging and signing require `GAOGE_MOBILE_COMPONENT_MANIFEST_URL`,
the same explicitly trusted HTTPS manifest URL used by the desktop build. Put the
manifest inside a dedicated directory (for example,
`https://components.example.invalid/mobile-components/stable.json`). All archive
URLs are generated under that directory; HTTPS port 443, clean paths, same-origin
download checks, and the signing public key are still mandatory. An absent URL
does not select a vendor fallback and prevents packaging release metadata. Supply
the identical value when packaging platform archives and preparing the signed
release; keep the real setting outside the public checkout.
