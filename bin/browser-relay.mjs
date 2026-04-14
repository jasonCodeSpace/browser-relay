#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RelayClient, defaultRelayUrl } from "../lib/relay-client.mjs";

const args = process.argv.slice(2);
const command = args[0] || "status";
const url = process.env.BROWSER_RELAY_URL || defaultRelayUrl();
const binDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(binDir, "..");
const extensionPath = path.join(packageRoot, "extension");
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

function usage() {
  console.log(`Usage:
  browser-relay help
  browser-relay version
  browser-relay package-root
  browser-relay extension-path
  browser-relay relay-url
  browser-relay relay-start
  browser-relay status
  browser-relay ping
  browser-relay list-tabs
  browser-relay create-tab <url>
  browser-relay activate <tabId>
  browser-relay navigate <tabId> <url>
  browser-relay click <tabId> <selector>
  browser-relay click-at <tabId> <x> <y>
  browser-relay click-at-norm <tabId> <xRatio> <yRatio>
  browser-relay hover <tabId> <selector>
  browser-relay hover-at <tabId> <x> <y>
  browser-relay hover-at-norm <tabId> <xRatio> <yRatio>
  browser-relay type <tabId> <selector> <text>
  browser-relay press <tabId> <key> [selector]
  browser-relay wait-for-selector <tabId> <selector>
  browser-relay wait-for-text <tabId> <text> [selector]
  browser-relay wait-for-url <tabId> <urlOrSubstring>
  browser-relay scroll <tabId> <y>
  browser-relay describe-visible <tabId> [selector]
  browser-relay viewport <tabId>
  browser-relay screenshot <tabId>
  browser-relay raw <method> [jsonParams]`);
}

function buildRequest() {
  const [cmd, a1, a2, a3] = args;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      process.exit(0);
    case "version":
    case "--version":
    case "-v":
      console.log(packageVersion);
      process.exit(0);
    case "package-root":
      console.log(packageRoot);
      process.exit(0);
    case "extension-path":
      console.log(extensionPath);
      process.exit(0);
    case "relay-url":
      console.log(url);
      process.exit(0);
    case "relay-start": {
      const child = spawn("go", ["run", "./server"], {
        cwd: packageRoot,
        stdio: "inherit",
        env: process.env,
      });

      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
        }
        process.exit(code ?? 0);
      });
      return null;
    }
    case "status":
      return { method: "Relay.status", params: {} };
    case "ping":
      return { method: "BrowserRelay.ping", params: {} };
    case "list-tabs":
      return { method: "BrowserRelay.listTabs", params: {} };
    case "create-tab":
      return { method: "BrowserRelay.createTab", params: { url: a1 } };
    case "activate":
      return { method: "BrowserRelay.activateTab", params: { tabId: Number(a1) } };
    case "navigate":
      return { method: "BrowserRelay.navigate", params: { tabId: Number(a1), url: a2 } };
    case "click":
      return { method: "BrowserRelay.click", params: { tabId: Number(a1), selector: a2 } };
    case "click-at":
      return { method: "BrowserRelay.clickAt", params: { tabId: Number(a1), x: Number(a2), y: Number(a3) } };
    case "click-at-norm":
      return {
        method: "BrowserRelay.clickAt",
        params: { tabId: Number(a1), normalizedX: Number(a2), normalizedY: Number(a3) },
      };
    case "hover":
      return { method: "BrowserRelay.hover", params: { tabId: Number(a1), selector: a2 } };
    case "hover-at":
      return { method: "BrowserRelay.hoverAt", params: { tabId: Number(a1), x: Number(a2), y: Number(a3) } };
    case "hover-at-norm":
      return {
        method: "BrowserRelay.hoverAt",
        params: { tabId: Number(a1), normalizedX: Number(a2), normalizedY: Number(a3) },
      };
    case "type":
      return {
        method: "BrowserRelay.type",
        params: { tabId: Number(a1), selector: a2, text: a3 ?? "" },
      };
    case "press":
      return {
        method: "BrowserRelay.press",
        params: { tabId: Number(a1), key: a2, selector: a3 || undefined },
      };
    case "wait-for-selector":
      return {
        method: "BrowserRelay.waitForSelector",
        params: { tabId: Number(a1), selector: a2 },
      };
    case "wait-for-text":
      return {
        method: "BrowserRelay.waitForText",
        params: { tabId: Number(a1), text: a2, selector: a3 || undefined },
      };
    case "wait-for-url":
      return {
        method: "BrowserRelay.waitForUrl",
        params: { tabId: Number(a1), includes: a2 },
      };
    case "scroll":
      return { method: "BrowserRelay.scroll", params: { tabId: Number(a1), y: Number(a2) } };
    case "describe-visible":
      return {
        method: "BrowserRelay.describeVisible",
        params: { tabId: Number(a1), selector: a2 || undefined },
      };
    case "viewport":
      return { method: "BrowserRelay.getViewport", params: { tabId: Number(a1) } };
    case "screenshot":
      return { method: "BrowserRelay.captureScreenshot", params: { tabId: Number(a1) } };
    case "raw":
      return {
        method: a1,
        params: a2 ? JSON.parse(a2) : {},
      };
    default:
      usage();
      process.exit(1);
  }
}

const request = buildRequest();
if (!request) {
  process.exit(0);
}

const client = new RelayClient(url);

try {
  await client.connect();
  const result = await client.call(request.method, request.params);
  console.log(
    JSON.stringify(
      {
        type: "response",
        id: `req-${Date.now()}`,
        ok: true,
        result,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        type: "response",
        id: `req-${Date.now()}`,
        ok: false,
        error: {
          code: error.code || "CLI_ERROR",
          message: error.message || String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client.close();
}
