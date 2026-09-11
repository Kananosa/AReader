async function render() {
  const { history = [] } = await chrome.storage.local.get(["history"]);
  const list = document.getElementById("list");
  if (!history.length) { list.textContent = "暂无记录"; return; }
  list.innerHTML = "";
  for (const h of history) {
    const div = document.createElement("div");
    div.className = "item";
    const ts = document.createElement("div");
    ts.className = "ts";
    ts.textContent = new Date(h.ts).toLocaleString() + (h.model ? " · " + h.model : "");
    const body = document.createElement("div");
    body.textContent = h.text;
    div.append(ts, body);
    list.append(div);
  }
}
document.getElementById("clear").onclick = async () => {
  await chrome.storage.local.set({ history: [] });
  render();
};
render();
