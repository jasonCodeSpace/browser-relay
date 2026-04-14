import { RelayClient, defaultRelayUrl } from "../lib/relay-client.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const relay = new RelayClient(defaultRelayUrl());
  await relay.connect();
  const report = {
    checks: [],
    summary: {},
  };

  const pushCheck = (name, data) => report.checks.push({ name, ...data });
  const step = async (name, fn) => {
    console.error(`[test] ${name}`);
    const result = await fn();
    console.error(`[done] ${name}`);
    return result;
  };

  const status = await step("Relay.status", () => relay.call("Relay.status"));
  pushCheck("relay.status", status);
  assert(status.extensionConnected, "Extension is not connected");

  const initialState = await step("BrowserRelay.getState", () => relay.call("BrowserRelay.getState"));
  pushCheck("BrowserRelay.getState", initialState);
  const maxTabs = initialState.maxTabs || 3;

  const exampleTab = (await step("example.createTab", () => relay.call("BrowserRelay.createTab", {
    url: "https://example.com/",
    waitForLoad: true,
  }))).tab;
  pushCheck("example.createTab", exampleTab);

  const exampleBatch = await step("example.batch", () => relay.call("BrowserRelay.batch", {
    steps: [
      { method: "BrowserRelay.waitForSelector", params: { tabId: exampleTab.id, selector: "h1", timeoutMs: 8000 } },
      { method: "BrowserRelay.getTitle", params: { tabId: exampleTab.id } },
      { method: "BrowserRelay.getUrl", params: { tabId: exampleTab.id } },
      { method: "BrowserRelay.query", params: { tabId: exampleTab.id, selector: "p" } },
      { method: "BrowserRelay.detectRecaptcha", params: { tabId: exampleTab.id } },
    ],
  }));
  pushCheck("example.batch", exampleBatch);
  assert(exampleBatch.results[0].result.found, "Example h1 not found");

  const hoverRes = await step("example.hover", () => relay.call("BrowserRelay.hover", {
    tabId: exampleTab.id,
    selector: "a",
  }));
  pushCheck("example.hover", hoverRes);

  const scrollRes = await step("example.scroll", () => relay.call("BrowserRelay.scroll", {
    tabId: exampleTab.id,
    y: 120,
  }));
  pushCheck("example.scroll", scrollRes);

  const screenshotRes = await step("example.captureScreenshot", () => relay.call("BrowserRelay.captureScreenshot", {
    tabId: exampleTab.id,
  }));
  pushCheck("example.captureScreenshot", {
    format: screenshotRes.format,
    dataUrlLength: screenshotRes.dataUrl.length,
  });
  assert(screenshotRes.dataUrl.startsWith("data:image/png;base64,"), "Screenshot did not use CDP PNG data URL");

  const cdpAttach = await step("example.cdpAttach", () => relay.call("CDP.attach", { tabId: exampleTab.id }));
  pushCheck("example.cdpAttach", cdpAttach);
  const cdpEval = await step("example.cdpSend", () => relay.call("CDP.send", {
    tabId: exampleTab.id,
    method: "Runtime.evaluate",
    params: {
      expression: "document.title",
      returnByValue: true,
    },
  }));
  pushCheck("example.cdpSend", cdpEval);
  assert(cdpEval.result?.value === "Example Domain", "CDP Runtime.evaluate returned unexpected title");

  const hnTab = (await step("hn.createTab", () => relay.call("BrowserRelay.createTab", {
    url: "https://news.ycombinator.com/",
    waitForLoad: true,
  }))).tab;
  pushCheck("hn.createTab", hnTab);

  const hnBefore = await step("hn.getUrl.before", () => relay.call("BrowserRelay.getUrl", { tabId: hnTab.id }));
  const hnNext = await step("hn.nextPage", () => relay.call("BrowserRelay.nextPage", { tabId: hnTab.id }));
  const hnAfter = await step("hn.waitForUrl", () => relay.call("BrowserRelay.waitForUrl", {
    tabId: hnTab.id,
    includes: "p=2",
    timeoutMs: 10000,
  }));
  pushCheck("hn.nextPage", { hnBefore, hnNext, hnAfter });
  assert(hnAfter.url !== hnBefore.url, "HN nextPage did not change URL");

  const navBack = await step("hn.goBack", () => relay.call("BrowserRelay.goBack", { tabId: hnTab.id }));
  const backUrl = await step("hn.waitForUrl.back", () => relay.call("BrowserRelay.waitForUrl", {
    tabId: hnTab.id,
    includes: "news.ycombinator.com/",
    timeoutMs: 10000,
  }));
  const navForward = await step("hn.goForward", () => relay.call("BrowserRelay.goForward", { tabId: hnTab.id }));
  const forwardUrl = await step("hn.waitForUrl.forward", () => relay.call("BrowserRelay.waitForUrl", {
    tabId: hnTab.id,
    includes: "news.ycombinator.com/",
    timeoutMs: 10000,
  }));
  pushCheck("hn.history", { navBack, backUrl, navForward, forwardUrl });

  const xTab = (await step("x.createTab", () => relay.call("BrowserRelay.createTab", {
    url: "https://x.com/home",
    waitForLoad: false,
  }))).tab;
  pushCheck("x.createTab", xTab);

  const xSearchReady = await step("x.waitForSelector", () => relay.call("BrowserRelay.waitForSelector", {
    tabId: xTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    timeoutMs: 15000,
  }));
  pushCheck("x.waitForSelector", xSearchReady);

  const xSearchHover = await step("x.hover", () => relay.call("BrowserRelay.hover", {
    tabId: xTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
  }));
  const xSearchClick = await step("x.click", () => relay.call("BrowserRelay.click", {
    tabId: xTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
  }));
  const xSearchType = await step("x.type", () => relay.call("BrowserRelay.type", {
    tabId: xTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    text: "elon musk",
  }));
  const xSearchPress = await step("x.press", () => relay.call("BrowserRelay.press", {
    tabId: xTab.id,
    key: "Enter",
  }));
  const xSearchUrl = await step("x.waitForUrl", () => relay.call("BrowserRelay.waitForUrl", {
    tabId: xTab.id,
    includes: "/search?q=elon%20musk",
    timeoutMs: 15000,
  }));
  const xSearchTitle = await step("x.getTitle", () => relay.call("BrowserRelay.getTitle", { tabId: xTab.id }));
  pushCheck("x.search", {
    xSearchHover,
    xSearchClick,
    xSearchType,
    xSearchPress,
    xSearchUrl,
    xSearchTitle,
  });
  assert(xSearchUrl.url.includes("elon%20musk"), "X search did not navigate");

  const xTypeaheadTab = (await step("x.typeahead.createTab", () => relay.call("BrowserRelay.createTab", {
    url: "https://x.com/home",
    waitForLoad: false,
  }))).tab;
  await step("x.typeahead.waitForSelector.input", () => relay.call("BrowserRelay.waitForSelector", {
    tabId: xTypeaheadTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    timeoutMs: 15000,
  }));
  await step("x.typeahead.clickInput", () => relay.call("BrowserRelay.click", {
    tabId: xTypeaheadTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
  }));
  await step("x.typeahead.type", () => relay.call("BrowserRelay.type", {
    tabId: xTypeaheadTab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    text: "elon musk",
  }));
  const typeaheadWait = await step("x.typeahead.waitForSelector.result", () => relay.call("BrowserRelay.waitForSelector", {
    tabId: xTypeaheadTab.id,
    selector: '[data-testid="typeaheadResult"] button',
    timeoutMs: 15000,
  }));
  const typeaheadClick = await step("x.typeahead.click", () => relay.call("BrowserRelay.click", {
    tabId: xTypeaheadTab.id,
    selector: '[data-testid="typeaheadResult"] button',
  }));
  const typeaheadUrl = await step("x.typeahead.waitForUrl", () => relay.call("BrowserRelay.waitForUrl", {
    tabId: xTypeaheadTab.id,
    includes: "/search?q=elon%20musk",
    timeoutMs: 15000,
  }));
  pushCheck("x.typeahead", { typeaheadWait, typeaheadClick, typeaheadUrl });

  const recaptchaState = await step("captcha.detect", () => relay.call("BrowserRelay.detectRecaptcha", {
    tabId: exampleTab.id,
  }));
  const manualCaptchaWait = await step("captcha.waitManual", () => relay.call("BrowserRelay.waitForManualCaptcha", {
    tabId: exampleTab.id,
    timeoutMs: 100,
  }));
  pushCheck("captcha", { recaptchaState, manualCaptchaWait });

  const batchTab = (await step("batch.createTab", () => relay.call("BrowserRelay.createTab", {
    url: "https://example.com/",
    waitForLoad: true,
  }))).tab;
  const chainedBatch = await step("batch.chained", () => relay.call("BrowserRelay.batch", {
    steps: [
      { method: "BrowserRelay.waitForSelector", params: { tabId: batchTab.id, selector: "a", timeoutMs: 8000 } },
      { method: "BrowserRelay.query", params: { tabId: batchTab.id, selector: "a" } },
      { method: "BrowserRelay.getText", params: { tabId: batchTab.id, selector: "body" } },
      { method: "BrowserRelay.getHtml", params: { tabId: batchTab.id, selector: "body" } },
      { method: "BrowserRelay.scroll", params: { tabId: batchTab.id, y: 50 } },
    ],
  }));
  pushCheck("batch.chained", chainedBatch);
  assert(chainedBatch.results.length === 5, "Batch result length mismatch");

  const poolTabs = [];
  for (let i = 0; i < maxTabs + 2; i += 1) {
    const result = await step(`pool.createTab.${i}`, () => relay.call("BrowserRelay.createTab", {
      url: `https://example.com/?pool=${i}`,
      waitForLoad: false,
    }));
    poolTabs.push(result.tab.id);
  }
  const relayTabs = await step("pool.listTabs", () => relay.call("BrowserRelay.listTabs", {}));
  pushCheck("tab.pool", {
    createdIds: poolTabs,
    listedCount: relayTabs.tabs.length,
    listedIds: relayTabs.tabs.map((tab) => tab.id),
    maxTabs,
  });
  assert(relayTabs.tabs.length <= maxTabs, "Relay tab pool exceeded maxTabs");

  const cdpDetach = await step("example.cdpDetach", () => relay.call("CDP.detach", { tabId: exampleTab.id }));
  pushCheck("example.cdpDetach", cdpDetach);

  report.summary = {
    extensionConnected: status.extensionConnected,
    maxTabs,
    relayTabCount: relayTabs.tabs.length,
    xSearchUrl: xSearchUrl.url,
    typeaheadUrl: typeaheadUrl.url,
  };

  console.log(JSON.stringify(report, null, 2));
  relay.close();
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: {
      code: error.code || "TEST_FAILED",
      message: error.message,
      stack: error.stack,
    },
  }, null, 2));
  process.exit(1);
});
