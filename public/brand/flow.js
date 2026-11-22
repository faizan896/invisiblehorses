(() => {
  const figure = document.querySelector(".flow-figure");
  const choices = figure.querySelector(".flow-choices");
  const toggle = figure.querySelector(".flow-toggle");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const description = figure.querySelector("#flow-description");
  const link = figure.querySelector("#flow-link");
  const nodes = ["supplier", "app", "hub", "engineer", "money"].map((name) => ({
    title: figure.querySelector(`[data-flow-label="${name}"]`),
    detail: figure.querySelector(`[data-flow-detail="${name}"]`),
  }));

  const examples = {
    csv: {
      nodes: nodes.map(({ title, detail }) => [
        title.textContent,
        detail.textContent,
      ]),
      description: description.textContent,
      href: link.getAttribute("href"),
      link: link.textContent,
    },
    stripe: {
      nodes: [
        ["Stripe", "Saved charge event"],
        ["Job metadata", "Job, customer and operation IDs"],
        ["Cases", "Import charge JSON"],
        ["Engineering", "Check delivery evidence"],
        ["Finance", "Inspect the captured amount"],
      ],
      description:
        "A saved Stripe event shows the captured amount. Its job ID lets engineering check delivery and finance trace the charge back to a customer.",
      href: "/app/#cases",
      link: "Open Cases →",
    },
    firecrawl: {
      nodes: [
        ["Firecrawl", "Saved crawl status"],
        ["Job context", "Job IDs + observation time"],
        ["Cases", "Import status JSON"],
        ["Engineering", "Check the reported result"],
        ["Finance", "Trace provider credits"],
      ],
      description:
        "A saved Firecrawl status response shows whether the crawl returned data and how many credits it reported. The job ID ties both to a customer.",
      href: "/app/#cases",
      link: "Open Cases →",
    },
  };

  const buttons = choices.querySelectorAll("[data-flow]");
  for (const button of buttons)
    button.addEventListener("click", () => {
      const example = examples[button.dataset.flow];
      for (const item of buttons)
        item.setAttribute("aria-pressed", String(item === button));
      nodes.forEach(({ title, detail }, i) => {
        title.textContent = example.nodes[i][0];
        detail.textContent = example.nodes[i][1];
      });
      description.textContent = example.description;
      link.textContent = example.link;
      link.href = example.href;
      // Follow the newly selected example from its inputs.
      for (const pulse of figure.querySelectorAll(".flow-pulse")) {
        for (const animation of pulse.getAnimations())
          animation.currentTime = 0;
      }
    });

  function syncMotion() {
    const paused = figure.hasAttribute("data-paused");
    toggle.disabled = reduced.matches;
    toggle.textContent = reduced.matches
      ? "Reduced motion"
      : paused
        ? "Play flow"
        : "Pause flow";
    toggle.setAttribute("aria-pressed", String(paused || reduced.matches));
  }
  toggle.addEventListener("click", () => {
    figure.toggleAttribute("data-paused");
    syncMotion();
  });
  reduced.addEventListener("change", syncMotion);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      figure.toggleAttribute("data-offscreen", !entry.isIntersecting);
    }).observe(figure);
  } else figure.removeAttribute("data-offscreen");
  choices.hidden = toggle.hidden = false;
  syncMotion();
})();
