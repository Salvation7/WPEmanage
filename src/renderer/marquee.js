function createMarquee({ collection, grid, box, canStart, getSelection, applySelection, finishSelection }) {
  const dragThreshold = 5;
  const scrollEdge = 36;
  const maxScrollSpeed = 880;
  let gesture = null;
  let frame = 0;
  let suppressClick = false;

  function viewport() {
    const bounds = collection.getBoundingClientRect();
    const left = bounds.left + collection.clientLeft;
    const top = bounds.top + collection.clientTop;
    return { left, top, right: left + collection.clientWidth, bottom: top + collection.clientHeight };
  }

  function updateSelection(next) {
    const previous = gesture.selection;
    if (next.size === previous.size && [...next].every(id => previous.has(id))) return;
    gesture.selection = next;
    applySelection(new Set(next));
  }

  function draw() {
    const bounds = viewport();
    // Keep the origin anchored to the scrollable content while the viewport moves.
    const originX = bounds.left + gesture.anchorX - collection.scrollLeft;
    const originY = bounds.top + gesture.anchorY - collection.scrollTop;
    const x = Math.max(bounds.left, Math.min(bounds.right, gesture.x));
    const y = Math.max(bounds.top, Math.min(bounds.bottom, gesture.y));
    const left = Math.min(originX, x);
    const top = Math.min(originY, y);
    const right = Math.max(originX, x);
    const bottom = Math.max(originY, y);
    const hits = new Set();
    for (const card of grid.querySelectorAll('.project[data-id]')) {
      const rect = card.getBoundingClientRect();
      if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) hits.add(card.dataset.id);
    }

    const clippedLeft = Math.max(left, bounds.left);
    const clippedTop = Math.max(top, bounds.top);
    box.style.left = `${clippedLeft}px`;
    box.style.top = `${clippedTop}px`;
    box.style.width = `${Math.min(right, bounds.right) - clippedLeft}px`;
    box.style.height = `${Math.min(bottom, bounds.bottom) - clippedTop}px`;
    box.hidden = false;

    gesture.hits = hits;
    if (gesture.mode === 'replace') {
      updateSelection(hits);
      return;
    }
    const next = new Set(gesture.initial);
    for (const id of hits) {
      if (gesture.mode === 'toggle' && gesture.initial.has(id)) next.delete(id);
      else next.add(id);
    }
    updateSelection(next);
  }

  function scheduleFrame() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function stopFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function tick(time) {
    frame = 0;
    if (!gesture?.dragging || gesture.cancelled) return;
    const bounds = viewport();
    const upper = Math.max(0, bounds.top + scrollEdge - gesture.y);
    const lower = Math.max(0, gesture.y - (bounds.bottom - scrollEdge));
    const direction = Math.max(-1, Math.min(1, (lower - upper) / scrollEdge));
    const before = collection.scrollTop;
    const elapsed = gesture.frameTime ? Math.max(8, Math.min(32, time - gesture.frameTime)) : 16;
    gesture.frameTime = time;
    if (direction) {
      const distance = Math.max(1, Math.round(Math.abs(direction) * maxScrollSpeed * elapsed / 1000));
      collection.scrollTop += Math.sign(direction) * distance;
    }
    draw();
    if (collection.scrollTop !== before) scheduleFrame();
  }

  function cancel() {
    if (!gesture?.dragging || gesture.cancelled) {
      if (gesture && !gesture.cancelled) gesture = null;
      return;
    }
    gesture.cancelled = true;
    stopFrame();
    box.hidden = true;
    updateSelection(gesture.initial);
  }

  function release() {
    const pointerId = gesture.id;
    gesture = null;
    stopFrame();
    box.hidden = true;
    if (collection.hasPointerCapture(pointerId)) collection.releasePointerCapture(pointerId);
  }

  function finish(event) {
    const dragged = gesture.dragging;
    const completed = dragged && !gesture.cancelled;
    if (completed) {
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      draw();
    }
    const hits = gesture.hits;
    release();
    if (dragged) suppressClick = true;
    if (completed) finishSelection(hits);
  }

  collection.addEventListener('pointerdown', event => {
    if (gesture || !event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0 || !canStart(event)) return;
    if (event.target.closest('.project-check, input, select, textarea, a, button:not(.project-open)')) return;
    const bounds = viewport();
    const { clientX: x, clientY: y } = event;
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return;
    const initial = new Set(getSelection());
    gesture = {
      id: event.pointerId,
      startX: x,
      startY: y,
      anchorX: x - bounds.left + collection.scrollLeft,
      anchorY: y - bounds.top + collection.scrollTop,
      x,
      y,
      initial,
      selection: initial,
      mode: event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'extend' : 'replace'
    };
  });

  collection.addEventListener('dragstart', event => {
    if (event.target.closest('.project')) event.preventDefault();
  });
  collection.addEventListener('scroll', () => {
    if (gesture?.dragging && !gesture.cancelled) scheduleFrame();
  }, { passive: true });

  document.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    // A chorded mouse can release the left button before dispatching pointerup.
    if (!(event.buttons & 1)) {
      finish(event);
      return;
    }
    if (gesture.cancelled) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (!gesture.dragging) {
      if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < dragThreshold) return;
      gesture.dragging = true;
      collection.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    scheduleFrame();
  }, true);

  document.addEventListener('pointerup', event => {
    if (gesture?.id === event.pointerId && !(event.buttons & 1)) finish(event);
  }, true);

  document.addEventListener('pointercancel', event => {
    if (gesture?.id !== event.pointerId) return;
    if (gesture.dragging) {
      cancel();
      release();
    } else {
      gesture = null;
    }
  }, true);

  collection.addEventListener('lostpointercapture', event => {
    if (gesture?.id === event.pointerId) cancel();
  });
  window.addEventListener('blur', () => {
    cancel();
    if (gesture) {
      suppressClick = true;
      release();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !gesture?.dragging) return;
    event.preventDefault();
    cancel();
  }, true);

  document.addEventListener('pointerdown', () => { suppressClick = false; }, true);
  document.addEventListener('click', event => {
    if (!suppressClick || !event.detail || event.button !== 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  return { cancel };
}
