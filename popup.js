const els = {
  page: document.getElementById("page"), status: document.getElementById("status"),
  total: document.getElementById("total"), ceo: document.getElementById("ceo"),
  founder: document.getElementById("founder"), limit: document.getElementById("limit"),
  start: document.getElementById("start"), stop: document.getElementById("stop")
};

function setStatus(message) { els.status.textContent = message; }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkPage() {
  try {
    const tab = await getActiveTab();
    const url = new URL(tab?.url || "");
    const allowed = url.hostname === "www.linkedin.com" || url.hostname.endsWith(".linkedin.com");
    els.page.textContent = allowed ? "LinkedIn · sugerencias" : "Abre linkedin.com para usar la automatización";
    els.start.disabled = !allowed;
    els.stop.disabled = !allowed;
    if (!allowed) setStatus("La automatización funciona en pestañas de LinkedIn.");
  } catch {
    els.page.textContent = "No se pudo detectar la pestaña";
    els.start.disabled = true;
    els.stop.disabled = true;
  }
}

async function runOnPage(func, args = []) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No se encontró la pestaña activa.");
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return results?.[0]?.result;
}

function startAutomation(maxActions) {
  if (window.__ceoAutoFollow?.running) return { started: false, reason: "already-running" };
  const state = { running: true, stopped: false, count: 0, ceo: 0, founder: 0, max: maxActions, message: "Preparando sugerencias…" };
  window.__ceoAutoFollow = state;
  const titleRe = /\b(?:co[\s-]?ceo|ceo|co[\s-]?founder|founder)\b/i;
  const buttonRe = /^(follow|connect)$/i;
  const clicked = new WeakSet();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checkWeeklyInvitationLimit = () => {
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").toLowerCase();
    if (!/reached the weekly limit for connection invitations/.test(pageText)) return false;
    state.stopped = true;
    state.weeklyLimitReached = true;
    state.message = "Límite semanal de invitaciones alcanzado. Se detuvo la automatización; vuelve a intentarlo la próxima semana.";
    return true;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const visibleModal = () => [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], .artdeco-modal")]
    .find((el) => visible(el) && el.getBoundingClientRect().width > 250 && el.getBoundingClientRect().height > 200);
  const scrollFeed = (anchor, scope) => {
    const root = scope || document;
    const canScroll = (el) => {
      if (!el || el.scrollHeight <= el.clientHeight + 40) return false;
      const overflow = getComputedStyle(el).overflowY;
      return /(auto|scroll)/.test(overflow) || el === root;
    };
    let node = anchor;
    while (node && node !== root && node !== document.body && node !== document.documentElement) {
      if (canScroll(node) && root.contains(node)) {
        node.scrollBy({ top: Math.max(450, Math.floor(node.clientHeight * 0.75)), behavior: "smooth" });
        return node;
      }
      node = node.parentElement;
    }
    if (scope && canScroll(root)) {
      root.scrollBy({ top: Math.max(450, Math.floor(root.clientHeight * 0.75)), behavior: "smooth" });
      return root;
    }
    if (scope) {
      const candidates = [...root.querySelectorAll("*")].filter(canScroll)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      if (candidates[0]) {
        candidates[0].scrollBy({ top: Math.max(450, Math.floor(candidates[0].clientHeight * 0.75)), behavior: "smooth" });
        return candidates[0];
      }
    }
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollBy({ top: Math.max(500, Math.floor(window.innerHeight * 0.75)), behavior: "smooth" });
    return scroller;
  };

  (async () => {
    try {
      const showAll = [...document.querySelectorAll("button, a, [role='button']")]
        .find((el) => /^show all$/i.test((el.innerText || el.getAttribute("aria-label") || "").trim()) && visible(el));
      if (showAll) { showAll.click(); await sleep(1400); }

      let idleRounds = 0;
      while (!state.stopped && (state.max === 0 || state.count < state.max)) {
        if (checkWeeklyInvitationLimit()) break;
        const modal = visibleModal();
        const scope = modal || document;
        const controls = [...scope.querySelectorAll("button, a[role='button'], [role='button']")]
          .filter((el) => buttonRe.test((el.innerText || el.getAttribute("aria-label") || "").trim()) && visible(el) && !el.disabled && !clicked.has(el));
        let didAction = false;
        for (const control of controls) {
          if (state.stopped || (state.max !== 0 && state.count >= state.max)) break;
          let node = control;
          let card = null;
          for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            if (node.matches("li, .artdeco-card, .discover-entity-type-card, [data-view-name*='recommendation']")) { card = node; break; }
          }
          if (!card) {
            card = control;
            for (let depth = 0; card.parentElement && depth < 5; depth += 1) card = card.parentElement;
          }
          const text = card?.innerText || "";
          if (!card || !titleRe.test(text)) continue;
          clicked.add(control);
          const hasCeo = /\b(?:co[\s-]?ceo|ceo)\b/i.test(text);
          const hasFounder = /\b(?:co[\s-]?founder|founder)\b/i.test(text);
          if (hasCeo) state.ceo += 1;
          if (hasFounder) state.founder += 1;
          const action = (control.innerText || control.getAttribute("aria-label") || "").trim();
          control.click();
          state.count += 1;
          state.message = `${action} · ${state.count}${state.max ? ` de ${state.max}` : ""}`;
          didAction = true;
          await sleep(1700);
          if (checkWeeklyInvitationLimit()) break;
        }
        if (state.weeklyLimitReached) break;
        // Always advance after processing the current batch. Previously a batch
        // with any successful clicks immediately continued, so the page never
        // scrolled while there were matching cards in view.
        const anchor = controls[controls.length - 1] || (modal && modal.querySelector("li, .artdeco-card")) || document.querySelector("main") || document.body;
        const scroller = scrollFeed(anchor, modal);
        await sleep(1800);
        if (checkWeeklyInvitationLimit()) break;
        idleRounds = didAction ? 0 : idleRounds + 1;
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40) {
          // LinkedIn may append cards asynchronously after reaching the end.
          await sleep(1200);
          scrollFeed(anchor, modal);
          await sleep(700);
        }
        if (idleRounds >= 10) {
          state.message = "No hay más acciones visibles por ahora. Sigue buscando…";
          idleRounds = 0;
          await sleep(2500);
        }
      }
      if (!state.weeklyLimitReached) {
        state.message = state.stopped ? "Automatización detenida." : `Límite alcanzado: ${state.count} acciones.`;
      }
    } catch (error) {
      state.message = `Se detuvo por un error: ${error?.message || "desconocido"}`;
    } finally { state.running = false; }
  })();
  return { started: true };
}

function stopAutomation() {
  const state = window.__ceoAutoFollow;
  if (!state) return { running: false };
  state.stopped = true;
  state.message = "Deteniendo…";
  return { running: state.running };
}

function getAutomationStatus() {
  const state = window.__ceoAutoFollow;
  return state ? { running: state.running, count: state.count, ceo: state.ceo, founder: state.founder, message: state.message } : null;
}

async function refreshStatus() {
  try {
    const state = await runOnPage(getAutomationStatus);
    if (!state) return;
    els.total.textContent = state.count;
    els.ceo.textContent = state.ceo;
    els.founder.textContent = state.founder;
    setStatus(state.message);
    els.start.disabled = state.running;
    els.stop.disabled = !state.running;
  } catch { /* The active tab may have changed. */ }
}

els.start.addEventListener("click", async () => {
  const maxActions = Math.max(0, Number.parseInt(els.limit.value, 10) || 0);
  els.start.disabled = true;
  setStatus("Iniciando la búsqueda…");
  try {
    const result = await runOnPage(startAutomation, [maxActions]);
    if (result?.started) setStatus("Automatización iniciada.");
    else setStatus("La automatización ya está en marcha.");
    els.stop.disabled = false;
  } catch {
    setStatus("No se pudo iniciar. Abre LinkedIn My Network y vuelve a intentarlo.");
    els.start.disabled = false;
  }
});

els.stop.addEventListener("click", async () => {
  try { await runOnPage(stopAutomation); setStatus("Deteniendo…"); }
  catch { setStatus("No se pudo detener en esta pestaña."); }
});

checkPage();
setInterval(refreshStatus, 800);
