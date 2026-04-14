# Browser Relay Clean-Room Design

## Goals

Browser Relay provides a local-only control plane for Chrome tabs. The design
keeps two layers separate:

- a Chrome extension that can attach to tabs and execute restricted actions
- a local relay server that routes commands between the extension and local
  clients

## Clean-room boundary

This project may borrow the high-level idea of "extension + local relay + CDP",
but it must not copy code, text, naming, file structure, protocol wording, or
UI from any unlicensed project.

To keep that boundary clear:

- command names use `BrowserRelay.*` and `CDP.*`
- files and module names are original to this project
- the protocol is documented from scratch in `docs/protocol.md`
- page actions are implemented as a small, explicit command set

## Architecture

### Extension

The extension owns browser authority:

- connect to the local WebSocket relay
- list and activate tabs
- attach to tabs with `chrome.debugger`
- forward explicit CDP requests
- run page actions with `chrome.scripting.executeScript`
- emit status and tab lifecycle events

### Relay server

The relay server is a small message hub:

- accept one extension connection
- accept one or more local client connections
- route request and response messages by `id`
- broadcast extension events to all clients
- expose a simple health endpoint

### Clients

Clients talk only to the relay server. They do not need direct browser access.

## Command model

The relay supports two classes of commands:

- `BrowserRelay.*` for safe, higher-level actions
- `CDP.*` for low-level debugging access

Higher-level page actions are intentionally constrained so that automation can
interact with ordinary pages without turning the system into a generic abuse
tool.

## CAPTCHA handling

The system supports:

- challenge detection
- waiting for a human to solve the challenge
- resuming automation after completion

The system does not support:

- automated CAPTCHA solving
- token theft
- challenge bypassing

## Initial scope

The first version includes:

- tab management
- reconnect and heartbeat
- explicit page actions
- CDP passthrough
- manual CAPTCHA handoff

It does not include:

- session recording
- stealth fingerprinting
- remote internet-exposed control
- browser profile management
