# Agent Note: desktop renderer installs the client bootstrap prelude

Status: implemented

English | [中文](2026-08-20-desktop-client-bootstrap-prelude.zh.md)

## Problem

The client module system is created through a page-global facade that must exist before its ordinary modules and runtime bundles execute. The packaged desktop document started its Vite module directly, so `AppWebEntry` reached the creation point without a facade and rendered the plugin-load failure page even though every bundle and integrity record was present.

The desktop graph adapter also reconstructed a subset of each boot row. A package-specific `external` request would therefore disappear before module-system construction, and the desktop order could differ from the module graph.

## Decision

`clientBootAssets()` is the shared Host producer for the queue facade and the available modules-then-runtime parser preload rows. The HTTP shell renders the facade inline under its existing policy. The desktop build requires both rows, emits the same facade source as a content-addressed, same-origin classic script covered by the final asset manifest, then places the facade, modules bundle, and runtime bundle before the Vite module entry. Its final-output audit rejects a missing or reordered preload, a missing or changed parser-stage file, and any inline script, preserving the desktop `script-src 'self'` policy.

The desktop composer carries `external` requests, applies the shared module-graph ordering, and rejects requests that neither a dynamic row nor the shell's static module table supplies. The renderer forwards the raw graph after validating the executable bundle rows and their desktop URLs; the upstream parser remains the sole owner of the complete wire validation. Desktop teardown awaits the asynchronous upstream web-entry disposal before retracting the carrier and graph.

## Alternatives considered

**Allow inline script in the desktop policy.** This would copy the HTTP delivery mechanism by weakening the packaged application's content policy. An integrity-recorded external file preserves the same source without granting inline execution.

**Construct a desktop-specific module system or facade in the Vite entry.** The facade exists to capture classic-script registrations before module execution. Reimplementing it after the parser stage would duplicate the module identity rules and could not preserve that ordering.

**Patch only the missing facade.** Leaving `external`, graph order, field forwarding, or asynchronous disposal on the earlier adapter semantics would keep the desktop shell on an incomplete version of the same upstream boot protocol.

## Consequences

Packaged renderer startup has four explicit stages: facade, modules registration, runtime registration, then the Vite shell. The build fails before packaging if its final HTML no longer preserves those stages or if the facade is absent from the integrity inventory. A client-level regression executes the production facade, drains the parser registrations, and requires the real desktop mount to reach a live renderer rather than the failure page. Final package validation must still launch Electron and inspect the visible renderer because `AppWebEntry` deliberately renders startup failures instead of rejecting its `run()` promise.
