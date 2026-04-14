const DEFAULT_SERVER_URL = "ws://127.0.0.1:47892/ws?role=extension";

async function init() {
  const stored = await chrome.storage.local.get(["serverUrl", "maxTabs"]);
  document.getElementById("serverUrl").value = stored.serverUrl || DEFAULT_SERVER_URL;
  const maxTabsInput = document.getElementById("maxTabs");
  if (maxTabsInput) {
    maxTabsInput.value = String(stored.maxTabs || 3);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const serverUrl = document.getElementById("serverUrl").value.trim();
  const maxTabsInput = document.getElementById("maxTabs");
  const maxTabs = maxTabsInput ? Number(maxTabsInput.value || 3) : 3;
  await chrome.runtime.sendMessage({ type: "saveServerUrl", serverUrl });
  await chrome.runtime.sendMessage({ type: "saveMaxTabs", maxTabs });
  document.getElementById("message").textContent = "Saved.";
});

init();
