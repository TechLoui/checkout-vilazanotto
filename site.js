document.documentElement.classList.add("js", "reveal-ready");

const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));

const refreshIcons = () => {
  if (window.lucide) window.lucide.createIcons();
};

const initHeader = () => {
  const header = $("[data-header]");
  const toggle = $("[data-nav-toggle]");
  const nav = $("[data-nav]");
  if (!header || !toggle || !nav) return;
  const hero = $(".hero");
  const mobileHeroHeader = window.matchMedia("(max-width: 680px)");
  const pageRegions = [$("main"), $("footer"), $(".mobile-bar")].filter(Boolean);

  const setHeaderState = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 26);
    header.classList.toggle(
      "is-hidden-on-mobile-hero",
      mobileHeroHeader.matches && Boolean(hero) && hero.getBoundingClientRect().bottom > 0
    );
  };
  setHeaderState();
  window.addEventListener("scroll", setHeaderState, { passive: true });

  const setMenu = (open) => {
    document.body.classList.toggle("menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
    pageRegions.forEach((region) => { region.inert = open; });
    const icon = $("[data-lucide]", toggle);
    if (icon) icon.setAttribute("data-lucide", open ? "x" : "menu");
    refreshIcons();
    if (open) window.requestAnimationFrame(() => $("a", nav)?.focus());
  };

  toggle.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $$("a[href^='#']", header).forEach((link) => link.addEventListener("click", () => setMenu(false)));
  $$(".mobile-bar a[href^='#']").forEach((link) => link.addEventListener("click", () => setMenu(false)));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("menu-open")) {
      setMenu(false);
      toggle.focus();
    }
  });
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !document.body.classList.contains("menu-open")) return;
    const focusable = $$("a[href], button:not([disabled])", header)
      .filter((item) => item.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900 || window.innerWidth <= 680) setMenu(false);
    setHeaderState();
  });

  const sectionLinks = $$("a[href^='#']", nav);
  const sectionMap = sectionLinks
    .map((link) => ({ link, section: $(link.getAttribute("href")) }))
    .filter((item) => item.section);

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        sectionMap.forEach(({ link, section }) => {
          link.classList.toggle("is-active", section === visible.target);
        });
      },
      { rootMargin: "-25% 0px -60%", threshold: [0.01, 0.2, 0.5] }
    );
    sectionMap.forEach(({ section }) => observer.observe(section));
  }
};

const initReveals = () => {
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

  const staggerGroup = (selector, direction = "up", step = 70, maxStep = 4) => {
    $$(selector).forEach((item, index) => {
      item.dataset.reveal = direction;
      item.style.setProperty("--reveal-delay", `${Math.min(index, maxStep) * step}ms`);
    });
  };

  [
    [".signature-list article", "left", 80, 3],
    [".accommodation-features li", "up", 65, 3],
    [".journal-item", "up", 65, 3],
    [".guest-notes article", "left", 80, 2],
    [".reserve-trust li", "right", 70, 2],
    [".faq-list details", "up", 55, 4],
    [".location-card li", "right", 65, 3],
    [".footer-grid > *", "up", 70, 3]
  ].forEach((group) => staggerGroup(...group));

  const revealPresets = [
    [".hero-copy", "up", 40],
    [".hero-note", "right", 170],
    [".hero-bottom", "up", 260],
    [".editorial-collage", "right", 100],
    [".signature-visual", "left", 0],
    [".signature-content", "right", 90],
    [".accommodation", "up", 40],
    [".immersion-copy", "up", 40],
    [".guest-visual", "left", 0],
    [".guest-heading", "right", 80],
    [".reserve-frame-wrap", "scale", 90],
    [".faq-heading", "left", 0],
    [".location-card", "right", 40]
  ];

  revealPresets.forEach(([selector, direction, delay]) => {
    $$(selector).forEach((item) => {
      item.dataset.reveal = direction;
      item.style.setProperty("--reveal-delay", `${delay}ms`);
    });
  });

  const items = $$("[data-reveal]");
  if (!items.length) return;

  items.forEach((item) => {
    if (!item.dataset.reveal) item.dataset.reveal = "up";
  });

  const show = (item) => {
    if (!item.classList.contains("is-visible")) item.classList.add("is-visible");
  };

  if (!("IntersectionObserver" in window) || motionPreference.matches) {
    items.forEach(show);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        show(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -10%", threshold: 0.08 }
  );

  items.forEach((item) => observer.observe(item));

  // Evita conteúdo invisível caso um navegador suspenda o IntersectionObserver.
  window.setTimeout(() => {
    items.forEach((item) => {
      const bounds = item.getBoundingClientRect();
      if (bounds.top < window.innerHeight * 1.1 && bounds.bottom > 0) show(item);
    });
  }, 900);
};

const initHeroCarousel = () => {
  const hero = $(".hero");
  if (!hero) return;
  const track = $("[data-hero-carousel]", hero);
  if (!track) return;
  const slides = $$("[data-hero-slide]", track);
  if (slides.length < 2) return;

  const delay = 3000;
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const loadPromises = new WeakMap();
  let activeIndex = Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-active")));
  let changeToken = 0;
  let timer = null;
  let motionPaused = motionPreference.matches;
  let hoverPaused = false;
  let focusPaused = false;
  let pageVisible = !document.hidden;
  let heroVisible = true;

  const loadSlide = (slide) => {
    if (!slide) return Promise.resolve();
    if (loadPromises.has(slide)) return loadPromises.get(slide);

    if (slide.dataset.src) {
      slide.fetchPriority = "low";
      slide.src = slide.dataset.src;
      delete slide.dataset.src;
    }

    const loaded = (async () => {
      if (slide.complete && slide.naturalWidth > 0) return;
      if (typeof slide.decode === "function") {
        try {
          await slide.decode();
          return;
        } catch (_) {
          // O evento abaixo também cobre navegadores sem decode confiável.
        }
      }
      await new Promise((resolve) => {
        if (slide.complete) {
          resolve();
          return;
        }
        slide.addEventListener("load", resolve, { once: true });
        slide.addEventListener("error", resolve, { once: true });
      });
    })();

    loadPromises.set(slide, loaded);
    return loaded;
  };

  const render = (index) => {
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("is-active", slideIndex === index);
    });
    track.dataset.activeSlide = String(index + 1);
    activeIndex = index;
  };

  const show = async (requestedIndex) => {
    const index = (requestedIndex + slides.length) % slides.length;
    const token = ++changeToken;
    await loadSlide(slides[index]);
    if (token !== changeToken) return;
    render(index);
    loadSlide(slides[(index + 1) % slides.length]);
  };

  const canPlay = () => !motionPaused && !hoverPaused && !focusPaused && pageVisible && heroVisible;

  const schedule = () => {
    window.clearTimeout(timer);
    timer = null;
    if (!canPlay()) return;
    timer = window.setTimeout(async () => {
      await show(activeIndex + 1);
      schedule();
    }, delay);
  };

  if (hoverCapable) {
    hero.addEventListener("mouseenter", () => {
      hoverPaused = true;
      schedule();
    });
    hero.addEventListener("mouseleave", () => {
      hoverPaused = false;
      schedule();
    });
  }

  hero.addEventListener("focusin", () => {
    focusPaused = true;
    schedule();
  });
  hero.addEventListener("focusout", () => {
    window.requestAnimationFrame(() => {
      focusPaused = hero.contains(document.activeElement);
      schedule();
    });
  });

  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
    schedule();
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        heroVisible = entry.isIntersecting;
        schedule();
      },
      { threshold: 0.12 }
    );
    observer.observe(hero);
  }

  motionPreference.addEventListener?.("change", (event) => {
    motionPaused = event.matches;
    schedule();
  });

  render(activeIndex);
  loadSlide(slides[(activeIndex + 1) % slides.length]);
  schedule();
};

const initAccommodationDetails = () => {
  const mobileLayout = window.matchMedia("(max-width: 680px)");

  $$('[data-accommodation-details-toggle]').forEach((button) => {
    const features = document.getElementById(button.getAttribute("aria-controls") || "");
    const label = $("[data-accommodation-details-label]", button);
    if (!features || !label) return;

    const setExpanded = (expanded) => {
      features.classList.toggle("is-expanded", expanded);
      button.setAttribute("aria-expanded", String(expanded));
      label.textContent = expanded ? "Ocultar detalhes" : "Ver detalhes";
    };

    setExpanded(false);
    button.addEventListener("click", () => {
      setExpanded(button.getAttribute("aria-expanded") !== "true");
    });
    mobileLayout.addEventListener?.("change", () => setExpanded(false));
  });
};

const initGallery = () => {
  const track = $("[data-gallery-track]");
  const prev = $("[data-gallery-prev]");
  const next = $("[data-gallery-next]");
  const items = $$("[data-gallery-item]");
  const lightbox = $("[data-lightbox]");
  if (!items.length) return;

  const move = (direction) => {
    if (!track) return;
    track.scrollBy({ left: track.clientWidth * 0.72 * direction, behavior: "smooth" });
  };
  if (track) {
    prev?.addEventListener("click", () => move(-1));
    next?.addEventListener("click", () => move(1));
  }

  if (!lightbox) return;
  const image = $("[data-lightbox-image]", lightbox);
  const caption = $("[data-lightbox-caption]", lightbox);
  const close = $("[data-lightbox-close]", lightbox);
  const lightboxPrev = $("[data-lightbox-prev]", lightbox);
  const lightboxNext = $("[data-lightbox-next]", lightbox);
  let activeIndex = 0;
  let activeItems = items;
  let previousFocus = null;

  const render = () => {
    const item = activeItems[activeIndex];
    if (!item || !image) return;
    image.src = item.dataset.full || $("img", item)?.src || "";
    image.alt = item.dataset.alt || $("img", item)?.alt || "Foto da Villa Zanotto Piri";
    if (caption) caption.textContent = image.alt;
  };

  const openAt = (item) => {
    const journal = item.closest("[data-gallery-grid]");
    const accommodation = item.closest(".accommodation-gallery");
    if (journal) {
      activeItems = $$("[data-gallery-item]:not(.is-filtered-out)", journal);
    } else if (accommodation) {
      activeItems = $$("[data-gallery-item]", accommodation);
    } else {
      activeItems = items.filter((entry) => !entry.classList.contains("is-filtered-out"));
    }
    activeIndex = Math.max(0, activeItems.indexOf(item));
    previousFocus = document.activeElement;
    render();
    document.body.classList.add("lightbox-open");
    if (typeof lightbox.showModal === "function") lightbox.showModal();
    else lightbox.setAttribute("open", "");
    close?.focus();
  };

  const closeLightbox = () => {
    document.body.classList.remove("lightbox-open");
    if (typeof lightbox.close === "function") lightbox.close();
    else lightbox.removeAttribute("open");
    if (image) image.src = "";
    previousFocus?.focus?.();
  };

  const step = (direction) => {
    activeIndex = (activeIndex + direction + activeItems.length) % activeItems.length;
    render();
  };

  items.forEach((item) => item.addEventListener("click", () => openAt(item)));
  close?.addEventListener("click", closeLightbox);
  lightboxPrev?.addEventListener("click", () => step(-1));
  lightboxNext?.addEventListener("click", () => step(1));
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) closeLightbox();
  });
  lightbox.addEventListener("close", () => {
    document.body.classList.remove("lightbox-open");
    if (image) image.src = "";
    previousFocus?.focus?.();
  });
  window.addEventListener("keydown", (event) => {
    if (!lightbox.hasAttribute("open")) return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });
};

const initGalleryFilters = () => {
  const filters = $("[data-gallery-filters]");
  const grid = $("[data-gallery-grid]");
  if (!filters || !grid) return;

  const buttons = $$("[data-gallery-filter]", filters);
  const items = $$("[data-gallery-category]", grid);

  const applyFilter = (category) => {
    buttons.forEach((button) => {
      const active = button.dataset.galleryFilter === category;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    items.forEach((item) => {
      const visible = category === "all" || item.dataset.galleryCategory === category;
      item.classList.toggle("is-filtered-out", !visible);
      item.setAttribute("aria-hidden", String(!visible));
      item.tabIndex = visible ? 0 : -1;
    });
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      applyFilter(button.dataset.galleryFilter || "all");
      button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  });
};

const initMobileBar = () => {
  const bar = $(".mobile-bar");
  const heroCta = $(".hero-actions .button-primary");
  if (!bar) return;

  if (!heroCta) {
    bar.classList.add("is-ready");
    return;
  }

  const update = () => {
    const ctaHasPassed = heroCta.getBoundingClientRect().bottom <= 0;
    bar.classList.toggle("is-ready", ctaHasPassed);
  };

  if (!("IntersectionObserver" in window)) {
    update();
    window.addEventListener("scroll", update, { passive: true });
    return;
  }

  const observer = new IntersectionObserver(update, { threshold: [0, 1] });
  observer.observe(heroCta);
  update();
};

const initFaq = () => {
  const details = $$("[data-faq] details");
  details.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      details.forEach((other) => {
        if (other !== item) other.open = false;
      });
    });
  });
};

const initReserveEmbed = () => {
  const frame = $("[data-reserve-frame]");
  if (!frame) return;
  const reserveSection = frame.closest(".reserve-section");
  const frameWrap = frame.closest(".reserve-frame-wrap") || frame;
  const mobileLayout = window.matchMedia("(max-width: 680px)");
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

  const allowedParams = ["arrival_date", "departure_date", "entrada", "saida", "adults", "hospedes", "kids", "children", "_askSI", "_askSi", "askSI"];
  const pageParams = new URLSearchParams(window.location.search);
  const frameUrl = new URL(frame.getAttribute("src"), document.baseURI);
  const frameOrigin = frameUrl.origin;
  allowedParams.forEach((key) => {
    if (pageParams.has(key)) frameUrl.searchParams.set(key, pageParams.get(key));
  });
  [...pageParams.entries()]
    .filter(([key]) => /^ages\[\d*\]$/.test(key))
    .forEach(([key, value]) => frameUrl.searchParams.append(key, value));
  frame.src = frameUrl.toString();

  let lastStep = 1;
  let lastTopic = "";
  let stateFrame = 0;
  let alignFrame = 0;

  const viewportHeight = () => window.visualViewport?.height || window.innerHeight;
  const reserveIsNearViewport = () => {
    if (!reserveSection) return false;
    const bounds = reserveSection.getBoundingClientRect();
    const height = viewportHeight();
    return bounds.top < height * 0.72 && bounds.bottom > height * 0.28;
  };

  const setReserveState = () => {
    stateFrame = 0;
    const active = mobileLayout.matches && reserveIsNearViewport();
    document.body.classList.toggle("is-reserve-active", active);
    if (active && document.body.classList.contains("menu-open")) {
      $("[data-nav-toggle]")?.click();
    }
  };

  const scheduleReserveState = () => {
    if (stateFrame) return;
    stateFrame = window.requestAnimationFrame(setReserveState);
  };

  const alignReserveFrame = () => {
    window.cancelAnimationFrame(alignFrame);
    alignFrame = window.requestAnimationFrame(() => {
      const header = $("[data-header]");
      const offset = mobileLayout.matches ? 8 : (header?.offsetHeight || 72) + 12;
      const top = frameWrap.getBoundingClientRect().top + window.scrollY - offset;
      if (Math.abs(window.scrollY - top) < 4) return;
      window.scrollTo({ top, behavior: motionPreference.matches ? "auto" : "smooth" });
    });
  };

  window.addEventListener("scroll", scheduleReserveState, { passive: true });
  window.addEventListener("resize", scheduleReserveState);
  window.visualViewport?.addEventListener("resize", scheduleReserveState);
  mobileLayout.addEventListener?.("change", scheduleReserveState);
  setReserveState();

  $$("a[href='#reservar']").forEach((link) => {
    link.addEventListener("click", () => {
      if (!mobileLayout.matches) return;
      window.setTimeout(() => {
        setReserveState();
        alignReserveFrame();
      }, 90);
    });
  });

  if (window.location.hash === "#reservar") {
    window.setTimeout(() => {
      setReserveState();
      alignReserveFrame();
    }, 260);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const data = event.data || {};

    if (data.cz === "height" && Number.isFinite(data.value)) {
      const minimum = mobileLayout.matches ? Math.max(320, Math.floor(viewportHeight() - 16)) : 560;
      const maximum = mobileLayout.matches ? 2600 : 6000;
      const height = Math.min(maximum, Math.max(minimum, Math.ceil(data.value) + 4));
      frame.style.height = `${height}px`;
      scheduleReserveState();
    }

    if (data.cz === "view" && Number.isFinite(data.step) && typeof data.topic === "string") {
      const topicChanged = data.topic !== lastTopic;
      lastStep = data.step;
      lastTopic = data.topic;
      if (topicChanged && reserveIsNearViewport()) {
        setReserveState();
        alignReserveFrame();
      }
    } else if (data.cz === "step" && Number.isFinite(data.value)) {
      if (data.value !== lastStep && reserveIsNearViewport()) alignReserveFrame();
      lastStep = data.value;
    }
  });
};

const initFooterYear = () => {
  const year = $("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
};

const initHashPosition = () => {
  if (!window.location.hash) return;
  const target = $(window.location.hash);
  if (!target) return;
  window.setTimeout(() => target.scrollIntoView({ block: "start" }), 180);
};

window.addEventListener("DOMContentLoaded", () => {
  refreshIcons();
  initHeader();
  initReveals();
  initHeroCarousel();
  initAccommodationDetails();
  initGalleryFilters();
  initGallery();
  initFaq();
  initReserveEmbed();
  initMobileBar();
  initFooterYear();
  initHashPosition();
});
