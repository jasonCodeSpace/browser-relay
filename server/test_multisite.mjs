import { RelayClient, defaultRelayUrl } from "../lib/relay-client.mjs";

function logStep(site, label) {
  console.error(`[${site}] ${label}`);
}

async function createSiteTab(relay, site, url, waitForLoad = false) {
  logStep(site, `createTab ${url}`);
  return (await relay.call("BrowserRelay.createTab", { url, waitForLoad })).tab;
}

async function testHN(relay) {
  const tab = await createSiteTab(relay, "hn", "https://news.ycombinator.com/", true);
  const title = await relay.call("BrowserRelay.getTitle", { tabId: tab.id });
  const list = await relay.call("BrowserRelay.queryAll", {
    tabId: tab.id,
    selector: ".athing",
    limit: 10,
  });
  const scroll = await relay.call("BrowserRelay.scroll", { tabId: tab.id, y: 600 });
  const next = await relay.call("BrowserRelay.nextPage", { tabId: tab.id });
  const nextUrl = await relay.call("BrowserRelay.waitForUrl", {
    tabId: tab.id,
    includes: "p=2",
    timeoutMs: 15000,
  });
  const screenshot = await relay.call("BrowserRelay.captureScreenshot", { tabId: tab.id });
  return {
    next,
    nextUrl: nextUrl.url,
    screenshotLength: screenshot.dataUrl.length,
    storyCount: list.count,
    title: title.title,
    url: tab.url,
    scrollY: scroll.y,
  };
}

async function testReddit(relay) {
  const tab = await createSiteTab(relay, "reddit", "https://www.reddit.com/", false);
  await relay.call("BrowserRelay.wait", { ms: 3000 });
  const title = await relay.call("BrowserRelay.getTitle", { tabId: tab.id });
  const url = await relay.call("BrowserRelay.getUrl", { tabId: tab.id });
  const posts = await relay.call("BrowserRelay.queryAll", {
    tabId: tab.id,
    selector: 'shreddit-post, article, [data-testid="post-container"]',
    limit: 12,
  });
  const text = await relay.call("BrowserRelay.getText", { tabId: tab.id, selector: "body" });
  const screenshot = await relay.call("BrowserRelay.captureScreenshot", { tabId: tab.id });
  return {
    bodyTextLength: text.text.length,
    postCount: posts.count,
    screenshotLength: screenshot.dataUrl.length,
    title: title.title,
    url: url.url,
  };
}

async function testX(relay) {
  const tab = await createSiteTab(relay, "x", "https://x.com/home", false);
  const ready = await relay.call("BrowserRelay.waitForSelector", {
    tabId: tab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    timeoutMs: 30000,
  });
  const hover = await relay.call("BrowserRelay.hover", {
    tabId: tab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
  });
  const click = await relay.call("BrowserRelay.click", {
    tabId: tab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
  });
  const type = await relay.call("BrowserRelay.type", {
    tabId: tab.id,
    selector: 'input[data-testid="SearchBox_Search_Input"]',
    text: "elon musk",
  });
  const press = await relay.call("BrowserRelay.press", {
    tabId: tab.id,
    key: "Enter",
  });
  const searchUrl = await relay.call("BrowserRelay.waitForUrl", {
    tabId: tab.id,
    includes: "/search?q=elon%20musk",
    timeoutMs: 30000,
  });
  const screenshot = await relay.call("BrowserRelay.captureScreenshot", { tabId: tab.id });
  return {
    click,
    hover,
    press,
    readyWaitedMs: ready.waitedMs,
    screenshotLength: screenshot.dataUrl.length,
    searchUrl: searchUrl.url,
    type,
  };
}

async function testLinkedIn(relay) {
  const tab = await createSiteTab(relay, "linkedin", "https://www.linkedin.com/feed/", false);
  await relay.call("BrowserRelay.wait", { ms: 4000 });
  const title = await relay.call("BrowserRelay.getTitle", { tabId: tab.id });
  const url = await relay.call("BrowserRelay.getUrl", { tabId: tab.id });
  const searchInput = await relay.call("BrowserRelay.query", {
    tabId: tab.id,
    selector: 'input[placeholder*="Search"], input[aria-label*="Search"]',
  }).catch((error) => ({ error: error.message }));
  const feedCards = await relay.call("BrowserRelay.queryAll", {
    tabId: tab.id,
    selector: '[data-id], .feed-shared-update-v2, .scaffold-finite-scroll__content > *',
    limit: 12,
  }).catch((error) => ({ error: error.message }));
  const screenshot = await relay.call("BrowserRelay.captureScreenshot", { tabId: tab.id });
  return {
    feedCards,
    screenshotLength: screenshot.dataUrl.length,
    searchInput,
    title: title.title,
    url: url.url,
  };
}

async function testBatchAndPool(relay) {
  const tab = await createSiteTab(relay, "batch", "https://example.com/", true);
  const batch = await relay.call("BrowserRelay.batch", {
    steps: [
      { method: "BrowserRelay.waitForSelector", params: { tabId: tab.id, selector: "h1", timeoutMs: 8000 } },
      { method: "BrowserRelay.query", params: { tabId: tab.id, selector: "a" } },
      { method: "BrowserRelay.getText", params: { tabId: tab.id, selector: "body" } },
      { method: "BrowserRelay.scroll", params: { tabId: tab.id, y: 60 } },
    ],
  });
  const state = await relay.call("BrowserRelay.getState");
  const createdIds = [];
  for (let index = 0; index < state.maxTabs + 2; index += 1) {
    const created = await relay.call("BrowserRelay.createTab", {
      url: `https://example.com/?pool=${index}`,
      waitForLoad: false,
    });
    createdIds.push(created.tab.id);
  }
  const relayTabs = await relay.call("BrowserRelay.listTabs");
  return {
    batchResultCount: batch.results.length,
    listedCount: relayTabs.tabs.length,
    listedIds: relayTabs.tabs.map((item) => item.id),
    maxTabs: state.maxTabs,
    pooledCreateIds: createdIds,
  };
}

async function main() {
  const relay = new RelayClient(defaultRelayUrl());
  await relay.connect();

  const status = await relay.call("Relay.status");
  const results = {
    status,
    sites: {},
  };

  const suites = {
    hn: () => testHN(relay),
    reddit: () => testReddit(relay),
    x: () => testX(relay),
    linkedin: () => testLinkedIn(relay),
    batchAndPool: () => testBatchAndPool(relay),
  };

  for (const [name, run] of Object.entries(suites)) {
    try {
      results.sites[name] = {
        ok: true,
        result: await run(),
      };
    } catch (error) {
      results.sites[name] = {
        ok: false,
        error: {
          code: error.code || "SITE_TEST_FAILED",
          message: error.message,
        },
      };
    }
  }

  console.log(JSON.stringify(results, null, 2));
  relay.close();
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: {
      code: error.code || "MULTISITE_TEST_FAILED",
      message: error.message,
      stack: error.stack,
    },
  }, null, 2));
  process.exit(1);
});
