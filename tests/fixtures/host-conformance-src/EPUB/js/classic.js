document.documentElement.dataset.hostConformanceClassic = "executed";

addEventListener("message", (event) => {
  if (event.data?.hostConformanceSelect !== true) return;
  const text = document.getElementById("styled-probe")?.firstChild;
  const selection = getSelection();
  if (text?.nodeType !== Node.TEXT_NODE || selection === null) return;
  const exact = "Publisher resources";
  const start = text.nodeValue?.indexOf(exact) ?? -1;
  if (start < 0) return;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + exact.length);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  parent.postMessage({ type: "host-conformance-selection-ready" }, "*");
});
