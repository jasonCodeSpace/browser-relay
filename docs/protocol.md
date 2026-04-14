# Browser Relay Protocol

All messages are JSON objects over WebSocket.

## Connection roles

- extension: `ws://127.0.0.1:47892/ws?role=extension`
- client: `ws://127.0.0.1:47892/ws?role=client`

Only one extension connection is expected at a time. Multiple clients are
allowed.

## Request

```json
{
  "type": "request",
  "id": "req-123",
  "method": "BrowserRelay.listTabs",
  "params": {}
}
```

## Response

```json
{
  "type": "response",
  "id": "req-123",
  "ok": true,
  "result": {
    "tabs": []
  }
}
```

On failure:

```json
{
  "type": "response",
  "id": "req-123",
  "ok": false,
  "error": {
    "code": "NOT_CONNECTED",
    "message": "No extension is connected."
  }
}
```

## Event

```json
{
  "type": "event",
  "event": "browser.tabs.updated",
  "data": {
    "tabId": 123
  }
}
```

## Supported methods

### Relay methods

- `BrowserRelay.ping`
- `BrowserRelay.listTabs`
- `BrowserRelay.getState`
- `BrowserRelay.createTab`
- `BrowserRelay.closeTab`
- `BrowserRelay.activateTab`
- `BrowserRelay.navigate`
- `BrowserRelay.reloadTab`
- `BrowserRelay.goBack`
- `BrowserRelay.goForward`
- `BrowserRelay.wait`
- `BrowserRelay.waitForSelector`
- `BrowserRelay.click`
- `BrowserRelay.hover`
- `BrowserRelay.type`
- `BrowserRelay.press`
- `BrowserRelay.scroll`
- `BrowserRelay.scrollIntoView`
- `BrowserRelay.nextPage`
- `BrowserRelay.query`
- `BrowserRelay.queryAll`
- `BrowserRelay.getText`
- `BrowserRelay.getHtml`
- `BrowserRelay.getTitle`
- `BrowserRelay.getUrl`
- `BrowserRelay.captureScreenshot`
- `BrowserRelay.detectRecaptcha`
- `BrowserRelay.waitForManualCaptcha`
- `Relay.status`

### CDP methods

- `CDP.attach`
- `CDP.detach`
- `CDP.send`

`CDP.send` params:

```json
{
  "tabId": 123,
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.title"
  }
}
```

## Event names

- `relay.connected`
- `relay.disconnected`
- `relay.heartbeat`
- `browser.tabs.created`
- `browser.tabs.updated`
- `browser.tabs.removed`
- `browser.tabs.activated`

## Security assumptions

- local-only transport
- trusted local clients
- no auth in v1

If this is expanded beyond local development, add client authentication before
using it in shared environments.
