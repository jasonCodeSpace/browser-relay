async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "getState" });
  const statusEl = document.getElementById("status");
  statusEl.textContent = state.enabled ? "on" : "off";
  statusEl.className = state.enabled ? "status-ok" : "status-off";
  document.getElementById("linkStatus").textContent = state.connected ? "up" : "down";
  document.getElementById("attachedTabs").textContent = String(state.attachedTabs.length);
  document.getElementById("relayTabCount").textContent = String(state.relayTabCount || 0);
  document.getElementById("maxTabs").value = String(state.maxTabs || 3);
  document.getElementById("toggleRelay").textContent = state.enabled ? "turn off" : "turn on";
}

document.getElementById("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  await refresh();
});

document.getElementById("saveMaxTabs").addEventListener("click", async () => {
  const value = Number(document.getElementById("maxTabs").value || 3);
  await chrome.runtime.sendMessage({ type: "saveMaxTabs", maxTabs: value });
  await refresh();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("toggleRelay").addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "getState" });
  await chrome.runtime.sendMessage({
    type: "setRelayEnabled",
    enabled: !state.enabled,
  });
  await refresh();
});

refresh();
