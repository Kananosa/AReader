// 工具栏单击 = 直接识别（快捷键只是其中一种触发方式）
chrome.action.onClicked.addListener(async () => {
  await runCaptureFlow();
});

async function openCapturePage() {
  const url = chrome.runtime.getURL("capture.html");
  const all = await chrome.tabs.query({});
  const existing = all.find(t => t.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
}

// 右键菜单：快捷键失灵时的兜底入口
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: "areader-run", title: "AReader：识别当前页并朗读", contexts: ["action", "page"] });
    chrome.contextMenus.create({ id: "areader-stop", title: "AReader：停止朗读", contexts: ["action", "page"] });
    chrome.contextMenus.create({ id: "areader-capture", title: "AReader：打开全屏捕获页（可选）", contexts: ["action", "page"] });
    chrome.contextMenus.create({ id: "areader-history", title: "AReader：查看本机历史", contexts: ["action", "page"] });
  } catch (e) { console.warn("menu create failed:", e); }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "areader-run") await runCaptureFlow();
  else if (info.menuItemId === "areader-stop") await stopAllSpeech();
  else if (info.menuItemId === "areader-capture") await openCapturePage();
  else if (info.menuItemId === "areader-history") {
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "stop-speaking") {
    await stopAllSpeech();
    await setBadge("II", "#666666");
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
    return;
  }
  if (command !== "capture-and-ask") return;
  await runCaptureFlow();
});

// 扩展内页（preview/options/history）中转消息，不触碰任何网页 DOM
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return;
  if (msg.type === "TEST_TTS") {
    (async () => {
      const cfg = await getConfig();
      await speakText("语音测试正常", msg.voice || cfg.voice);
    })().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "STOP_TTS") {
    stopAllSpeech().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "CONFIRMED_SEND") {
    continueAfterConfirm(msg.pendingId).then(
      () => sendResponse({ ok: true }),
      e => sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }
  if (msg.type === "CANCEL_SEND") {
    (async () => {
      if (msg.pendingId) await chrome.storage.session.remove(["pending_" + msg.pendingId]);
      await setBadge("", "#000000");
    })().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function runCaptureFlow() {
  try {
    await setBadge("...", "#FFA500");
    const cfg = await getConfig();

    // 2) 去常驻化：默认只截当前可见 Tab；捕获页仅为“截全屏/其他窗口”的可选项
    const dataUrl = await capturePreferred(cfg);
    if (!dataUrl) throw new Error("截图为空：请切换到目标标签页重试；如需截全屏再打开捕获页授权");

    // 1) 安全：可选预览确认，避免隐私截图直发云端
    if (cfg.confirmBeforeSend) {
      const pendingId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await chrome.storage.session.set({
        ["pending_" + pendingId]: { dataUrl, ts: Date.now() }
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL("preview.html") + "?id=" + pendingId });
      await setBadge("WAIT", "#FFA500");
      return;
    }

    const text = await askAI(dataUrl, cfg);
    await afterAIResult(text, cfg, { image: false });
    await setBadge("OK", "#00AA00");
  } catch (e) {
    console.error(e);
    await setBadge("ERR", "#CC0000");
    await notifyError(e);
  }
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

async function continueAfterConfirm(pendingId) {
  try {
    await setBadge("...", "#FFA500");
    const cfg = await getConfig();
    const key = "pending_" + pendingId;
    const stored = await chrome.storage.session.get([key]);
    const pending = stored[key];
    if (!pending?.dataUrl) throw new Error("预览已过期，请重新截图");
    await chrome.storage.session.remove([key]);
    const text = await askAI(pending.dataUrl, cfg);
    await afterAIResult(text, cfg, { image: false });
    await setBadge("OK", "#00AA00");
  } catch (e) {
    console.error(e);
    await setBadge("ERR", "#CC0000");
    await notifyError(e);
    throw e;
  }
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

// 优先 captureVisibleTab；仅当焦点就在捕获页/历史页等扩展内页，或截取失败时，才回退到捕获页帧
async function capturePreferred(cfg) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = active?.url || "";
  const isExtensionPage = url.startsWith("chrome-extension://") ||
    url.includes("capture.html") ||
    url.includes("preview.html") ||
    url.includes("history.html") ||
    url.includes("options.html");

  // 系统页/商店页禁止截图，直接给明确提示而不是“截图为空”
  if (/^(chrome|edge|about|devtools|view-source):/.test(url)) {
    throw new Error("系统页面（chrome://、新标签页、应用商店）禁止截图，请换个普通网页（如 http/https 页面）再试");
  }

  let visibleErr = null;
  if (!isExtensionPage) {
    try {
      const winId = active?.windowId ?? null;
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: "jpeg", quality: 80 });
      } catch (e) {
        // 显式 windowId 失败时再用 null 重试一次（多窗口场景）
        if (winId != null) dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 });
        else throw e;
      }
      dataUrl = await downscaleImage(dataUrl, 1568);
      if (dataUrl) return dataUrl;
      visibleErr = new Error("captureVisibleTab 返回为空");
    } catch (e) {
      visibleErr = e;
      console.warn("captureVisibleTab 失败，回退捕获页:", e);
    }
  }
  // 回退：可选常驻捕获页（截全屏/跨窗口场景）
  const frame = await grabFromCapturePage();
  if (frame) return frame; // 捕获页侧已做 1568 缩图
  if (isExtensionPage) {
    throw new Error("当前在扩展内页，无法截取自身。请先切换到要识别的网页再试");
  }
  const detail = visibleErr ? `（可见Tab失败原因：${visibleErr.message || visibleErr}）` : "";
  throw new Error(`截图为空，请切换到目标普通网页重试${detail}；如需截全屏再打开捕获页授权`);
}

async function afterAIResult(text, cfg, opts = {}) {
  await saveHistory(text, cfg);
  pushToLanServer(text, cfg).catch(e => console.warn("内网推送失败（不影响主流程）:", e));
  await speakText(text, cfg.voice);
}

async function speakText(text, voice) {
  await ensureOffscreen();
  // 先试 Edge，失败则回退 chrome.tts（需 tts 权限）
  try {
    const res = await sendToOffscreen({ target: "offscreen", type: "SPEAK", text, voice });
    if (res?.ok === false && res?.fallback) throw new Error(res.error || "Edge TTS 失败");
    return;
  } catch (e) {
    console.warn("Edge TTS 失败，切 chrome.tts 兜底:", e);
    await chrome.tts.speak(String(text).slice(0, 2000), {
      lang: /en-US/i.test(voice || "") ? "en-US" : "zh-CN",
      rate: 1.0
    }).catch(err => { throw new Error("Edge 与系统 TTS 均失败: " + (err.message || err)); });
  }
}

function sendToOffscreen(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
    setTimeout(() => reject(new Error("offscreen 无响应")), 8000);
  }).catch(async (e) => {
    // offscreen 可能还没建好，等 300ms 重试一次
    await new Promise(r => setTimeout(r, 300));
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
      setTimeout(() => reject(e), 8000);
    });
  });
}

async function stopAllSpeech() {
  try { await sendToOffscreen({ target: "offscreen", type: "STOP" }); } catch {}
  try { await chrome.tts.stop(); } catch {}
}

async function saveHistory(text, cfg) {
  try {
    const { history = [] } = await chrome.storage.local.get(["history"]);
    history.unshift({ ts: Date.now(), text: String(text).slice(0, 4000), model: cfg.model });
    await chrome.storage.local.set({ history: history.slice(0, 100) });
  } catch (e) {
    console.warn("历史保存失败:", e);
  }
}

// 内网推送：只 POST 文本结果到自建 server.py，不注入任何网页
async function pushToLanServer(text, cfg) {
  if (!cfg.lanPushEnabled) return;
  if (!/^https?:\/\/.+/i.test(cfg.lanServerUrl || "")) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(cfg.lanServerUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.lanToken ? { Authorization: "Bearer " + cfg.lanToken } : {})
      },
      body: JSON.stringify({ text, ts: Date.now(), source: "areader" })
    });
  } finally {
    clearTimeout(timer);
  }
}

async function notifyError(e) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      title: "AI Screen Reader 出错",
      message: String(e.message || e).slice(0, 200)
    });
  } catch (notifyErr) {
    console.error("通知失败:", notifyErr);
  }
}

function setBadge(text, color) {
  try { chrome.action.setBadgeBackgroundColor({ color }); } catch {}
  return chrome.action.setBadgeText({ text });
}

function grabFromCapturePage() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    chrome.runtime.sendMessage({ target: "capture", type: "GRAB_FRAME" }, (res) => {
      if (chrome.runtime.lastError) return finish(null); // 捕获页未打开（现在是可选项）
      finish(res && res.dataUrl ? res.dataUrl : null);
    });
    const timer = setTimeout(() => finish(null), 2000);
  });
}

// Service Worker 里无 DOM，用 OffscreenDocument 缩图以节省 token/费用
async function downscaleImage(dataUrl, maxWidth = 1568) {
  if (!dataUrl) return dataUrl;
  try {
    await ensureOffscreen();
    const res = await sendToOffscreen({
      target: "offscreen", type: "RESIZE",
      dataUrl, maxWidth, quality: 0.8
    });
    return res?.dataUrl || dataUrl;
  } catch {
    return dataUrl; // 缩图失败就用原图，不阻塞主流程
  }
}

async function getConfig() {
  // 与 options.js 保持一致；apiKey/lanToken 只存 local（本机），其余存 sync
  const syncDefaults = {
    apiBase: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    prompt: "请用简体中文简要描述这张截图的内容和要点。",
    voice: "zh-CN-XiaoxiaoNeural",
    confirmBeforeSend: false,
    lanPushEnabled: false,
    lanServerUrl: "http://127.0.0.1:8222/ingest"
  };
  const localDefaults = { apiKey: "", lanToken: "" };
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(syncDefaults),
    chrome.storage.local.get(localDefaults)
  ]);
  // 迁移老数据
  if (!local.apiKey) {
    const old = await chrome.storage.sync.get(["apiKey"]);
    if (old.apiKey) {
      await chrome.storage.local.set({ apiKey: old.apiKey });
      await chrome.storage.sync.remove(["apiKey"]);
      local.apiKey = old.apiKey;
    }
  }
  return { ...syncDefaults, ...sync, ...localDefaults, ...local };
}

async function askAI(imageDataUrl, cfg) {
  if (!cfg.apiKey) throw new Error("先在扩展设置页填写 API Key（仅存本机）");
  if (!cfg.apiBase || !/^https?:\/\/.+/i.test(cfg.apiBase)) {
    throw new Error("API Base URL 格式不正确");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(`${cfg.apiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 800,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: cfg.prompt },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }]
      })
    });
    if (!resp.ok) throw new Error(`API错误 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("AI 未返回内容");
    return text;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("AI 请求超时（60s），请重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureOffscreen() {
  try {
    if (typeof chrome.offscreen.hasDocument === "function") {
      if (await chrome.offscreen.hasDocument()) return;
    }
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "语音朗读"
    });
  } catch (e) {
    // 已存在时会抛 "Only a single offscreen document may be created."，属正常竞态
    if (!String(e.message || e).includes("single offscreen")) throw e;
  }
}
