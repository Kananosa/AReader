const SYNC_FIELDS = ["apiBase", "model", "prompt", "voice", "confirmBeforeSend", "lanPushEnabled", "lanServerUrl"];
const SYNC_DEFAULTS = {
  apiBase: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  prompt: "请用简体中文简要描述这张截图的内容和要点。",
  voice: "zh-CN-XiaoxiaoNeural",
  confirmBeforeSend: false,
  lanPushEnabled: false,
  lanServerUrl: "http://127.0.0.1:8222/ingest"
};
const LOCAL_DEFAULTS = { apiKey: "", lanToken: "" };

async function loadAll() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  // 迁移：老版本 apiKey 曾存 sync，搬到 local 后清掉
  if (!local.apiKey) {
    const old = await chrome.storage.sync.get(["apiKey"]);
    if (old.apiKey) {
      local.apiKey = old.apiKey;
      await chrome.storage.local.set({ apiKey: old.apiKey });
      await chrome.storage.sync.remove(["apiKey"]);
    }
  }
  return { ...sync, ...local };
}

loadAll().then(cfg => {
  for (const f of SYNC_FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!cfg[f];
    else el.value = cfg[f] ?? "";
  }
  document.getElementById("apiKey").value = cfg.apiKey || "";
  document.getElementById("lanToken").value = cfg.lanToken || "";
});

document.getElementById("save").onclick = async () => {
  const msg = document.getElementById("msg");
  try {
    const syncCfg = {};
    for (const f of SYNC_FIELDS) {
      const el = document.getElementById(f);
      syncCfg[f] = el.type === "checkbox" ? el.checked : el.value.trim();
    }
    const apiKey = document.getElementById("apiKey").value.trim();
    const lanToken = document.getElementById("lanToken").value.trim();
    if (syncCfg.apiBase && !/^https?:\/\/.+/i.test(syncCfg.apiBase)) {
      throw new Error("API Base URL 格式不正确，需以 http(s):// 开头");
    }
    if (!syncCfg.model) throw new Error("模型不能为空");
    if (!syncCfg.prompt) throw new Error("提示词不能为空");
    if (syncCfg.lanPushEnabled && !/^https?:\/\/.+/i.test(syncCfg.lanServerUrl)) {
      throw new Error("内网服务器地址格式不正确");
    }
    await chrome.storage.sync.set(syncCfg);
    await chrome.storage.local.set({ apiKey, lanToken });
    // 防残留：确保 sync 里没有明文 key
    await chrome.storage.sync.remove(["apiKey", "lanToken"]);
    msg.style.color = "green";
    msg.textContent = " ✅ 已保存（Key 仅存本机）";
  } catch (e) {
    msg.style.color = "red";
    msg.textContent = " ❌ " + (e.message || e);
  }
};

document.getElementById("testTts").onclick = async () => {
  const msg = document.getElementById("msg");
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "SPEAK", text: "语音测试正常", voice: document.getElementById("voice").value });
  } catch (e) {
    // service worker 休眠时直接走 offscreen 通道可能失败，改经 background 中转
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "TEST_TTS", voice: document.getElementById("voice").value });
    } catch (e2) {
      msg.style.color = "red";
      msg.textContent = " ❌ " + (e2.message || e2);
    }
  }
};

document.getElementById("stopTts").onclick = async () => {
  try {
    await chrome.runtime.sendMessage({ target: "background", type: "STOP_TTS" });
  } catch {}
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" });
  } catch {}
};
