// Route-only Airshows archive and cinematic-story rendering.
function renderAirshowsPage() {
    if (!els.airshowTimeline || !els.airshowPageCount) {
      return;
    }

    const airshows = state.data.airshows || [];
    if (state.selectedAirshowId && !airshows.some((airshow) => airshow.id === state.selectedAirshowId)) {
      state.selectedAirshowId = null;
    }
    renderAirshowArchiveHero(airshows);

    if (!airshows.length) {
      els.airshowTimeline.innerHTML = '<div class="empty-state">Tag photos with an airshow or event name to build this timeline.</div>';
      renderArchivePagination(els.airshowPagination, 0, 0, "airshows", "airshow events");
      return;
    }

    const visibleAirshows = isFocusedMobileLayout()
      ? airshows.slice(0, state.airshowVisibleCount)
      : airshows;
    els.airshowTimeline.innerHTML = visibleAirshows.map(renderAirshowTimelineItem).join("");
    renderArchivePagination(
      els.airshowPagination,
      visibleAirshows.length,
      airshows.length,
      "airshows",
      "airshow events"
    );
  }

  function renderAirshowArchiveHero(airshows) {
    if (!els.airshowHeroMedia) {
      return;
    }

    const eventPhotoSets = airshows.map((airshow) => ({ airshow, photos: photosForAirshow(airshow) }));
    const eventHeroIds = new Set(
      eventPhotoSets
        .map(({ airshow, photos: eventPhotos }) => airshowHeroPhoto(airshow, eventPhotos)?.id)
        .filter(Boolean)
    );
    const photos = unique(airshows.flatMap((airshow) => airshow.photoIds || []))
      .map((photoId) => state.photoById.get(photoId))
      .filter(Boolean);
    const latestNonHeroPhoto = photos
      .filter((photo) => !eventHeroIds.has(photo.id) && (photo.image || photo.thumbnail))
      .sort(sortPhotos)[0]
      || null;
    const hero = latestNonHeroPhoto
      || eventPhotoSets.map(({ airshow, photos: eventPhotos }) => airshowHeroPhoto(airshow, eventPhotos)).find(Boolean)
      || null;
    const locationCount = unique(photos.map((photo) => photo.pinId || photo.locationName)).length;
    const years = airshows
      .flatMap((airshow) => [airshow.firstDate, airshow.latestDate])
      .map((date) => Number(String(date || "").slice(0, 4)))
      .filter((year) => Number.isFinite(year) && year > 0)
      .sort((a, b) => a - b);
    const yearRange = years.length
      ? years[0] === years[years.length - 1]
        ? String(years[0])
        : `${years[0]} - ${years[years.length - 1]}`
      : "Archive dates unavailable";

    els.airshowPageCount.textContent = String(airshows.length);
    els.airshowPageCount.setAttribute("aria-label", `${airshows.length} airshow events`);
    els.airshowHeroPhotoCount.textContent = String(photos.length);
    els.airshowHeroLocationCount.textContent = String(locationCount);
    els.airshowYearRange.textContent = `${yearRange} · Newest first`;
    els.airshowHeroMedia.innerHTML = hero
      ? renderResponsivePhotoImage(hero, "", { sizes: "100vw", eager: true, fullResolution: true })
      : '<span class="airshow-archive-media-fallback"></span>';
  }

  function renderAirshowTimelineItem(airshow, index = 0) {
    const photos = photosForAirshow(airshow);
    const hero = airshowHeroPhoto(airshow, photos);
    const date = airshow.latestDate || airshow.firstDate || "";
    const cover = hero ? hero.image || hero.thumbnail || "" : "";
    const latestLabel = date ? formatDisplayDate(date) : "Date unknown";
    const identityMarks = renderAirshowIdentityMarks(photos);

    return `
      <article class="airshow-timeline-item" id="airshow-${escapeAttr(airshow.id)}">
        <div class="airshow-timeline-marker" aria-hidden="true">
          <span></span>
          <time datetime="${escapeAttr(date)}">${escapeHtml(latestLabel)}</time>
        </div>
        <button
          class="airshow-timeline-card"
          type="button"
          data-airshow-id="${escapeAttr(airshow.id)}"
          aria-label="${escapeAttr(`Open ${airshow.name}: ${photos.length} photo${photos.length === 1 ? "" : "s"}.`)}"
          style="--airshow-delay: ${Math.min(index, 5) * 30}ms"
        >
          ${cover ? renderResponsivePhotoImage(hero, `${airshow.name} hero photo`, {
            sizes: "(max-width: 760px) 100vw, 50vw",
            fullResolution: true
          }) : '<span class="airshow-timeline-placeholder">No event photo</span>'}
          <span class="airshow-timeline-scrim" aria-hidden="true"></span>
          <span class="airshow-card-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
          <span class="airshow-timeline-content">
            <span class="eyebrow">${escapeHtml(latestLabel)}</span>
            <strong>${escapeHtml(airshow.name)}</strong>
            <span class="airshow-timeline-meta">
              <span>${photos.length} photo${photos.length === 1 ? "" : "s"}</span>
              ${identityMarks}
            </span>
          </span>
        </button>
      </article>
    `;
  }

  function renderAirshowDetail() {
    destroyAirshowStory();
    if (!els.airshowDetail) {
      return;
    }

    const sourceAirshow = state.airshowById.get(state.selectedAirshowId);
    const airshow = previewAirshow(sourceAirshow);
    if (!airshow) {
      els.airshowDetail.innerHTML = '<div class="empty-state">Choose an event from the Airshows archive to open its field report.</div>';
      return;
    }

    if (state.data.payload !== "full") {
      hydrateFullPhotoData().then((updated) => {
        if (updated && state.selectedAirshowId === airshow.id) {
          renderAirshowDetail();
        }
      });
    }

    const photos = photosForAirshow(airshow);
    const hero = airshowHeroPhoto(airshow, photos) || photos[0] || null;
    const heroImage = hero ? hero.image || hero.thumbnail || "" : "";
    const dateStart = airshow.firstDate || airshow.latestDate || "";
    const dateEnd = airshow.latestDate || airshow.firstDate || "";
    const dateLabel = dateStart && dateEnd && dateStart !== dateEnd
      ? `${formatDisplayDate(dateStart)} - ${formatDisplayDate(dateEnd)}`
      : dateStart
        ? formatDisplayDate(dateStart)
        : "Date unknown";
    const groups = airshowPhotoGroups(photos);
    const storySegments = airshowStorySegments(airshow, photos);
    const hasCinematicStory = photos.length >= 2 && storySegments.length >= 1;

    els.airshowDetail.innerHTML = `
      ${hasCinematicStory
        ? renderAirshowCinematicStory(airshow, storySegments, hero, dateLabel)
        : renderDetailHero({
          backView: "airshowsView",
          backLabel: "Airshows",
          eyebrow: "",
          title: airshow.name,
          description: dateLabel,
          image: heroImage,
          alt: `${airshow.name} hero photo`,
          photo: hero,
          actions: renderFieldGuideActions("Airshow actions"),
          className: "airshow-field-guide-hero"
        })}
      ${renderOfflineMediaCoverage()}
      ${renderPageWriteUp(airshow.writeUp, "About this airshow")}

      <section class="detail-photo-section airshow-detail-archive">
        <div class="detail-section-heading">
          <div>
            <h2>Event archive</h2>
          </div>
          <span class="count-pill">${photos.length}</span>
        </div>
        ${groups.length ? renderAirshowPhotoGroups(groups) : '<div class="empty-state">No event photos found.</div>'}
      </section>
    `;
    if (hasCinematicStory) {
      window.requestAnimationFrame(mountAirshowStory);
    }
    scheduleOfflineMediaCoverageRefresh();
  }

  function previewAirshow(airshow) {
    if (!airshow || state.airshowPreview?.eventId !== airshow.id) return airshow;
    const story = state.airshowPreview.story || {};
    return {
      ...airshow,
      storyMode: story.mode || "cinematic",
      story: {
        ...(airshow.story || {}),
        ...story,
        mode: story.mode || "cinematic"
      }
    };
  }

  function photosForAirshow(airshow) {
    return (airshow.photoIds || []).map((photoId) => state.photoById.get(photoId)).filter(Boolean).sort(sortPhotos);
  }

  function airshowHeroPhoto(airshow, photos) {
    return state.photoById.get(airshow.heroPhotoId) || [...photos].sort(sortPhotos)[0] || null;
  }

  function airshowPhotoCaptureTime(photo) {
    const rawValue = photo?.exif?.DateTimeOriginal || photo?.capturedAt || photo?.sortDate || photo?.date || "";
    const raw = String(rawValue).trim();
    const isoValue = raw.replace(
      /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
      (_, year, month, day, hour = "00", minute = "00", second = "00") => `${year}-${month}-${day}T${hour}:${minute}:${second}`
    );
    const parsed = Date.parse(isoValue || raw);
    if (Number.isFinite(parsed)) return parsed;
    return Number.isFinite(photo?.sortTime) ? photo.sortTime : 0;
  }

  function airshowStoryLabel(photo) {
    const rawValue = photo?.exif?.DateTimeOriginal || photo?.capturedAt || photo?.sortDate || photo?.date || "";
    const match = String(rawValue).trim().match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!match) return "Chronological sequence";
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return match[4] ? `${formatDisplayDate(date)} · ${match[4]}:${match[5]}` : formatDisplayDate(date);
  }

  function airshowStoryPhotoRecord(photo, config = {}) {
    const focalX = Number(config.focalX);
    const focalY = Number(config.focalY);
    return {
      photo,
      focalX: Math.min(1, Math.max(0, Number.isFinite(focalX) ? focalX : 0.5)),
      focalY: Math.min(1, Math.max(0, Number.isFinite(focalY) ? focalY : 0.5)),
      motion: ["auto", "push-left", "push-right", "pull-in", "hold"].includes(config.motion)
        ? config.motion
        : "auto"
    };
  }

  function airshowStorySegments(airshow, photos) {
    const sourceSegments = Array.isArray(airshow.story?.segments)
      ? airshow.story.segments
      : Array.isArray(airshow.story?.moments)
        ? airshow.story.moments
        : [];
    const eventPhotoIds = new Set(photos.map((photo) => photo.id));
    const usedPhotoIds = new Set();
    const authoredSegments = sourceSegments.map((segment, index) => {
      const photoConfigs = Array.isArray(segment.photos) ? segment.photos : [];
      const storyPhotos = photoConfigs.map((config) => {
        const photo = state.photoById.get(String(config.photoId || ""));
        if (!photo || !eventPhotoIds.has(photo.id)) return null;
        if (usedPhotoIds.has(photo.id)) return null;
        usedPhotoIds.add(photo.id);
        return airshowStoryPhotoRecord(photo, config);
      }).filter(Boolean);
      if (!storyPhotos.length) return null;
      const primary = storyPhotos[0].photo;
      return {
        id: String(segment.id || `segment-${index + 1}`),
        label: String(segment.label || airshowStoryLabel(primary)),
        headline: String(segment.headline || photoSubjectLabel(primary)),
        body: String(segment.body || primary.caption || primary.title || ""),
        overlaySide: segment.overlaySide === "right" ? "right" : "left",
        photos: storyPhotos,
        firstPhotoTime: airshowPhotoCaptureTime(primary),
        authored: true
      };
    }).filter(Boolean);

    // The manager generates segments chronologically. Once a user manually
    // reorders them, the persisted array/position order becomes authoritative.
    return authoredSegments.map((segment, index) => ({
      ...segment,
      overlaySide: segment.authored ? segment.overlaySide : (index % 2 ? "right" : "left")
    }));
  }

  function renderAirshowStoryImage(scene, index, options = {}) {
    const config = scene.photos[0];
    const photo = config.photo;
    const thumbnail = photo.thumbnail || photo.image || "";
    const full = photo.image || thumbnail;
    if (!thumbnail) return '<span class="airshow-story-media-fallback"></span>';
    const className = options.backdrop ? "airshow-story-scene-backdrop" : "airshow-story-scene-image";
    const storyAttributes = options.backdrop
      ? ""
      : ` data-story-thumb="${escapeAttr(thumbnail)}"${full ? ` data-story-full="${escapeAttr(full)}"` : ""}`;
    return `<img class="${className}" data-photo-media="story" data-photo-id="${escapeAttr(photo.id)}" src="${escapeAttr(thumbnail)}"${storyAttributes} alt="${escapeAttr(`${photoSubjectLabel(photo)} at ${photo.locationName}`)}" loading="${index < 2 ? "eager" : "lazy"}" decoding="async" style="object-position:${(config.focalX * 100).toFixed(2)}% ${(config.focalY * 100).toFixed(2)}%">`;
  }

  function renderAirshowStoryCarousel(segment, segmentIndex) {
    const supporting = segment.photos.slice(1);
    if (!supporting.length) return "";
    const headline = segment.headline || "this segment";
    return `
      <section class="airshow-story-carousel" aria-label="More photos from ${escapeAttr(headline)}">
        <div class="airshow-story-carousel-head">
          <span>More photos</span>
          ${supporting.length > 1 ? `
            <span class="airshow-story-carousel-controls" hidden>
              <button type="button" data-story-carousel-prev aria-label="Show earlier photos from ${escapeAttr(headline)}">←</button>
              <button type="button" data-story-carousel-next aria-label="Show later photos from ${escapeAttr(headline)}">→</button>
            </span>
          ` : ""}
        </div>
        <div class="airshow-story-carousel-rail" data-story-carousel-rail tabindex="0" aria-label="More photos from ${escapeAttr(headline)}">
          ${supporting.map((item, index) => {
            const photo = item.photo;
            const subject = photoSubjectLabel(photo);
            const source = photo.thumbnail || photo.image || "";
            return `
              <button class="airshow-story-carousel-frame" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="airshow" data-story-segment-index="${segmentIndex}" aria-label="Open supporting photo ${index + 1} of ${supporting.length}: ${escapeAttr(subject)}">
                ${source ? `<img data-photo-media="story" data-photo-id="${escapeAttr(photo.id)}" src="${escapeAttr(source)}" loading="lazy" decoding="async" alt="${escapeAttr(`${subject} at ${photo.locationName}`)}">` : '<span class="airshow-story-media-fallback"></span>'}
              </button>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function renderAirshowCinematicStory(airshow, segments, hero, dateLabel) {
    const introPhoto = hero || segments[0].photos[0].photo;
    const intro = {
      id: `${airshow.id}-intro`,
      label: dateLabel,
      headline: airshow.name,
      body: "A chronological field report, sequenced from the photographs captured at the event.",
      overlaySide: "left",
      photos: [{photo: introPhoto, focalX: 0.5, focalY: 0.5, motion: "pull-in"}],
      intro: true
    };
    const slides = [intro, ...segments];
    return `
      <section class="airshow-story" data-airshow-story aria-labelledby="airshow-story-title">
        <div class="airshow-story-stage">
          <ol class="airshow-story-track" data-story-track tabindex="0" aria-label="Chronological airshow segments">
            ${slides.map((slide, index) => {
              const photo = slide.photos[0].photo;
              const overlaySide = slide.overlaySide === "right" ? "right" : "left";
              return `
                <li class="airshow-story-slide${slide.intro ? " is-intro" : ""} is-overlay-${overlaySide}" data-story-slide="${index}">
                  <div class="airshow-story-scene" data-story-scene="${index}" aria-hidden="true">
                    ${renderAirshowStoryImage(slide, index)}
                    ${renderAirshowStoryImage(slide, index, {backdrop: true})}
                  </div>
                  <div class="airshow-story-vignette" aria-hidden="true"></div>
                  <article class="airshow-story-copy">
                    <div class="airshow-story-copy-main">
                      <div class="airshow-story-copy-meta">
                        <p class="airshow-story-index">${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</p>
                        ${slide.label ? `<p class="eyebrow">${escapeHtml(slide.label)}</p>` : ""}
                      </div>
                      <div class="airshow-story-copy-content">
                        ${slide.intro
                          ? `<h1 id="airshow-story-title">${escapeHtml(slide.headline)}</h1>`
                          : `<h2>${escapeHtml(slide.headline)}</h2>`}
                        ${slide.body ? `<p class="airshow-story-body">${escapeHtml(slide.body)}</p>` : ""}
                      </div>
                      ${!slide.intro ? `<button class="airshow-story-view-frame" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="airshow" data-story-segment-index="${index}">View hero</button>` : ""}
                    </div>
                    ${!slide.intro ? renderAirshowStoryCarousel(slide, index) : ""}
                  </article>
                </li>
              `;
            }).join("")}
          </ol>
          <div class="airshow-story-topbar">
            <button class="detail-back-button airshow-story-back" type="button" data-detail-back="airshowsView">← Airshows</button>
            ${renderFieldGuideActions("Airshow actions")}
          </div>
          <div class="airshow-story-progress" aria-hidden="true"><span data-story-progress></span></div>
          <nav class="airshow-story-route" aria-label="Airshow story segments. Scroll vertically or select a segment.">
            ${slides.map((slide, index) => `<button type="button" data-story-jump="${index}" aria-label="Jump to ${escapeAttr(slide.headline)}"><span></span><b>${String(index + 1).padStart(2, "0")}</b></button>`).join("")}
          </nav>
          <div class="airshow-story-scroll-cue" aria-hidden="true"><span>Scroll for the next segment</span><i></i></div>
        </div>
      </section>
    `;
  }

  function destroyAirshowStory() {
    state.airshowStoryController?.destroy?.();
    state.airshowStoryController = null;
  }

  function mountAirshowStory() {
    destroyAirshowStory();
    const root = els.airshowDetail?.querySelector("[data-airshow-story]");
    if (!root) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = navigator.connection?.saveData === true;
    const track = root.querySelector("[data-story-track]");
    const slides = [...root.querySelectorAll("[data-story-slide]")];
    const scenes = [...root.querySelectorAll("[data-story-scene]")];
    const routeButtons = [...root.querySelectorAll("[data-story-jump]")];
    const progress = root.querySelector("[data-story-progress]");
    const abortController = new AbortController();
    let observer = null;
    let activeIndex = -1;
    let wheelGestureLocked = false;
    let wheelGestureTimer = 0;
    let carouselMeasureFrame = 0;
    let photoBoundsMeasureFrame = 0;

    if (!track || !slides.length) return;

    function syncStoryPhotoBounds() {
      photoBoundsMeasureFrame = 0;
      slides.forEach((slide) => {
        const scene = slide.querySelector("[data-story-scene]");
        const image = scene?.querySelector(".airshow-story-scene-image");
        if (!scene || !image || !scene.clientWidth || !scene.clientHeight) return;
        const copy = slide.querySelector(".airshow-story-copy");
        if (copy) {
          const sceneBounds = scene.getBoundingClientRect();
          const copyBounds = copy.getBoundingClientRect();
          const mediaBottom = Math.max(0, sceneBounds.bottom - copyBounds.top + 14);
          slide.style.setProperty("--airshow-story-mobile-media-bottom", `${mediaBottom.toFixed(2)}px`);
        }
        const ratio = image.naturalWidth && image.naturalHeight
          ? image.naturalWidth / image.naturalHeight
          : 16 / 9;
        const containedWidth = Math.min(scene.clientWidth, scene.clientHeight * ratio);
        const horizontalInset = Math.max(0, (scene.clientWidth - containedWidth) / 2);
        slide.style.setProperty("--airshow-story-photo-inset", `${horizontalInset.toFixed(2)}px`);
      });
    }

    function scheduleStoryPhotoBounds() {
      if (!photoBoundsMeasureFrame) {
        photoBoundsMeasureFrame = window.requestAnimationFrame(syncStoryPhotoBounds);
      }
    }

    scenes.forEach((scene) => {
      scene.querySelector(".airshow-story-scene-image")?.addEventListener("load", scheduleStoryPhotoBounds, {
        signal: abortController.signal
      });
    });
    scheduleStoryPhotoBounds();

    function syncSceneMedia(displayIndex) {
      scenes.forEach((scene, index) => {
        const image = scene.querySelector("img[data-story-thumb]");
        if (!image) return;
        const useFull = !saveData && Math.abs(index - displayIndex) <= 1;
        const source = useFull ? image.dataset.storyFull || image.dataset.storyThumb : image.dataset.storyThumb;
        if (source && image.getAttribute("src") !== source) image.src = source;
      });
    }

    function activateSlide(index) {
      if (index === activeIndex || index < 0 || index >= slides.length) return;
      activeIndex = index;
      slides.forEach((slide, slideIndex) => {
        slide.classList.toggle("is-active", slideIndex === index);
        if (slideIndex === index) slide.setAttribute("aria-current", "step");
        else slide.removeAttribute("aria-current");
      });
      routeButtons.forEach((button, buttonIndex) => {
        button.classList.toggle("is-active", buttonIndex === index);
        if (buttonIndex === index) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });
      syncSceneMedia(index);
      if (progress) progress.style.transform = `scaleX(${((index + 1) / slides.length).toFixed(4)})`;
      root.classList.toggle("is-complete", index === slides.length - 1);
    }

    routeButtons.forEach((button, index) => {
      button.addEventListener("click", () => {
        const slide = slides[index];
        if (!slide) return;
        track.style.scrollBehavior = "auto";
        track.scrollTop = slide.offsetTop;
      }, {signal: abortController.signal});
    });

    function syncCarouselControls() {
      carouselMeasureFrame = 0;
      root.querySelectorAll(".airshow-story-carousel").forEach((carousel) => {
        const rail = carousel.querySelector("[data-story-carousel-rail]");
        const controls = carousel.querySelector(".airshow-story-carousel-controls");
        if (!rail || !controls) return;
        const hidden = rail.scrollWidth <= rail.clientWidth + 1;
        controls.hidden = hidden;
        controls.style.display = hidden ? "none" : "";
      });
    }

    function scheduleCarouselControlSync() {
      if (!carouselMeasureFrame) {
        carouselMeasureFrame = window.requestAnimationFrame(syncCarouselControls);
      }
    }

    scheduleCarouselControlSync();
    window.addEventListener("resize", scheduleCarouselControlSync, {
      passive: true,
      signal: abortController.signal
    });
    window.addEventListener("resize", scheduleStoryPhotoBounds, {
      passive: true,
      signal: abortController.signal
    });
    function releaseWheelGestureAfterPause() {
      if (wheelGestureTimer) window.clearTimeout(wheelGestureTimer);
      wheelGestureTimer = window.setTimeout(() => {
        wheelGestureLocked = false;
        wheelGestureTimer = 0;
      }, 180);
    }

    function handleDeckWheel(event) {
      if (event.target.closest("[data-story-carousel-rail]")) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return;

      if (wheelGestureLocked) {
        event.preventDefault();
        releaseWheelGestureAfterPause();
        return;
      }

      const direction = event.deltaY > 0 ? 1 : -1;
      const currentIndex = Math.max(0, activeIndex);
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= slides.length) return;

      event.preventDefault();
      wheelGestureLocked = true;
      releaseWheelGestureAfterPause();
      track.scrollTo({
        top: slides[targetIndex].offsetTop,
        behavior: "smooth"
      });
    }

    root.addEventListener("click", (event) => {
      const control = event.target.closest("[data-story-carousel-prev], [data-story-carousel-next]");
      if (!control) return;
      const carousel = control.closest(".airshow-story-carousel");
      const rail = carousel?.querySelector("[data-story-carousel-rail]");
      if (!rail) return;
      const direction = control.hasAttribute("data-story-carousel-prev") ? -1 : 1;
      rail.scrollBy({
        left: direction * rail.clientWidth * 0.75,
        behavior: reduceMotion ? "instant" : "smooth"
      });
    }, {signal: abortController.signal});

    if (reduceMotion) {
      root.classList.add("is-reduced-motion");
      syncSceneMedia(0);
    } else {
      root.classList.add("is-mounted");
      root.addEventListener("wheel", handleDeckWheel, {
        passive: false,
        signal: abortController.signal
      });
      observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            activateSlide(slides.indexOf(entry.target));
          }
        });
      }, {root: track, threshold: 0.6});
      slides.forEach((slide) => observer.observe(slide));
      activateSlide(0);
    }
    state.airshowStoryController = {
      destroy() {
        abortController.abort();
        observer?.disconnect();
        if (wheelGestureTimer) window.clearTimeout(wheelGestureTimer);
        if (carouselMeasureFrame) window.cancelAnimationFrame(carouselMeasureFrame);
        if (photoBoundsMeasureFrame) window.cancelAnimationFrame(photoBoundsMeasureFrame);
      }
    };
  }

  function airshowPhotoGroups(photos) {
    return groupPhotoRecords(photos, (photo) => {
      if (photo.tagScope === "location" || !photo.squadronName) {
        return {
          key: `location-${photo.pinId || normalizeKey(photo.locationName || "untagged")}`,
          title: "Location-tagged frames",
          eyebrow: "Location tag",
          logo: ""
        };
      }

      const squadron = squadronForPhoto(photo);
      const name = squadron?.name || photo.squadronName;
      const unitType = squadron?.unitType || photo.unitType;
      const country = squadron?.country || photo.country || "";
      return {
        key: `unit-${normalizeKey(`${country}-${name}-${unitType || ""}`)}`,
        title: name,
        eyebrow: squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType),
        logo: squadron?.logo || ""
      };
    }, sortPhotos, reverseChronologicalGroupSorter);
  }

  function renderAirshowPhotoGroups(groups) {
    return `
      <div class="airshow-squadron-groups${groups.length === 1 ? " is-single-group" : ""}">
        ${groups.map((group, index) => {
          const logo = group.logo
            ? `<span class="airshow-squadron-logo"><img src="${escapeAttr(group.logo)}" alt="${escapeAttr(`${group.title} logo`)}"></span>`
            : "";
          return `
            <section class="airshow-squadron-group">
              <div class="airshow-squadron-heading${logo ? " has-logo" : ""}">
                ${logo}
                <div>
                  <p class="eyebrow">${escapeHtml(group.eyebrow)}</p>
                  <h3>${escapeHtml(group.title)}</h3>
                </div>
                <span class="count-pill">${group.photos.length}</span>
                </div>
              ${renderProgressivePhotoGrid(group.photos, "airshow", `airshow-${index}-${group.key}`, "airshow-photo-grid")}
            </section>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderAirshowIdentityMarks(photos) {
    const { families, units } = collectPhotoIdentities(photos);
    return renderPhotoIdentityMarks(families, units, {
      wrapperClass: "airshow-identity-marks",
      familyClass: "airshow-identity-mark is-family",
      unitClass: "airshow-identity-mark is-squadron",
      familyIcon: (family) => family.darkIcon || family.mapIcon || family.icon,
      familyLimit: 3,
      unitLimit: 6
    });
  }
