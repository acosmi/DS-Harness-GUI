# Agent Note: pwsh-dialect readiness excludes thread-level stdin waits

Status: implemented

English | [中文](2026-08-20-pwsh-stdin-wait-readiness.zh.md)

## Problem

The Linux terminal inspector reports a foreground process group as waiting for input when any member thread is blocked on stdin. The bash-dialect readiness policy can use that fact after its pre-write transition, but a `pwsh`-dialect session keeps a console-reader thread blocked on stdin while another thread can still be evaluating the submitted command. Treating the reader thread as command completion can settle a send before its output or controlled prompt arrives, exposing an empty viewport, PSReadLine input echo, or incomplete persistent-tool marker capture.

PSReadLine can also emit the standard `CSI 6n` cursor-position request and wait for a terminal reply before it renders the stock prompt or accepts bootstrap input. The line-oriented terminal sanitizer previously removed that request without replying. Under coverage or a slow PTY, the prompt bootstrap could then be consumed as device input, while its echoed source contained the controlled prompt literal and could be mistaken for readiness. The persistent PowerShell tool had the same ownership problem at its second prompt layer: it could publish a shell after silence before its private prompt was installed.

Terminal providers do not all serialize writes. In particular, a remote response write can overlap the active user write or a successor send unless the backend owns their order. A response still in flight also invalidates output-silence readiness, and restarting a full send timeout for every empty startup observation leaves prompt installation without one absolute bound.

## Decision

`LocalPtySession` accepts Linux syscall-level stdin-wait evidence only for the `bash` dialect. The `pwsh` dialect completes from its controlled OSC marker plus exact printable prompt, bounded output silence, timeout, or shell exit. The process inspector continues to report the same low-level process-group fact; dialect semantics remain in the terminal backend that owns command readiness.

The sanitizer reports only exact `CSI 6n` requests. A `pwsh`-dialect `LocalPtySession` answers each with the fixed logical position `CSI 1;1R`; the line-oriented backend does not emulate a screen grid. Incomplete control-sequence carry stays bounded independently of printable-output read limits. Response writes are serialized after any provider write already in flight and before successor input. Pending responses prevent readiness settlement and send-slot release; a response write failure fails the terminal transport, while close prevents new responses.

PowerShell startup first captures initial interactive output through `LocalPtySession.initialize()`, including any visible cursor-position exchange. It then submits the UTF-8 and controlled-prompt bootstrap exactly once. Silence-settled follow-ups are empty observations, and publication requires the owned marker or the controlled prompt at a complete line tail. All observations share one existing `timeoutMs` deadline. The persistent PowerShell tool likewise observes its private prompt in the current viewport or retained scrollback tail before it publishes the shell to the first wrapper command.

The existing pre-write wait transition rule remains unchanged for bash. The `pwsh` dialect does not gain a configuration switch or a thread-identity heuristic: neither can turn one reader thread's syscall into evidence that the evaluator has completed.

## Alternatives considered

**Select a presumed PowerShell evaluator thread.** .NET does not expose a stable evaluator-thread identity through the process table, and a syscall snapshot cannot prove which thread owns command completion.

**Keep the exact tier behind a PowerShell configuration flag.** A tunable would expose an unsound result as an operator choice. Prompt and silence readiness already cover PowerShell on platforms without syscall inspection.

**Disable Linux stdin inspection for every dialect.** Rejected because the bash-dialect policy retains lower-latency exact readiness covered by its existing shell and foreground-child tests; the observed invalid inference occurs when the configured shell dialect is `pwsh`.

**Increase silence thresholds, sleep before bootstrap, or resubmit setup code.** Timing changes only reduce the race probability, and resubmission can install the same bootstrap more than once. Neither establishes which prompt owns the next command.

**Accept any output containing the controlled prompt literal.** PSReadLine echoes submitted setup source, and a stock prompt can contain the same suffix through its cwd. Only the private marker or a complete controlled-prompt line tail is completion evidence.

**Add a full terminal emulator.** The backend exposes line output rather than cursor-addressed screen state. A fixed logical cursor response satisfies PSReadLine without adding an unused screen model.

## Consequences

`pwsh`-dialect sends cannot complete from a concurrent reader-thread wait, and startup cannot publish from echoed setup source or a prompt that has not been installed. Cursor replies, user writes, cancellation, timeout, and close retain one send owner across asynchronous providers. Raw `pwsh`-dialect sessions with the controlled backend prompt still settle through the marker fast path; a different prompt uses the bounded silence tier. Bash-dialect exact readiness and the low-level inspector remain unchanged. Deterministic fake-terminal tests cover split and repeated cursor requests, write ordering, failure and teardown, one-shot prompt installation, and the private-prompt handshake; real PowerShell suites exercise output, state, UTF-8 encoding, and persistent-tool extraction where the executable is available.
