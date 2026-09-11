let currentAudio = null;
let currentWs = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "STOP") {
    stopPlayback();
    try { speechSynthesis?.cancel(); } catch {}
    sendResponse?.({ ok: true });
    return;
  }
  if (msg.type === "RESIZE") {
    resizeImage(msg.dataUrl, msg.maxWidth || 1568, msg.quality || 0.8)
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(() => sendResponse({ dataUrl: null }));
    return true;
  }
  if (msg.type !== "SPEAK") return;
  speakWithEdgeTTS(msg.text, msg.voice || "zh-CN-XiaoxiaoNeural")
    .then(() => sendResponse({ ok: true }))
    .catch(e => {
      console.error("EdgeTTS失败:", e);
      // 告诉 background 切 chrome.tts 兜底
      sendResponse({ ok: false, fallback: true, error: String(e.message || e) });
    });
  return true;
});

async function resizeImage(dataUrl, maxWidth, quality) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
  if (img.naturalWidth <= maxWidth) return dataUrl;
  const ratio = maxWidth / img.naturalWidth;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.round(img.naturalHeight * ratio);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function stopPlayback() {
  try { currentWs?.close(); } catch {}
  currentWs = null;
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    currentAudio = null;
  }
}

const TRUSTED_TOKEN = "6A5AA1D4EAB1C81B4696531A46A6E7BD";

async function genSecMsGec() {
  // Windows FILETIME ticks，向下取整到5分钟
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const str = (ticks * 10000000) + TRUSTED_TOKEN;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function speakWithEdgeTTS(text, voice) {
  stopPlayback();
  text = String(text || "").trim();
  if (!text) throw new Error("朗读文本为空");
  // Edge 单次 SSML 过长易失败，分段朗读
  const chunks = splitText(text, 1200);
  for (const chunk of chunks) {
    await speakChunk(chunk, sanitizeVoice(voice));
  }
}

function sanitizeVoice(voice) {
  if (/^[A-Za-z-]+[A-Za-z0-9-]*Neural$/.test(voice)) return voice;
  return "zh-CN-XiaoxiaoNeural";
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const out = [];
  let cur = "";
  for (const part of text.split(/(?<=[。！？!?.\n])/)) {
    if ((cur + part).length > maxLen && cur) {
      out.push(cur);
      cur = part;
    } else {
      cur += part;
    }
    if (cur.length >= maxLen) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function speakChunk(text, voice) {
  const gec = await genSecMsGec();
  const connId = crypto.randomUUID().replace(/-/g, "");
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${connId}`;

  const ws = new WebSocket(url);
  currentWs = ws;
  ws.binaryType = "arraybuffer";
  const audioChunks = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Edge TTS 超时（15s）"));
    }, 15000);
    const done = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
    ws.onerror = done(() => reject(new Error("Edge TTS WebSocket 连接失败")));
    ws.onopen = () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: { synthesis: { audio: {
            metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3"
          }}}
        })
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`;
      ws.send(
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`
      );
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) { try { ws.close(); } catch {} done(resolve)(); }
      } else {
        // 二进制帧: [2字节头长度][头][音频数据]
        try {
          const view = new DataView(ev.data);
          const headerLen = view.getUint16(0);
          const header = new TextDecoder().decode(ev.data.slice(2, 2 + headerLen));
          if (header.includes("Path:audio")) {
            audioChunks.push(ev.data.slice(2 + headerLen));
          }
        } catch {}
      }
    };
    ws.onclose = done(() => resolve());
  });
  if (currentWs === ws) currentWs = null;

  if (!audioChunks.length) throw new Error("未收到音频数据");
  const blob = new Blob(audioChunks, { type: "audio/mpeg" });
  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);
  currentAudio = audio;
  await new Promise((resolve, reject) => {
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error("音频播放失败"));
    };
    audio.play().catch(reject);
  });
}
