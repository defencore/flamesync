const elements = new Map();
export function $(id) {
  if (!elements.has(id)) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing editor element: ${id}`);
    elements.set(id, element);
  }
  return elements.get(id);
}
export function setText(id, value) {
  const element = $(id),
    text = String(value);
  if (element.textContent !== text) element.textContent = text;
}
export function bindTabs(container, onChange = () => {}) {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const item of tabs) {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      $(item.getAttribute("aria-controls")).hidden = !active;
    }
    onChange(tab);
  }
  for (const tab of tabs) {
    tab.onclick = () => select(tab);
    tab.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      event.stopPropagation();
      const index = tabs.indexOf(tab);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      select(tabs[next]);
      tabs[next].focus();
    };
  }
  return {
    selectValue(value) {
      const tab = tabs.find(
        (tab) => tab.dataset.panel === value || tab.dataset.tool === value,
      );
      if (tab) select(tab);
    },
  };
}
