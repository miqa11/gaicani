# Configuration required before merging this draft

The activity update removes embedded service credentials and the hard-coded owner address from the server source. Configure these in the deployment platform's private environment settings before deploying:

| Variable | Purpose | If omitted |
| --- | --- | --- |
| `GIPHY_KEY` | Existing GIF search integration | GIF API returns a configuration-unavailable response |
| `YOUTUBE_API_KEY` | Existing music search integration | Existing curated music fallback remains available |
| `OWNER_IPS` | Comma-separated IPv4/IPv6 owner allowlist | No address receives owner-IP privileges |

Existing `ADMIN_KEY`, `ADMIN_PASSWORD`, and `CAPTCHA_SECRET` behavior is unchanged. Admin sessions still require their existing authentication checks. Do not put credential values in this document, commits, issues, or pull-request descriptions.

This change does not configure the hosting environment or erase previously committed values from repository history. Replace exposed service keys through their providers and use the replacement values in private deployment settings.
