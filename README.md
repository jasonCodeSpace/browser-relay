# Browser Relay

Browser Relay is a clean-room Chrome extension plus local relay server for
agents that need to control a real signed-in browser.

It is designed for interactive browser automation, not stealth scraping. The
goal is to let an agent reuse a trusted local browser session and perform
reliable tab management, DOM actions, CDP-backed input, screenshots, and
hybrid screenshot-guided clicks when selectors are unreliable.

## Why this exists

Most agent browser tools are either:

- too high-level and brittle on modern sites
- too low-level and painful to use interactively
- too aggressive about opening fresh tabs and losing session state

Browser Relay sits in the middle:

- the Chrome extension owns tab state and browser permissions
- the local relay server exposes a narrow request/response transport
- the CLI gives agents a simple command surface

That makes it practical for tasks like:

- reuse the same signed-in tab instead of spawning a new browser
- search, click, type, scroll, and navigate through complex sites
- use CDP-backed input where DOM events are unreliable
- inspect visible elements and fall back to coordinate clicks when needed

## What it can do

- Discover, create, activate, navigate, reload, and close tabs
- Reuse a strict pool of relay tabs instead of opening a fresh tab every time
- Batch multiple page actions to reduce browser round-trips
- Wait for selectors, text, and URL changes
- Click, hover, press, type, and screenshot through CDP-backed methods
- Type like a human by default, with per-character delay and jitter
- Describe visible interactive elements for screenshot-guided actions
- Click and hover by selector, absolute coordinates, or normalized viewport coordinates
- Keep the relay local-only by default

## Architecture

- `extension/`
  Chrome extension that owns browser state, tab grouping, storage, and CDP interaction.
- `server/`
  Local Go relay server that forwards requests between clients and the extension.
- `bin/browser-relay.mjs`
  CLI entrypoint for status checks, tab control, DOM-first actions, and screenshot-guided actions.
- `lib/relay-client.mjs`
  Shared Node WebSocket client used by the CLI and local test scripts.

## Project status

This repository is ready for:

- local development
- GitHub distribution
- npm packaging

It does **not** attempt to:

- bypass CAPTCHA or anti-bot systems
- hide automation from websites
- run as a remote multi-user browser service

## Requirements

- Google Chrome or another Chromium-based browser
- Node.js 20+
- Go 1.22+ recommended

## Quick start from source

### 1. Clone and install

```bash
git clone <repo-url>
cd browser-relay
npm install
```

### 2. Start the local relay

```bash
npm run relay:start
```

You can also start it from the published CLI later:

```bash
npx browser-relay relay-start
```

By default the relay listens on:

```text
ws://127.0.0.1:47892/ws?role=extension
```

Health check:

```bash
curl -sS http://127.0.0.1:47892/health
```

### 3. Load the unpacked extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click `Load unpacked`
4. Select the `extension/` directory
5. Open the popup and confirm:
   - relay status is `on`
   - socket status is `up`
   - the relay URL points at `ws://127.0.0.1:47892/ws?role=extension`

### 4. Verify the CLI

```bash
npx browser-relay status
npx browser-relay list-tabs
```

## Using it after npm publish

Once the package is published to npm, users do not need to clone the GitHub
repo just to run the CLI.

The npm package name is planned as `browser-relay-cli` because `browser-relay`
is already taken on npm. The product and extension are still named **Browser Relay**.

Examples:

```bash
npx browser-relay-cli version
npx browser-relay-cli relay-start
npx browser-relay-cli extension-path
npx browser-relay-cli status
```

`extension-path` prints the package’s bundled `extension/` directory so users
can load the same unpacked extension from the installed package location.

## CLI overview

### Utility commands

```bash
npx browser-relay-cli help
npx browser-relay-cli version
npx browser-relay-cli package-root
npx browser-relay-cli extension-path
npx browser-relay-cli relay-url
npx browser-relay-cli relay-start
```

### Basic relay commands

```bash
npx browser-relay status
npx browser-relay ping
npx browser-relay list-tabs
```

### Tab control

```bash
npx browser-relay create-tab https://www.google.com
npx browser-relay activate 123456
npx browser-relay navigate 123456 https://news.ycombinator.com
```

### DOM-first interaction

```bash
npx browser-relay click 123456 'button[data-testid="reply"]'
npx browser-relay hover 123456 'input[name="q"]'
npx browser-relay type 123456 'textarea[name="q"]' 'canada foil container distributor'
npx browser-relay press 123456 Enter
npx browser-relay wait-for-selector 123456 'article'
npx browser-relay wait-for-text 123456 'Founder'
npx browser-relay wait-for-url 123456 '/search/results/'
npx browser-relay scroll 123456 800
```

### Screenshot-guided interaction

```bash
npx browser-relay viewport 123456
npx browser-relay screenshot 123456
npx browser-relay describe-visible 123456
npx browser-relay click-at 123456 600 301
npx browser-relay click-at-norm 123456 0.39 0.44
npx browser-relay hover-at 123456 941 290
```

### Raw method passthrough

```bash
npx browser-relay raw BrowserRelay.getText '{"tabId":123456,"selector":"body"}'
npx browser-relay raw CDP.send '{"tabId":123456,"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}'
```

## Supported relay methods

- `BrowserRelay.ping`
- `BrowserRelay.listTabs`
- `BrowserRelay.getState`
- `BrowserRelay.batch`
- `BrowserRelay.createTab`
- `BrowserRelay.closeTab`
- `BrowserRelay.activateTab`
- `BrowserRelay.navigate`
- `BrowserRelay.reloadTab`
- `BrowserRelay.goBack`
- `BrowserRelay.goForward`
- `BrowserRelay.wait`
- `BrowserRelay.waitForSelector`
- `BrowserRelay.waitForText`
- `BrowserRelay.waitForUrl`
- `BrowserRelay.click`
- `BrowserRelay.hover`
- `BrowserRelay.clickAt`
- `BrowserRelay.hoverAt`
- `BrowserRelay.type`
- `BrowserRelay.press`
- `BrowserRelay.scroll`
- `BrowserRelay.scrollIntoView`
- `BrowserRelay.nextPage`
- `BrowserRelay.query`
- `BrowserRelay.queryAll`
- `BrowserRelay.describeVisible`
- `BrowserRelay.getText`
- `BrowserRelay.getHtml`
- `BrowserRelay.getTitle`
- `BrowserRelay.getUrl`
- `BrowserRelay.getViewport`
- `BrowserRelay.captureScreenshot`
- `BrowserRelay.detectRecaptcha`
- `BrowserRelay.waitForManualCaptcha`
- `Relay.status`
- `CDP.send`
- `CDP.attach`
- `CDP.detach`

## Recommended hybrid workflow

For easy pages, use DOM selectors first.

For harder pages, especially surfaces like search results, mixed rendering
layers, or pages where text is visible but selectors are unreliable, switch to
the hybrid workflow:

1. Navigate to the page
2. Call `captureScreenshot`
3. Call `describeVisible`
4. Match the screenshot against `describeVisible` output
5. Click with `clickAt` or `clickAt-norm`
6. After navigation succeeds, switch back to DOM-first methods

This is the intended path for “I can clearly see what to click, but the DOM is
not cooperative.”

## Repo layout

```text
browser-relay/
├── bin/
│   └── browser-relay.mjs
├── docs/
│   ├── clean-room-design.md
│   └── protocol.md
├── extension/
│   ├── background.js
│   ├── icons/
│   ├── manifest.json
│   └── pages/
├── lib/
│   └── relay-client.mjs
├── server/
│   ├── go.mod
│   ├── go.sum
│   ├── main.go
│   ├── test_e2e.mjs
│   └── test_multisite.mjs
├── CHANGELOG.md
├── LICENSE
├── RELEASE_CHECKLIST.md
├── package.json
└── README.md
```

## Development notes

- The extension popup includes relay on/off, tab counts, and max-tab settings.
- Typing defaults to human-like input, not instant insertion.
- Screenshot responses include viewport metadata so coordinate clicks can be aligned to the visible page.
- The relay is local-only by default and designed for trusted local use.

## Privacy and secrets

This repository is intended to stay free of:

- personal emails
- personal phone numbers
- local absolute paths
- `.env` files
- API keys, bearer tokens, passwords, and private certificates

Before publishing, run your own final scan anyway:

```bash
find . -iname '.env' -o -iname '.env.*'
rg -n -i 'api[_-]?key|secret|token|password|bearer|@gmail|@qq|/Users/'
```

## Release process

See:

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)

## License

[MIT](./LICENSE)
