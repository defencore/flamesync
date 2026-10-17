export function bindTooltips() {
  const tooltip = document.createElement("div");
  tooltip.id = "info-tooltip";
  tooltip.role = "tooltip";
  tooltip.hidden = true;
  document.body.append(tooltip);
  let active = null,
    pinned = false;
  function hide() {
    active?.removeAttribute("aria-describedby");
    tooltip.hidden = true;
    active = null;
    pinned = false;
  }
  function show(button, pin = false) {
    if (active !== button) active?.removeAttribute("aria-describedby");
    active = button;
    pinned = pin;
    tooltip.textContent = button.dataset.help;
    tooltip.hidden = false;
    button.setAttribute("aria-describedby", tooltip.id);
    const rect = button.getBoundingClientRect(),
      width = tooltip.offsetWidth,
      height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
    tooltip.style.top = `${rect.bottom + height + 12 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)}px`;
  }
  document.addEventListener("pointerover", (event) => {
    const button = event.target.closest(".info-button");
    if (button && !pinned) show(button);
  });
  document.addEventListener("pointerout", (event) => {
    if (
      !pinned &&
      event.target.closest(".info-button") &&
      !event.relatedTarget?.closest?.("#info-tooltip")
    )
      hide();
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target.closest(".info-button");
    if (button) show(button);
  });
  document.addEventListener("focusout", (event) => {
    if (!pinned && event.target.closest(".info-button")) hide();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".info-button");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      if (active === button && pinned) hide();
      else show(button, true);
    } else if (!event.target.closest("#info-tooltip")) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      hide();
    }
  });
  window.addEventListener("scroll", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide);
  document.addEventListener("flamesync:language", hide);
}
