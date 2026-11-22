(() => {
  const root = document.documentElement,
    reduced = matchMedia("(prefers-reduced-motion: reduce)"),
    mobile = matchMedia("(max-width:700px)");
  const horse = document.getElementById("horse-logo"),
    field = document.querySelector(".motion-field"),
    toggle = document.getElementById("motion-toggle");
  const parts = Object.fromEntries(
    [
      "body",
      "tail",
      "neck",
      "mane",
      "hind-far",
      "hind-near",
      "front-far",
      "front-near",
    ].map((name) => [name, document.getElementById("horse-" + name)]),
  );
  // Eight poses follow one stride from push-off through landing and recovery.
  // The lower-leg tracks are angles relative to the body, independent of the thigh.
  const hindStride = {
    thigh: [10, 15, 4, -17, -41, -44, -23, 0],
    shin: [5, 4, -13, -45, -65, -51, -21, 2],
    hip: "718 578",
    joint: "643 647",
  };
  const frontStride = {
    thigh: [-14, -32, -26, 8, 34, 46, 32, 6],
    shin: [9, -50, -67, -30, 26, 69, 80, 47],
    hip: "939 612",
    joint: "984 636",
  };
  const lift = [-3, -12, -15, -7, 6, 10, 6, 2];
  const pitch = [-2, -2, -0.5, 1.5, 2, 1, 0, -1];
  const legs = [
    [parts["hind-near"], hindStride, 0],
    [parts["hind-far"], hindStride, 0.16],
    [parts["front-near"], frontStride, 0],
    [parts["front-far"], frontStride, 0.16],
  ].map(([upper, stride, offset]) => ({
    upper,
    lower: upper.querySelector("[data-lower-leg]"),
    stride,
    offset,
  }));

  // Periodic cubic interpolation keeps joint velocity continuous across the seam.
  function pose(track, phase) {
    const position = ((phase + 1) % 1) * track.length;
    const i = Math.floor(position),
      t = position - i;
    const at = (n) => track[(i + n + track.length) % track.length];
    const a = at(-1),
      b = at(0),
      c = at(1),
      d = at(2);
    return (
      b +
      0.5 *
        t *
        (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * b - 3 * c + d - a)))
    );
  }
  const strideMs = 1200;
  let paused = false,
    visible = true,
    elapsed = 0,
    lastTime = null,
    scheduled = 0;
  function draw(phase) {
    parts.body.setAttribute(
      "transform",
      `translate(0 ${pose(lift, phase)}) rotate(${pose(pitch, phase)} 800 550)`,
    );
    for (const { upper, lower, stride, offset } of legs) {
      const angle = pose(stride.thigh, phase + offset);
      upper.setAttribute("transform", `rotate(${angle} ${stride.hip})`);
      lower.setAttribute(
        "transform",
        `rotate(${pose(stride.shin, phase + offset) - angle} ${stride.joint})`,
      );
    }
    parts.neck.setAttribute(
      "transform",
      `rotate(${pose(pitch, phase - 0.04) * 0.8} 941 484)`,
    );
    parts.tail.setAttribute(
      "transform",
      `rotate(${pose(pitch, phase - 0.15) * 2.4} 640 476)`,
    );
    parts.mane.setAttribute(
      "transform",
      `rotate(${pose(pitch, phase - 0.1) * 1.1} 912 353)`,
    );
    horse.dataset.frame = String(Math.floor(phase * 60));
  }
  function tick(now) {
    if (lastTime !== null) elapsed = (elapsed + now - lastTime) % strideMs;
    lastTime = now;
    draw(elapsed / strideMs);
    scheduled = requestAnimationFrame(tick);
  }
  function syncMotion() {
    toggle.disabled = reduced.matches;
    toggle.textContent = reduced.matches
      ? "Reduced motion"
      : paused
        ? "Play motion"
        : "Pause motion";
    toggle.setAttribute("aria-pressed", String(paused || reduced.matches));
    if (reduced.matches) {
      elapsed = 0;
      draw(0);
    }
    if (paused || reduced.matches || document.hidden || !visible) {
      cancelAnimationFrame(scheduled);
      scheduled = 0;
      lastTime = null;
    } else if (!scheduled) scheduled = requestAnimationFrame(tick);
  }
  toggle.addEventListener("click", () => {
    paused = !paused;
    syncMotion();
  });
  reduced.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  if ("IntersectionObserver" in window)
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        syncMotion();
      },
      { rootMargin: "80px" },
    ).observe(field);
  draw(0);
  syncMotion();
  let previewView = "overview";
  const copy = {
    overview: [
      "Available test credits, reserved spending and requests awaiting approval.",
      "Actual test-credit workspace overview, cropped to show available balance and request controls.",
    ],
    approvals: [
      "An actual test-credit request awaiting its owner's approval.",
      "Actual approval queue with a test-credit request and owner approval controls.",
    ],
    activity: [
      "Saved request, policy and internal ledger events.",
      "Actual activity history showing saved agent requests and decisions.",
    ],
  };
  function isDark() {
    return (
      root.dataset.theme === "dark" ||
      (!root.dataset.theme && matchMedia("(prefers-color-scheme:dark)").matches)
    );
  }
  function updatePreview() {
    const theme = isDark() ? "dark" : "light",
      image = document.getElementById("app-preview");
    image.src = `/product/${previewView}-desktop-${theme}.webp`;
    image.alt = copy[previewView][1];
    document.getElementById("preview-mobile").srcset =
      `/product/${previewView}-mobile-${theme}.webp`;
    document.getElementById("preview-caption").textContent =
      copy[previewView][0];
    const full = mobile.matches
      ? `/product/${previewView}-mobile-${theme}.webp`
      : `/product/${previewView}-desktop-${theme}-full.webp`;
    document.getElementById("preview-full").href = full;
    document.getElementById("preview-image-link").href = full;
  }
  const tabs = [...document.querySelectorAll("[data-preview]")];
  function choose(tab) {
    previewView = tab.dataset.preview;
    tabs.forEach((button) => {
      const active = button === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document
      .getElementById("preview-panel")
      .setAttribute("aria-labelledby", tab.id);
    updatePreview();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => choose(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      choose(tabs[next]);
      tabs[next].focus();
    });
  });
  const themeButton = document.getElementById("theme");
  function updateTheme() {
    themeButton.textContent = isDark() ? "Light mode" : "Dark mode";
    themeButton.setAttribute(
      "aria-label",
      isDark() ? "Switch to light mode" : "Switch to dark mode",
    );
    updatePreview();
  }
  themeButton.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try {
      localStorage.setItem("payroute-theme", root.dataset.theme);
    } catch {}
    updateTheme();
  });
  matchMedia("(prefers-color-scheme:dark)").addEventListener(
    "change",
    updateTheme,
  );
  mobile.addEventListener("change", updatePreview);
  updateTheme();
  const dialog = document.getElementById("film-dialog"),
    video = document.getElementById("product-film");
  let filmTrigger;
  document.querySelectorAll("[data-play-film]").forEach((button) =>
    button.addEventListener("click", () => {
      filmTrigger = button;
      dialog.showModal();
      root.classList.add("film-open");
      video.play().catch(() => {});
    }),
  );
  document
    .getElementById("close-film")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    video.pause();
    root.classList.remove("film-open");
    filmTrigger?.focus();
  });
})();
