# @magistr/openssl

Inspect, create and convert X.509 certificates and keys with the local `openssl`
CLI. The model covers a small private PKI: create a CA, issue leaf certificates
from CSRs, verify them, and convert them to the formats other tools expect.

## Methods

| Method     | What it does                                                         |
| ---------- | -------------------------------------------------------------------- |
| `version`  | openssl flavour (OpenSSL / LibreSSL) and version                     |
| `inspect`  | Certificates from files and TLS endpoints, with `daysLeft` and SANs  |
| `genkey`   | EC (default P-256), RSA or Ed25519 private key, written mode 0600    |
| `csr`      | CSR with subject and SANs (DNS, IP, email, URI auto-detected)        |
| `selfsign` | Self-signed TLS leaf, or a CA root with `ca: true`                   |
| `sign`     | Sign a CSR with a CA cert + key; SANs copied from the CSR by default |
| `verify`   | Chain trust, cert/key match and hostname; fails if any check fails   |
| `convert`  | PEM ↔ DER, PEM + key → PKCS#12, PKCS#12 → PEM                        |

## Example: a private CA and one leaf

```bash
swamp extension pull @magistr/openssl
swamp behavior create @magistr/openssl ssl
swamp behavior run ssl genkey --input path=/srv/pki/ca.key
swamp behavior run ssl selfsign --input-file ca.yaml   # ca: true, subject.CN
swamp behavior run ssl genkey --input path=/srv/pki/app.key
swamp behavior run ssl csr --input-file app-csr.yaml   # subject + sans
swamp behavior run ssl sign --input-file app-sign.yaml
swamp behavior run ssl verify --input certPath=/srv/pki/app.crt \
  --input caPath=/srv/pki/ca.crt --input hostname=app.internal
```

Check expiry for files and live endpoints in one run:

```bash
swamp behavior run ssl inspect --input-file targets.yaml
swamp data query 'behavior("ssl") && name == "certificates"' \
  --select content.expiringSoon
```

## Safety

- Private keys stay on disk. swamp data records only paths, subjects,
  fingerprints and a SHA-256 digest of the public key.
- Passphrases go to openssl via `-passin env:` / `-passout env:`, so they never
  appear in `ps`. Pass them as vault expressions.
- Outputs are never overwritten unless `overwrite: true`. A re-run reports
  `changed: false`.
- `sign` checks the CSR's own signature before it issues a certificate. Serial
  numbers are random 127-bit values.

## Global arguments

| Argument | Default   | Notes                                               |
| -------- | --------- | --------------------------------------------------- |
| `binary` | `openssl` | Name on PATH or an absolute path (e.g. Homebrew's). |

macOS ships LibreSSL as `/usr/bin/openssl`. `version` shows which binary runs.
Ed25519 and some PKCS#12 options need OpenSSL 3+.
