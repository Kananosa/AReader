let stream = null;
const video = document.getElementById("preview");
const status = document.getElementById("status");

document.getElementById("start").onclick = async () => {
  try {
    // 停止旧流，避免重复授权泄漏
    stream?.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920, max: 2560 }, frameRate: { ideal: 15, max: 30 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    status.textContent = "捕获中";
    stream.getVideoTracks()[0].onended = () => {
      status.textContent = "捕获结束";
      cleanupStream();
    };
  } catch (e) {
    status.textContent = "授权失败 - " + e.message;
  }
};

function cleanupStream() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

document.getElementById("stop").onclick = () => {
  cleanupStream();
  status.textContent = "已停止";
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "capture" || msg.type !== "GRAB_FRAME") return;
  if (!stream || !stream.active || !video.videoWidth) {
    sendResponse({ dataUrl: null });
    return;
  }
  try {
    // 限制最大宽度 1568，节省视觉 token 和费用
    const MAX_W = 1568;
    let w = video.videoWidth, h = video.videoHeight;
    if (w > MAX_W) {
      h = Math.round(h * MAX_W / w);
      w = MAX_W;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    sendResponse({ dataUrl: canvas.toDataURL("image/jpeg", 0.8) });
  } catch (e) {
    console.error("截图失败:", e);
    sendResponse({ dataUrl: null });
  }
  return true;
});
