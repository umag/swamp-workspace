# Fixture provenance

`frames-2.7.11.json` was captured on 2026-09-30 from a live KeePassXC 2.7.11
(macOS) through `keepassxc-proxy`, driving this vault's own `list()` against a
throwaway database. The transport was wrapped to record every frame; the values
of `publicKey`, `nonce`, `message` and `clientID` were replaced with
`<placeholder>` strings before commit (they are per-session random or
ciphertext, never secrets, but carry no information worth keeping). Field names,
field sets and the error text/code are verbatim.

`errorReply` is what KeePassXC sends for a `get-logins` whose URL matches no
entry — note there is no `success` field and `errorCode` is a string.
