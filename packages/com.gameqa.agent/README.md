# Game QA Agent Adapter 0.1.0

Editor-only UPM package for bounded QA input jobs over the existing Coplay Unity MCP.

The `gameqa` custom tool exposes capabilities, compact observations, exclusive sessions,
ordered UI clicks, one Ocean Nomad hook aim/throw, status, cancellation and cleanup.
The agent selects reviewed tasks; this package performs frame-based input and reports effects.
It never starts Play, calls an AI service, or directly writes gameplay state.

Requires Unity 6000.0 and an installed Coplay Unity MCP package. The package contains two
Editor assemblies and is excluded from player builds. Ocean Nomad support currently targets
2.11.0 and the active `hook_use` tutorial step. UI and hook execution require a separate live
validation before replacing existing mission runners.

Installation, protocol, offline verification, confirmed scope and coordinator integration:
[adapter documentation](../../docs/UNITY_AGENT_ADAPTER.md).

Do not open a second controller while a legacy FastUi/cycle owner holds the Editor.
After a lost response, read status; never blindly resend input with a new request ID.
