# @acosmi/dsh-desktop-update

English | [中文](README.zh.md)

Verifies the independently signed canonical release index before a platform updater may receive an artifact. The closed index requires a UUID release id, artifact minimum OS, unique platform and architecture targets, credential-free HTTPS locations, canonical Ed25519 signatures, an unexpired publication interval and correct SemVer precedence. Unknown fields, duplicate targets, fragments, non-Ed25519 keys, incompatible operating systems and non-increasing versions all fail closed. Index fetches consume the response incrementally and cancel it after one MiB even when `Content-Length` is absent. Development builds keep update checks disabled until a feed and trusted key are supplied.
