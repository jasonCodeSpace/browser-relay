const DEFAULT_SERVER_URL = "ws://127.0.0.1:47892/ws?role=extension";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_MS = 20000;
const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const WAIT_CHECK_INTERVAL_MS = 50;
const EXECUTE_SCRIPT_RETRY_WINDOW_MS = 5000;
const DEFAULT_TYPE_CHAR_DELAY_MS = 70;
const DEFAULT_TYPE_CHAR_JITTER_MS = 30;
const DEFAULT_MAX_TABS = 3;
const RELAY_GROUP_TITLE = "Browser Relay";
const RELAY_GROUP_COLOR = "blue";
const STORAGE_KEYS = {
  enabled: "relayEnabled",
  maxTabs: "maxTabs",
  serverUrl: "serverUrl",
};

const PAGE_BATCHABLE_METHODS = new Map([
  ["BrowserRelay.waitForSelector", "waitForSelector"],
  ["BrowserRelay.waitForText", "waitForText"],
  ["BrowserRelay.scroll", "scroll"],
  ["BrowserRelay.scrollIntoView", "scrollIntoView"],
  ["BrowserRelay.nextPage", "nextPage"],
  ["BrowserRelay.query", "query"],
  ["BrowserRelay.queryAll", "queryAll"],
  ["BrowserRelay.describeVisible", "describeVisible"],
  ["BrowserRelay.getText", "getText"],
  ["BrowserRelay.getHtml", "getHtml"],
  ["BrowserRelay.getTitle", "getTitle"],
  ["BrowserRelay.getUrl", "getUrl"],
  ["BrowserRelay.getViewport", "getViewport"],
  ["BrowserRelay.detectRecaptcha", "detectRecaptcha"],
  ["BrowserRelay.goBack", "goBack"],
  ["BrowserRelay.goForward", "goForward"],
]);

const state = {
  attachedTabs: new Set(),
  connected: false,
  enabled: true,
  heartbeatTimer: null,
  maxTabs: DEFAULT_MAX_TABS,
  reconnectTimer: null,
  relayGroupIds: new Set(),
  relayTabs: new Map(),
  serverUrl: DEFAULT_SERVER_URL,
  socket: null,
};

init().catch((error) => {
  console.error("browser-relay init failed", error);
});

async function init() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.maxTabs,
    STORAGE_KEYS.serverUrl,
  ]);
  state.enabled = stored[STORAGE_KEYS.enabled] !== false;
  state.maxTabs = sanitizeMaxTabs(stored[STORAGE_KEYS.maxTabs]);
  state.serverUrl = stored[STORAGE_KEYS.serverUrl] || DEFAULT_SERVER_URL;

  await rebuildRelayCache();
  bindBrowserEvents();

  if (state.enabled) {
    connect();
  }
}

function bindBrowserEvents() {
  chrome.tabs.onCreated.addListener((tab) => {
    syncRelayTab(tab);
    emitEvent("browser.tabs.created", normalizeTab(tab));
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    syncRelayTab(tab, changeInfo);
    emitEvent("browser.tabs.updated", {
      tabId: tab.id,
      changeInfo,
      tab: normalizeTab(tab),
    });
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    state.attachedTabs.delete(tabId);
    state.relayTabs.delete(tabId);
    emitEvent("browser.tabs.removed", { tabId, removeInfo });
  });

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      syncRelayTab(tab);
    } catch {}
    emitEvent("browser.tabs.activated", activeInfo);
  });

  if (chrome.tabs.onAttached) {
    chrome.tabs.onAttached.addListener(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        syncRelayTab(tab);
      } catch {}
    });
  }

  if (chrome.tabs.onDetached) {
    chrome.tabs.onDetached.addListener((tabId) => {
      state.relayTabs.delete(tabId);
    });
  }

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
      state.attachedTabs.delete(source.tabId);
      emitEvent("browser.debugger.detached", { tabId: source.tabId, reason });
    }
  });

  if (chrome.tabGroups?.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      state.relayGroupIds.delete(group.id);
      for (const [tabId, tab] of state.relayTabs.entries()) {
        if (tab.groupId === group.id) {
          state.relayTabs.delete(tabId);
        }
      }
    });
  }

  if (chrome.tabGroups?.onUpdated) {
    chrome.tabGroups.onUpdated.addListener((group) => {
      if (group.title === RELAY_GROUP_TITLE) {
        state.relayGroupIds.add(group.id);
        rebuildRelayCache().catch((error) => console.warn("relay cache rebuild failed", error));
        return;
      }

      if (state.relayGroupIds.delete(group.id)) {
        for (const [tabId, tab] of state.relayTabs.entries()) {
          if (tab.groupId === group.id) {
            state.relayTabs.delete(tabId);
          }
        }
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "getState") {
      snapshotState().then(sendResponse);
      return true;
    }

    if (message?.type === "listTabs") {
      sendResponse({
        ok: true,
        tabs: getRelayTabs().map(normalizeTab),
      });
      return true;
    }

    if (message?.type === "reconnect") {
      connect(true);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "saveServerUrl") {
      saveServerUrl(message.serverUrl).then(sendResponse);
      return true;
    }

    if (message?.type === "saveMaxTabs") {
      saveMaxTabs(message.maxTabs).then(sendResponse);
      return true;
    }

    if (message?.type === "setRelayEnabled") {
      setRelayEnabled(Boolean(message.enabled)).then(sendResponse);
      return true;
    }

    return false;
  });
}

async function snapshotState() {
  return {
    attachedTabs: Array.from(state.attachedTabs.values()),
    connected: state.connected,
    enabled: state.enabled,
    maxTabs: state.maxTabs,
    relayTabCount: state.relayTabs.size,
    serverUrl: state.serverUrl,
  };
}

function sanitizeMaxTabs(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MAX_TABS;
  return Math.max(1, Math.min(12, Math.round(num)));
}

async function saveServerUrl(serverUrl) {
  const trimmed = String(serverUrl || "").trim() || DEFAULT_SERVER_URL;
  await chrome.storage.local.set({ [STORAGE_KEYS.serverUrl]: trimmed });
  state.serverUrl = trimmed;
  if (state.enabled) {
    connect(true);
  }
  return { ok: true, serverUrl: trimmed };
}

async function saveMaxTabs(value) {
  const maxTabs = sanitizeMaxTabs(value);
  await chrome.storage.local.set({ [STORAGE_KEYS.maxTabs]: maxTabs });
  state.maxTabs = maxTabs;
  await enforceAllTabPools(maxTabs);
  return { ok: true, maxTabs };
}

async function setRelayEnabled(enabled) {
  state.enabled = enabled;
  await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: enabled });

  if (!enabled) {
    disconnectSocket({ disableReconnect: true });
  } else {
    connect(true);
  }

  return {
    ok: true,
    enabled: state.enabled,
    connected: state.connected,
  };
}

function connect(force = false) {
  if (!state.enabled) {
    return;
  }

  if (force) {
    disconnectSocket({ disableReconnect: true });
  }

  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  clearInterval(state.heartbeatTimer);

  const socket = new WebSocket(state.serverUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.connected = true;
    emitEvent("relay.connected", { serverUrl: state.serverUrl });
    state.heartbeatTimer = setInterval(() => {
      sendMessage({
        type: "event",
        event: "relay.heartbeat",
        data: { ts: Date.now() },
      });
    }, HEARTBEAT_MS);
  });

  socket.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type !== "request") {
      return;
    }

    try {
      const result = await handleRequest(msg.method, msg.params || {});
      sendMessage({ type: "response", id: msg.id, ok: true, result });
    } catch (error) {
      sendMessage({
        type: "response",
        id: msg.id || "unknown",
        ok: false,
        error: {
          code: error.code || "INTERNAL_ERROR",
          message: error.message || String(error),
        },
      });
    }
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    clearInterval(state.heartbeatTimer);
    emitEvent("relay.disconnected", { serverUrl: state.serverUrl });

    if (state.enabled) {
      state.reconnectTimer = setTimeout(() => connect(), RECONNECT_DELAY_MS);
    }
  });

  socket.addEventListener("error", () => {
    state.connected = false;
  });
}

function disconnectSocket({ disableReconnect = false } = {}) {
  clearTimeout(state.reconnectTimer);
  clearInterval(state.heartbeatTimer);

  if (disableReconnect) {
    state.reconnectTimer = null;
  }

  const socket = state.socket;
  state.socket = null;
  state.connected = false;

  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    socket.close();
  }
}

function sendMessage(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify(payload));
}

function emitEvent(eventName, data) {
  sendMessage({
    type: "event",
    event: eventName,
    data,
  });
}

function normalizeTab(tab) {
  if (!tab) return null;
  return {
    active: tab.active,
    audible: tab.audible,
    discarded: tab.discarded,
    favIconUrl: tab.favIconUrl,
    frozen: tab.frozen,
    groupId: tab.groupId,
    id: tab.id,
    incognito: tab.incognito,
    index: tab.index,
    lastAccessed: tab.lastAccessed,
    mutedInfo: tab.mutedInfo,
    pinned: tab.pinned,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
  };
}

async function rebuildRelayCache() {
  const groups = chrome.tabGroups?.query
    ? await chrome.tabGroups.query({})
    : [];
  state.relayGroupIds = new Set(
    groups
      .filter((group) => group.title === RELAY_GROUP_TITLE)
      .map((group) => group.id),
  );

  const tabs = await chrome.tabs.query({});
  state.relayTabs = new Map();
  for (const tab of tabs) {
    syncRelayTab(tab);
  }
}

function syncRelayTab(tab, changeInfo = {}) {
  if (!tab?.id) {
    return;
  }

  const groupId = changeInfo.groupId ?? tab.groupId ?? -1;
  if (groupId >= 0 && state.relayGroupIds.has(groupId)) {
    state.relayTabs.set(tab.id, normalizeTab(tab));
    return;
  }

  state.relayTabs.delete(tab.id);
}

function getRelayTabs(windowId) {
  return Array.from(state.relayTabs.values())
    .filter((tab) => !windowId || tab.windowId === windowId)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

async function getRelayGroupIdForWindow(windowId) {
  const existing = getRelayTabs(windowId)[0];
  if (existing?.groupId >= 0) {
    state.relayGroupIds.add(existing.groupId);
    return existing.groupId;
  }
  return null;
}

function chooseRelayTabForReuse(relayTabs, excludeTabId) {
  const candidates = relayTabs.filter((tab) => tab.id !== excludeTabId);
  if (!candidates.length) return null;
  const active = candidates.find((tab) => tab.active);
  return active || candidates[0];
}

async function enforceAllTabPools(maxTabs = state.maxTabs) {
  const tabsByWindow = new Map();
  for (const tab of state.relayTabs.values()) {
    const list = tabsByWindow.get(tab.windowId) || [];
    list.push(tab);
    tabsByWindow.set(tab.windowId, list);
  }

  for (const windowId of tabsByWindow.keys()) {
    await enforceTabPool(windowId, maxTabs);
  }
}

async function enforceTabPool(windowId, maxTabs = state.maxTabs, keepTabIds = []) {
  const relayTabs = getRelayTabs(windowId);
  if (relayTabs.length <= maxTabs) {
    return { closedTabIds: [] };
  }

  const keepSet = new Set(keepTabIds.filter(Boolean));
  const closable = relayTabs
    .filter((tab) => !keepSet.has(tab.id))
    .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

  const overflow = relayTabs.length - maxTabs;
  const closeIds = closable.slice(0, overflow).map((tab) => tab.id);

  if (closeIds.length) {
    await chrome.tabs.remove(closeIds);
    for (const tabId of closeIds) {
      state.relayTabs.delete(tabId);
      state.attachedTabs.delete(tabId);
    }
  }

  return { closedTabIds: closeIds };
}

async function assignRelayGroup(tab) {
  let groupId = await getRelayGroupIdForWindow(tab.windowId);
  if (groupId != null) {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  }

  state.relayGroupIds.add(groupId);
  await chrome.tabGroups.update(groupId, {
    collapsed: false,
    color: RELAY_GROUP_COLOR,
    title: RELAY_GROUP_TITLE,
  });

  const freshTab = await chrome.tabs.get(tab.id);
  syncRelayTab(freshTab, { groupId });
}

async function handleRequest(method, params) {
  switch (method) {
    case "BrowserRelay.ping":
      return { pong: true, now: Date.now() };
    case "BrowserRelay.getState":
      return snapshotState();
    case "BrowserRelay.listTabs":
      return {
        tabs: params.relayOnly === false
          ? (await chrome.tabs.query(params.query || {})).map(normalizeTab)
          : getRelayTabs(params.windowId).map(normalizeTab),
      };
    case "BrowserRelay.batch":
      return runBatch(params);
    case "BrowserRelay.createTab":
      return createTab(params);
    case "BrowserRelay.closeTab":
      return closeTab(params.tabId);
    case "BrowserRelay.activateTab":
      return activateTab(params.tabId, params.focusWindow !== false);
    case "BrowserRelay.navigate":
      return navigateTab(params.tabId, params.url, params.waitForLoad !== false, params.timeoutMs);
    case "BrowserRelay.reloadTab":
      return reloadTab(params.tabId, params.bypassCache, params.waitForLoad !== false, params.timeoutMs);
    case "BrowserRelay.goBack":
      return runPageAction(params.tabId, "goBack", params);
    case "BrowserRelay.goForward":
      return runPageAction(params.tabId, "goForward", params);
    case "BrowserRelay.wait":
      return delay(params.ms || 1000).then(() => ({ waitedMs: params.ms || 1000 }));
    case "BrowserRelay.waitForSelector":
      return runPageAction(params.tabId, "waitForSelector", params);
    case "BrowserRelay.waitForText":
      return runPageAction(params.tabId, "waitForText", params);
    case "BrowserRelay.waitForUrl":
      return waitForTabUrl(params.tabId, params);
    case "BrowserRelay.click":
      return cdpClick(params.tabId, params);
    case "BrowserRelay.hover":
      return cdpHover(params.tabId, params);
    case "BrowserRelay.clickAt":
      return cdpClickAt(params.tabId, params);
    case "BrowserRelay.hoverAt":
      return cdpHoverAt(params.tabId, params);
    case "BrowserRelay.type":
      return cdpType(params.tabId, params);
    case "BrowserRelay.press":
      return cdpPress(params.tabId, params);
    case "BrowserRelay.scroll":
      return runPageAction(params.tabId, "scroll", params);
    case "BrowserRelay.scrollIntoView":
      return runPageAction(params.tabId, "scrollIntoView", params);
    case "BrowserRelay.nextPage":
      return runPageAction(params.tabId, "nextPage", params);
    case "BrowserRelay.query":
      return runPageAction(params.tabId, "query", params);
    case "BrowserRelay.queryAll":
      return runPageAction(params.tabId, "queryAll", params);
    case "BrowserRelay.describeVisible":
      return runPageAction(params.tabId, "describeVisible", params);
    case "BrowserRelay.getText":
      return runPageAction(params.tabId, "getText", params);
    case "BrowserRelay.getHtml":
      return runPageAction(params.tabId, "getHtml", params);
    case "BrowserRelay.getTitle":
      return runPageAction(params.tabId, "getTitle", params);
    case "BrowserRelay.getUrl":
      return runPageAction(params.tabId, "getUrl", params);
    case "BrowserRelay.getViewport":
      return runPageAction(params.tabId, "getViewport", params);
    case "BrowserRelay.captureScreenshot":
      return captureScreenshot(params.tabId, params);
    case "BrowserRelay.detectRecaptcha":
      return runPageAction(params.tabId, "detectRecaptcha", params);
    case "BrowserRelay.waitForManualCaptcha":
      return waitForManualCaptcha(params.tabId, params.timeoutMs);
    case "CDP.attach":
      await ensureDebugger(params.tabId);
      return { attached: true, tabId: params.tabId };
    case "CDP.detach":
      await detachDebugger(params.tabId);
      return { detached: true, tabId: params.tabId };
    case "CDP.send":
      await ensureDebugger(params.tabId);
      return chrome.debugger.sendCommand(
        { tabId: params.tabId },
        params.method,
        params.params || {},
      );
    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

async function runBatch(params = {}) {
  const steps = Array.isArray(params.steps) ? params.steps : [];
  const stopOnError = params.stopOnError !== false;
  const results = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    try {
      if (isPageBatchableStep(step)) {
        const { batchedSteps, lastIndex } = collectPageBatch(steps, index);
        const actions = batchedSteps.map((item) => ({
          action: PAGE_BATCHABLE_METHODS.get(item.method),
          params: item.params || {},
        }));
        const pageResults = await runPageBatch(step.params.tabId, actions);
        for (const pageResult of pageResults) {
          results.push({ ok: true, result: pageResult });
        }
        index = lastIndex;
        continue;
      }

      results.push({
        ok: true,
        result: await handleRequest(step.method, step.params || {}),
      });
    } catch (error) {
      const payload = {
        error: {
          code: error.code || "BATCH_STEP_FAILED",
          message: error.message || String(error),
        },
        ok: false,
      };
      results.push(payload);
      if (stopOnError) {
        break;
      }
    }
  }

  return { results };
}

function isPageBatchableStep(step) {
  return Boolean(
    step?.method &&
    step?.params?.tabId &&
    PAGE_BATCHABLE_METHODS.has(step.method),
  );
}

function collectPageBatch(steps, startIndex) {
  const first = steps[startIndex];
  const batchedSteps = [first];
  const tabId = first.params.tabId;
  let lastIndex = startIndex;

  for (let index = startIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isPageBatchableStep(step) || step.params.tabId !== tabId) {
      break;
    }
    batchedSteps.push(step);
    lastIndex = index;
  }

  return { batchedSteps, lastIndex };
}

async function createTab(params = {}) {
  const waitForLoad = params.waitForLoad !== false;
  const maxTabs = sanitizeMaxTabs(params.maxTabs ?? state.maxTabs);
  const preferReuse = params.preferReuse !== false;
  const relayTabs = getRelayTabs(params.windowId);

  const reusableTab = preferReuse ? chooseRelayTabForReuse(relayTabs, params.tabId) : null;
  if (reusableTab) {
    const result = params.url && reusableTab.url !== params.url
      ? await navigateTab(reusableTab.id, params.url, waitForLoad, params.timeoutMs)
      : await activateTab(reusableTab.id, params.focusWindow !== false);
    await enforceTabPool(result.tab.windowId, maxTabs, [result.tab.id]);
    return result;
  }

  const tab = await chrome.tabs.create({
    active: params.active !== false,
    index: params.index,
    pinned: params.pinned,
    url: params.url || "about:blank",
    windowId: params.windowId,
  });

  if (waitForLoad) {
    await waitForTabStatus(tab.id, "complete", params.timeoutMs);
  }

  const finalTab = await chrome.tabs.get(tab.id);
  if (params.group !== false) {
    await assignRelayGroup(finalTab);
  } else {
    syncRelayTab(finalTab);
  }

  await enforceTabPool(finalTab.windowId, maxTabs, [finalTab.id]);
  return { tab: normalizeTab(await chrome.tabs.get(tab.id)) };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  state.relayTabs.delete(tabId);
  state.attachedTabs.delete(tabId);
  return { closed: true, tabId };
}

async function activateTab(tabId, focusWindow = true) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  syncRelayTab(tab);
  if (focusWindow) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { tab: normalizeTab(tab) };
}

async function navigateTab(tabId, url, waitForLoad = true, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const tab = await chrome.tabs.update(tabId, { active: true, url });
  syncRelayTab(tab);
  if (waitForLoad) {
    await waitForTabStatus(tabId, "complete", timeoutMs);
  }
  return { tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

async function reloadTab(tabId, bypassCache = false, waitForLoad = true, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  await chrome.tabs.reload(tabId, { bypassCache });
  if (waitForLoad) {
    await waitForTabStatus(tabId, "complete", timeoutMs);
  }
  return { tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

function waitForTabStatus(tabId, desiredStatus = "complete", timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer = null;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
    }

    async function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === desiredStatus || tab.status === desiredStatus) {
        cleanup();
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for tab ${tabId} to reach status ${desiredStatus}`));
    }, timeoutMs);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === desiredStatus) {
        cleanup();
        resolve(tab);
      }
    }).catch(() => {});
  });
}

function waitForTabUrl(tabId, params = {}) {
  const timeoutMs = params.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let timer = null;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
    }

    function matches(url) {
      const current = String(url || "");
      const exact = params.url;
      const includes = params.includes;
      const expected = exact || includes || "";
      const mode = params.match || (exact ? "exact" : "includes");
      if (!expected) return true;
      return mode === "exact" ? current === expected : current.includes(expected);
    }

    function resolveWith(tab) {
      cleanup();
      resolve({
        found: true,
        url: tab.url,
        waitedMs: Date.now() - startedAt,
      });
    }

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      const candidateUrl = changeInfo.url || tab.url;
      if (matches(candidateUrl)) {
        resolveWith({ ...tab, url: candidateUrl });
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for tab ${tabId} URL match`));
    }, timeoutMs);

    chrome.tabs.get(tabId).then((tab) => {
      if (matches(tab.url)) {
        resolveWith(tab);
      }
    }).catch(() => {});
  });
}

async function ensureDebugger(tabId) {
  if (state.attachedTabs.has(tabId)) {
    return;
  }

  await chrome.debugger.attach({ tabId }, "1.3");
  state.attachedTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  } catch {}
  try {
    await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  } catch {}
}

async function detachDebugger(tabId) {
  if (!state.attachedTabs.has(tabId)) {
    return;
  }
  await chrome.debugger.detach({ tabId });
  state.attachedTabs.delete(tabId);
}

async function runPageAction(tabId, action, params = {}) {
  const results = await runPageBatch(tabId, [{ action, params }]);
  if (!Array.isArray(results) || !results.length) {
    throw new Error(`Page action returned no result: ${action}`);
  }
  return results[0];
}

async function runPageBatch(tabId, actions) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < EXECUTE_SCRIPT_RETRY_WINDOW_MS) {
    try {
      const results = await chrome.scripting.executeScript({
        args: [actions],
        func: pageBatchRunner,
        target: { tabId },
        world: "MAIN",
      });

      const first = Array.isArray(results) ? results[0] : null;
      if (first && Array.isArray(first.result)) {
        return first.result;
      }

      lastError = new Error("executeScript returned no batch results");
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  throw lastError || new Error(`Unable to execute page actions for tab ${tabId}`);
}

async function waitForManualCaptcha(tabId, timeoutMs = 180000) {
  const result = await runPageAction(tabId, "waitForSelector", {
    selector:
      'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]',
    timeoutMs,
  }).catch(() => null);

  if (result?.found) {
    return {
      solved: true,
      waitedMs: result.waitedMs,
      state: await runPageAction(tabId, "detectRecaptcha", {}),
    };
  }

  const finalState = await runPageAction(tabId, "detectRecaptcha", {});
  return {
    solved: !finalState.present || finalState.solved,
    waitedMs: timeoutMs,
    state: finalState,
  };
}

async function captureScreenshot(tabId, params = {}) {
  await ensureDebugger(tabId);
  const viewport = await runPageAction(tabId, "getViewport", {});
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    {
      captureBeyondViewport: params.captureBeyondViewport !== false,
      format: params.format || "png",
      fromSurface: true,
      quality: params.quality,
    },
  );

  const format = params.format || "png";
  return {
    dataUrl: `data:image/${format};base64,${result.data}`,
    format,
    viewport,
  };
}

async function getInteractablePoint(tabId, selector) {
  const point = await runPageAction(tabId, "getInteractablePoint", { selector });
  if (!point?.found) {
    throw new Error(`No interactable element matches selector: ${selector}`);
  }
  return point;
}

async function dispatchMouseClick(tabId, point, button = "left", clickCount = 1) {
  await ensureDebugger(tabId);
  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
  );
  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: point.x, y: point.y, button, clickCount },
  );
  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: point.x, y: point.y, button, clickCount },
  );
}

async function cdpClick(tabId, params = {}) {
  const point = await getInteractablePoint(tabId, params.selector);
  await dispatchMouseClick(tabId, point, params.button || "left", params.clickCount || 1);
  return {
    clicked: true,
    point,
    selector: params.selector,
  };
}

async function cdpHover(tabId, params = {}) {
  const point = await getInteractablePoint(tabId, params.selector);
  return dispatchHoverAtPoint(tabId, point, params);
}

async function resolvePoint(tabId, params = {}) {
  if (params.selector) {
    return getInteractablePoint(tabId, params.selector);
  }

  const viewport = await runPageAction(tabId, "getViewport", {});
  const rawX = Number(params.x);
  const rawY = Number(params.y);
  const ratioX = Number(params.normalizedX);
  const ratioY = Number(params.normalizedY);

  const hasAbsolute = Number.isFinite(rawX) && Number.isFinite(rawY);
  const hasNormalized = Number.isFinite(ratioX) && Number.isFinite(ratioY);
  if (!hasAbsolute && !hasNormalized) {
    throw new Error("clickAt/hoverAt requires selector, x/y, or normalizedX/normalizedY");
  }

  const x = hasAbsolute ? rawX : Math.round(viewport.viewportWidth * ratioX);
  const y = hasAbsolute ? rawY : Math.round(viewport.viewportHeight * ratioY);
  return {
    found: true,
    viewport,
    x,
    y,
  };
}

async function dispatchHoverAtPoint(tabId, point, params = {}) {
  await ensureDebugger(tabId);
  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
  );
  return {
    hovered: true,
    point,
    selector: params.selector || null,
  };
}

async function cdpClickAt(tabId, params = {}) {
  const point = await resolvePoint(tabId, params);
  await dispatchMouseClick(tabId, point, params.button || "left", params.clickCount || 1);
  return {
    clicked: true,
    point,
    selector: params.selector || null,
  };
}

async function cdpHoverAt(tabId, params = {}) {
  const point = await resolvePoint(tabId, params);
  return dispatchHoverAtPoint(tabId, point, params);
}

async function cdpType(tabId, params = {}) {
  let targetInfo = null;
  if (params.selector) {
    targetInfo = await runPageAction(tabId, "prepareTypeTarget", {
      clear: params.clear !== false,
      selector: params.selector,
    });
    const point = await getInteractablePoint(tabId, params.selector);
    await dispatchMouseClick(tabId, point);
  }

  await ensureDebugger(tabId);
  if (params.text) {
    const text = String(params.text);
    const mode = params.typingMode || "human";
    if (mode === "instant") {
      await chrome.debugger.sendCommand(
        { tabId },
        "Input.insertText",
        { text },
      );
    } else {
      await typeLikeHuman(tabId, text, {
        ...params,
        targetInfo,
      });
    }
  }
  return {
    selector: params.selector || null,
    typed: true,
    typingMode: params.typingMode || "human",
    valueLength: String(params.text || "").length,
  };
}

function splitGraphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }
  return Array.from(text);
}

function getTypingDelay(params = {}) {
  const base = Number.isFinite(Number(params.charDelayMs))
    ? Math.max(0, Number(params.charDelayMs))
    : DEFAULT_TYPE_CHAR_DELAY_MS;
  const jitter = Number.isFinite(Number(params.charJitterMs))
    ? Math.max(0, Number(params.charJitterMs))
    : DEFAULT_TYPE_CHAR_JITTER_MS;
  if (!jitter) return base;
  return base + Math.floor(Math.random() * (jitter + 1));
}

function isSimplePrintableCharacter(segment) {
  return typeof segment === "string" && /^[\x20-\x7E]$/.test(segment);
}

async function typeLikeHuman(tabId, text, params = {}) {
  const segments = splitGraphemes(text);
  const useInsertText = Boolean(params.targetInfo?.isContentEditable);
  for (const segment of segments) {
    if (useInsertText) {
      const payload = segment === "\n" ? "\n" : segment;
      await chrome.debugger.sendCommand(
        { tabId },
        "Input.insertText",
        { text: payload },
      );
    } else if (segment === "\n") {
      await dispatchKeySequence(tabId, "Enter", params);
    } else if (segment === "\t") {
      await dispatchKeySequence(tabId, "Tab", params);
    } else if (segment === " ") {
      await dispatchKeySequence(tabId, "Space", params);
    } else if (isSimplePrintableCharacter(segment)) {
      await dispatchKeySequence(tabId, segment, params);
    } else {
      await chrome.debugger.sendCommand(
        { tabId },
        "Input.insertText",
        { text: segment },
      );
    }

    const delayMs = getTypingDelay(params);
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
}

function getKeyDefinition(key, params = {}) {
  const lookup = {
    ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
    Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 },
    Enter: {
      code: "Enter",
      key: "Enter",
      text: "\r",
      unmodifiedText: "\r",
      windowsVirtualKeyCode: 13,
    },
    Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
    Space: { code: "Space", key: " ", text: " ", unmodifiedText: " ", windowsVirtualKeyCode: 32 },
    Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  };

  const base = lookup[key] || {
    code: params.code || key,
    key,
    text: key.length === 1 ? key : undefined,
    unmodifiedText: key.length === 1 ? key : undefined,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
  };

  return {
    autoRepeat: false,
    code: params.code || base.code,
    key: base.key,
    nativeVirtualKeyCode: base.windowsVirtualKeyCode,
    windowsVirtualKeyCode: base.windowsVirtualKeyCode,
    ...base,
  };
}

async function dispatchKeySequence(tabId, key, params = {}) {
  await ensureDebugger(tabId);
  const definition = getKeyDefinition(key, params);

  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchKeyEvent",
    { type: "rawKeyDown", ...definition },
  );

  if (definition.text) {
    await chrome.debugger.sendCommand(
      { tabId },
      "Input.dispatchKeyEvent",
      { type: "char", ...definition },
    );
  }

  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...definition },
  );
}

async function cdpPress(tabId, params = {}) {
  if (params.selector) {
    await runPageAction(tabId, "focus", { selector: params.selector });
  }
  const key = params.key || "Enter";
  await dispatchKeySequence(tabId, key, params);
  return {
    key,
    pressed: true,
    selector: params.selector || null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageBatchRunner(actions) {
  const DEFAULT_INTERVAL = 50;
  const DEFAULT_TIMEOUT = 15000;

  function getElement(selector) {
    if (!selector) {
      throw new Error("selector is required");
    }
    return document.querySelector(selector);
  }

  function requireElement(selector) {
    const element = getElement(selector);
    if (!element) {
      throw new Error(`No element matches selector: ${selector}`);
    }
    return element;
  }

  function visibleText(element) {
    return (element?.innerText || element?.textContent || "").trim();
  }

  function viewportRect() {
    return {
      devicePixelRatio: window.devicePixelRatio || 1,
      pageHeight: document.documentElement.scrollHeight,
      pageWidth: document.documentElement.scrollWidth,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }

  function serializeElement(element) {
    if (!element) {
      return { found: false };
    }

    const rect = element.getBoundingClientRect();
    return {
      attributes: Array.from(element.attributes || []).reduce((acc, attr) => {
        acc[attr.name] = attr.value;
        return acc;
      }, {}),
      found: true,
      html: element.outerHTML,
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      },
      tagName: element.tagName,
      text: visibleText(element),
      value: "value" in element ? element.value : undefined,
    };
  }

  function focusElement(element) {
    element.focus();
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({
        behavior: "instant",
        block: "center",
        inline: "nearest",
      });
    }
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function collapseSelectionToEnd(element) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function prepareTypeTarget(params) {
    const element = params.selector
      ? requireElement(params.selector)
      : document.activeElement || document.body;

    focusElement(element);

    if ("value" in element) {
      if (params.clear !== false) {
        element.value = "";
        dispatchInputEvents(element);
      }
      const valueLength = String(element.value || "").length;
      if (typeof element.setSelectionRange === "function") {
        element.setSelectionRange(valueLength, valueLength);
      }
    } else if (element.isContentEditable) {
      if (params.clear !== false) {
        element.textContent = "";
        dispatchInputEvents(element);
      }
      collapseSelectionToEnd(element);
    }

    return {
      isContentEditable: Boolean(element.isContentEditable),
      prepared: true,
      selector: params.selector || null,
      tagName: element.tagName,
    };
  }

  function detectRecaptchaState() {
    const widget =
      document.querySelector("div.g-recaptcha") ||
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('iframe[title*="recaptcha"]') ||
      document.querySelector('iframe[src*="hcaptcha.com"]');

    const responseField =
      document.querySelector('textarea[name="g-recaptcha-response"]') ||
      document.querySelector('textarea[name="h-captcha-response"]');

    const challengeFrame =
      document.querySelector('iframe[src*="api2/bframe"]') ||
      document.querySelector('iframe[title*="challenge"]');

    return {
      challengeOpen: Boolean(challengeFrame),
      present: Boolean(widget || responseField || challengeFrame),
      solved: Boolean(responseField && responseField.value && responseField.value.length > 0),
    };
  }

  function findInteractablePoint(selector) {
    const element = requireElement(selector);
    focusElement(element);
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      selector,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }

  function getElementLabel(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("alt"),
      visibleText(element),
    ].find((value) => value && String(value).trim()) || "";
  }

  function cssPathHint(element) {
    if (!element || element === document.body) return element?.tagName?.toLowerCase() || "";
    if (element.id) return `#${element.id}`;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const href = element.getAttribute("href");
    if (role) return `${tag}[role="${role}"]`;
    if (href) return `${tag}[href]`;
    const dataTestId = element.getAttribute("data-testid");
    if (dataTestId) return `${tag}[data-testid="${dataTestId}"]`;
    const classes = Array.from(element.classList || []).slice(0, 2);
    if (classes.length) return `${tag}.${classes.join(".")}`;
    return tag;
  }

  function describeVisibleElements(params = {}) {
    const selectors = params.selector
      ? [params.selector]
      : [
          "a[href]",
          "button",
          "input",
          "textarea",
          "[role='button']",
          "[role='link']",
          "[role='option']",
          "[data-testid]",
          "[contenteditable='true']",
        ];
    const limit = Math.min(Math.max(params.limit || 40, 1), 200);
    const minArea = Math.max(1, Number(params.minArea || 36));
    const seen = new Set();
    const results = [];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const element of nodes) {
        if (!element || seen.has(element)) continue;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.width * rect.height < minArea) continue;
        const withinViewport =
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth;
        if (!withinViewport) continue;
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const centerX = Math.round(rect.left + rect.width / 2);
        const centerY = Math.round(rect.top + rect.height / 2);
        results.push({
          ariaLabel: element.getAttribute("aria-label") || null,
          center: { x: centerX, y: centerY },
          href: element.getAttribute("href") || null,
          index: results.length,
          rect: {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          },
          role: element.getAttribute("role") || null,
          selectorHint: cssPathHint(element),
          tagName: element.tagName,
          text: getElementLabel(element).slice(0, 200),
        });
        if (results.length >= limit) {
          return {
            items: results,
            total: results.length,
            viewport: viewportRect(),
          };
        }
      }
    }

    return {
      items: results,
      total: results.length,
      viewport: viewportRect(),
    };
  }

  function waitFor(predicate, { intervalMs = DEFAULT_INTERVAL, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let timer = null;
      let observer = null;
      let finished = false;

      const cleanup = () => {
        finished = true;
        if (observer) observer.disconnect();
        if (timer) clearInterval(timer);
        window.removeEventListener("hashchange", check);
        window.removeEventListener("popstate", check);
      };

      const settle = (resolver, value) => {
        if (finished) return;
        cleanup();
        resolver(value);
      };

      const check = () => {
        try {
          const value = predicate();
          if (value) {
            settle(resolve, {
              ...value,
              waitedMs: Date.now() - startedAt,
            });
            return;
          }
        } catch {}

        if (Date.now() - startedAt >= timeoutMs) {
          settle(reject, new Error(`Timed out after ${timeoutMs}ms`));
        }
      };

      observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      window.addEventListener("hashchange", check);
      window.addEventListener("popstate", check);
      timer = setInterval(check, intervalMs);
      check();
    });
  }

  async function runAction(action, params) {
    switch (action) {
      case "focus": {
        const element = params.selector
          ? requireElement(params.selector)
          : document.activeElement || document.body;
        focusElement(element);
        return {
          focused: true,
          selector: params.selector || null,
          tagName: element.tagName,
        };
      }
      case "getInteractablePoint":
        return findInteractablePoint(params.selector);
      case "prepareTypeTarget":
        return prepareTypeTarget(params);
      case "waitForSelector":
        return waitFor(() => {
          const element = document.querySelector(params.selector);
          return element ? serializeElement(element) : null;
        }, params);
      case "waitForText":
        return waitFor(() => {
          const scope = params.selector ? requireElement(params.selector) : document.body;
          const actual = visibleText(scope);
          const expected = String(params.text || "");
          const mode = params.match || "includes";
          const matched = mode === "exact" ? actual === expected : actual.includes(expected);
          return matched ? { found: true, text: actual } : null;
        }, params);
      case "waitForUrl":
        return {
          found: true,
          url: window.location.href,
        };
      case "scroll":
        if (typeof params.top === "number" || typeof params.left === "number") {
          window.scrollTo({
            behavior: params.behavior || "auto",
            left: params.left ?? window.scrollX,
            top: params.top ?? window.scrollY,
          });
        } else {
          window.scrollBy({
            behavior: params.behavior || "auto",
            left: params.x ?? 0,
            top: params.y ?? 0,
          });
        }
        return { scrolled: true, x: window.scrollX, y: window.scrollY };
      case "scrollIntoView": {
        const element = requireElement(params.selector);
        element.scrollIntoView({
          behavior: params.behavior || "auto",
          block: params.block || "center",
          inline: params.inline || "nearest",
        });
        return { scrolledIntoView: true, selector: params.selector };
      }
      case "goBack":
        history.back();
        return { direction: "back", navigated: true };
      case "goForward":
        history.forward();
        return { direction: "forward", navigated: true };
      case "nextPage": {
        if (params.selector) {
          requireElement(params.selector).click();
          return { advanced: true, mode: "selector" };
        }

        const candidates = [
          'a[rel="next"]',
          'button[rel="next"]',
          'a[aria-label*="next" i]',
          'button[aria-label*="next" i]',
        ];

        for (const selector of candidates) {
          const element = document.querySelector(selector);
          if (element) {
            element.click();
            return { advanced: true, mode: selector };
          }
        }

        const textual = Array.from(document.querySelectorAll("a,button")).find((element) => {
          const text = visibleText(element).toLowerCase();
          return ["next", "more", "older", "下一页", "下页", "下一步"].some((word) => text.includes(word));
        });

        if (textual) {
          textual.click();
          return { advanced: true, mode: "text" };
        }

        throw new Error("No next-page control found.");
      }
      case "query":
        return serializeElement(params.selector ? getElement(params.selector) : document.body);
      case "queryAll": {
        const limit = Math.min(Math.max(params.limit || 20, 1), 200);
        const elements = Array.from(document.querySelectorAll(params.selector || "*")).slice(0, limit);
        return {
          count: elements.length,
          items: elements.map((element) => serializeElement(element)),
        };
      }
      case "describeVisible":
        return describeVisibleElements(params);
      case "getText": {
        const element = params.selector ? getElement(params.selector) : document.body;
        return { text: visibleText(element) };
      }
      case "getHtml":
        return params.selector
          ? { html: requireElement(params.selector).outerHTML }
          : { html: document.documentElement.outerHTML };
      case "getTitle":
        return { title: document.title };
      case "getUrl":
        return { url: window.location.href };
      case "getViewport":
        return viewportRect();
      case "detectRecaptcha":
        return detectRecaptchaState();
      default:
        throw new Error(`Unsupported page action: ${action}`);
    }
  }

  return (async () => {
    const results = [];
    for (const { action, params } of actions) {
      results.push(await runAction(action, params || {}));
    }
    return results;
  })();
}
