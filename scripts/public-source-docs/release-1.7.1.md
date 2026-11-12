# Gaoge Free 1.7.1

## Improvements

- Improved aggregate model menus, native model selection, context settings and
  reasoning-level compatibility; separated built-in and custom providers.
- Fixed aggregate-mode exit and account/model recovery, including normal API
  sign-in and recharge flows, without rewriting historical conversations.
- Improved native Fast and Ultra compatibility, official plugin access and
  plugin installation, Chinese UI selection and plain-text rich-text pasting.
- Refined theme/background display, account balance display, sign-in/recharge
  feedback, conversation import and synchronization controls.
- Retained the existing functionality and ten theme configurations.

## Platform notes

The release targets Windows x64, macOS Universal and Linux x86_64. This version
**does not include the deferred Linux startup-environment compatibility fix**;
Linux desktop startup compatibility has not been claimed as fully verified.
Update signatures are separate from operating-system code signing.
The minimum supported update version remains 1.6.3.

## Source, license and third-party materials

This source snapshot corresponds to release 1.7.1. Build instructions are in
`README.md`. The application includes AGPL-3.0-only derived components; retain
`LICENSE`, `NOTICE.md` and `THIRD_PARTY_NOTICES.md` when redistributing.

Third-party theme, logo, localization and native compatibility materials retain
their original attribution and rights status. Fifty items remain **unverified**
and are disclosed in `SOURCE_EXPORT_REPORT.json` under `rightsDisclosures`.
Their inclusion records the owner's version-specific publication direction,
not a finding of permission, clearance or infringement. Describing material as
from the internet does not grant permission or change its license. See
`scripts/public-source-docs/owner-release-decision-1.7.1.md` for the fixed scope
and `THIRD_PARTY_NOTICES.md` for notices.

Private credentials, operator deployment entry points, internal validation logs,
account data and original development history are not part of this snapshot.
Mobile runtime/service source, deployment templates and component packaging and
signature-validation tools are retained. Deployment operators must configure
their own infrastructure and credentials; desktop builds do not require access
to the original operator's systems.
