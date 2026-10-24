#!/bin/zsh
# Relay → Claude CLI shim for HostedAgents.
# 1. The relay passes the prompt as the last argument right after --mcp-config <file>.
#    Claude CLI 2.1.x treats --mcp-config as variadic and swallows it, so send the prompt on stdin.
# 2. Headless runs here don't pick up the agent folder's CLAUDE.md, so pass it as a system prompt.
args=("${@[1,-2]}")
prompt="${@[-1]}"
[[ -f CLAUDE.md ]] || { print -u2 "missing CLAUDE.md in $PWD"; exit 1; }
print -rn -- "$prompt" | exec "${CLAUDE_BIN:-$HOME/.local/bin/claude}" --append-system-prompt "$(<CLAUDE.md)" "${args[@]}"
