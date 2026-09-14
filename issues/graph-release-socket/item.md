---
created: 2026-09-14
updated: 2026-09-14
type: bug
status: open
priority: normal
related: ['@boop-network-view']
---

# Align graph liveness with the production tmux socket

## Description

Source-only follow-up found during the empty Boop tab investigation. In release builds, pty::tmux_cmd_for_socket and open_session_impl default to instant-prod when INSTANT_TMUX_SOCKET is unset. read_session_graph passes configured_tmux_socket(), which returns None in that case, so the Boop multiplexer probes the default server. The sampled incident ran a debug binary and was traced to slow session activity SQL; this production mismatch is separate and has not been live-reproduced. An unmerged candidate patch is retained as 0_candidate.patch. Review and replace its process-global environment mutation test with pure resolver tests or isolated processes; verify real release/default and explicit-socket liveness before integration. Candidate is not shipped.
