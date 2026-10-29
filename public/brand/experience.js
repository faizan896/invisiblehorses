(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(min-width: 1001px)");
  const horse = document.getElementById("horse-logo");
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
    ].map((name) => [name, document.getElementById(`horse-${name}`)]),
  );
  const field = document.querySelector(".motion-field");
  const toggle = document.getElementById("motion-toggle");
  const preview = document.querySelector(".showcase-stage");
  const previewSection = document.getElementById("workspace-preview");
  const code = document.querySelector("#developers .code-window");
  const map = document.querySelector(".system-map");
  const wordmark = document.querySelector(".footer-brand");
  const chapters = [...document.querySelectorAll("[data-flow-step]")];

  let loaded = true,
    paused = false,
    visible = true,
    frame = 0,
    lastFrame = 0;
  let scheduled = 0,
    scrollDirty = true,
    currentChapter = -1;
  const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));
  const progress = (element) => {
    const box = element.getBoundingClientRect();
    return clamp((innerHeight - box.top) / (innerHeight + box.height));
  };
  function draw(index) {
    const phase = (index / 60) * Math.PI * 2;
    const swing = Math.sin(phase);
    const opposite = Math.sin(phase + Math.PI);
    parts.body.setAttribute(
      "transform",
      `translate(0 ${-4 + Math.cos(phase * 2) * 4})`,
    );
    parts["hind-near"].setAttribute(
      "transform",
      `rotate(${swing * 13} 697 598)`,
    );
    parts["hind-far"].setAttribute(
      "transform",
      `rotate(${opposite * 11} 602 606)`,
    );
    parts["front-near"].setAttribute(
      "transform",
      `rotate(${opposite * 13} 940 611)`,
    );
    parts["front-far"].setAttribute(
      "transform",
      `rotate(${swing * 10} 945 573)`,
    );
    parts.neck.setAttribute("transform", `rotate(${swing * 1.2} 941 484)`);
    parts.tail.setAttribute(
      "transform",
      `rotate(${Math.sin(phase - 0.4) * 3} 640 476)`,
    );
    parts.mane.setAttribute(
      "transform",
      `rotate(${Math.sin(phase + 0.4) * 2} 912 353)`,
    );
    horse.dataset.frame = String(index);
  }
  function requestTick() {
    if (!scheduled && !document.hidden) scheduled = requestAnimationFrame(tick);
  }
  function updateScroll() {
    const moving = !reduced.matches && !paused;
    const pageRange = document.documentElement.scrollHeight - innerHeight;
    document.documentElement.style.setProperty(
      "--page-progress",
      String(pageRange > 0 ? scrollY / pageRange : 0),
    );
    const p = progress(previewSection);
    preview.style.setProperty(
      "--preview-tilt",
      moving && finePointer.matches ? `${clamp(1 - p * 3) * -7}deg` : "0deg",
    );
    preview.style.setProperty(
      "--preview-scale",
      moving && finePointer.matches ? String(0.96 + clamp(p * 3) * 0.04) : "1",
    );
    field.style.setProperty(
      "--horse-drift",
      moving ? `${(progress(field) - 0.5) * 32}px` : "0px",
    );
    code.style.setProperty(
      "--code-rise",
      moving && finePointer.matches
        ? `${(progress(code) - 0.5) * -36}px`
        : "0px",
    );
    map.style.setProperty(
      "--map-draw",
      moving ? String(clamp(progress(map) * 2.5)) : "1",
    );
    wordmark.style.setProperty(
      "--wordmark-drift",
      moving ? `${(progress(wordmark) - 0.5) * 22}px` : "0px",
    );
    if (finePointer.matches) {
      let next = -1;
      let nearest = Infinity;
      chapters.forEach((chapter, i) => {
        const box = chapter.getBoundingClientRect();
        const distance = Math.abs(
          box.top + box.height / 2 - innerHeight * 0.45,
        );
        if (
          box.top < innerHeight * 0.8 &&
          box.bottom > 100 &&
          distance < nearest
        ) {
          nearest = distance;
          next = i;
        }
      });
      if (next !== -1 && next !== currentChapter) {
        currentChapter = next;
        chapters.forEach((el, i) =>
          el.classList.toggle("is-current", i === next),
        );
        document.querySelector(`[data-step="${next}"]`)?.click();
      }
    }
  }
  function tick(now) {
    scheduled = 0;
    if (scrollDirty) {
      updateScroll();
      scrollDirty = false;
    }
    if (
      loaded &&
      visible &&
      !paused &&
      !reduced.matches &&
      now - lastFrame >= 1000 / 60
    ) {
      frame = (frame + 1) % 60;
      draw(frame);
      lastFrame = now;
    }
    if (loaded && visible && !paused && !reduced.matches) requestTick();
  }
  function onScroll() {
    scrollDirty = true;
    requestTick();
  }
  function syncPreference() {
    toggle.disabled = reduced.matches;
    toggle.textContent = reduced.matches
      ? "Reduced motion"
      : paused
        ? "Play motion →"
        : "Pause motion";
    toggle.setAttribute("aria-pressed", String(paused || reduced.matches));
    if (reduced.matches) draw(0);
    onScroll();
  }
  toggle.addEventListener("click", () => {
    paused = !paused;
    document.documentElement.classList.toggle("motion-paused", paused);
    document
      .getAnimations()
      .forEach((animation) => (paused ? animation.pause() : animation.play()));
    syncPreference();
  });
  reduced.addEventListener("change", syncPreference);
  finePointer.addEventListener("change", onScroll);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onScroll();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        requestTick();
      },
      { rootMargin: "100px" },
    ).observe(field);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (!reduced.matches && !paused)
            entry.target.animate(
              [
                { opacity: 0.35, transform: "translateY(24px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
              { duration: 650, easing: "cubic-bezier(.2,.7,.2,1)" },
            );
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12 },
    );
    document
      .querySelectorAll(
        ".preview-heading, .section-heading, .control-tile, .person, .closing",
      )
      .forEach((el) => observer.observe(el));
  }
  field.classList.add("motion-ready");
  draw(0);
  syncPreference();
})();
