const id = new URLSearchParams(location.search).get("id");
const img = document.getElementById("img");
const msg = document.getElementById("msg");

(async () => {
  if (!id) { msg.textContent = "缺少预览 ID"; return; }
  const stored = await chrome.storage.session.get(["pending_" + id]);
  const pending = stored["pending_" + id];
  if (!pending?.dataUrl) { msg.textContent = "预览已过期，请重新截图"; return; }
  img.src = pending.dataUrl;
})();

document.getElementById("send").onclick = async () => {
  msg.textContent = "发送中…";
  try {
    const res = await chrome.runtime.sendMessage({ target: "background", type: "CONFIRMED_SEND", pendingId: id });
    if (res?.ok === false) throw new Error(res.error);
    msg.textContent = " ✅ 已发送，正在朗读";
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    msg.textContent = " ❌ " + (e.message || e);
  }
};

document.getElementById("cancel").onclick = async () => {
  try { await chrome.runtime.sendMessage({ target: "background", type: "CANCEL_SEND", pendingId: id }); } catch {}
  window.close();
};
