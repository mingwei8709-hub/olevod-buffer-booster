// ==UserScript==
// @name         欧乐影院 HLS 缓冲增强
// @namespace    https://github.com/mingwei8709-hub/olevod-buffer-booster
// @version      2.4.0
// @description  三路预载 HLS 分片，并通过内存缓存减少播放器重复下载。
// @match        https://www.olevod.com/player/*
// @homepageURL  https://github.com/mingwei8709-hub/olevod-buffer-booster
// @supportURL   https://github.com/mingwei8709-hub/olevod-buffer-booster/issues
// @downloadURL  https://raw.githubusercontent.com/mingwei8709-hub/olevod-buffer-booster/main/olevod-buffer-booster.user.js
// @updateURL    https://raw.githubusercontent.com/mingwei8709-hub/olevod-buffer-booster/main/olevod-buffer-booster.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const targetBufferSeconds = 180;
  const targetBufferBytes = 300000000;
  const prefetchConcurrency = 3;
  const prefetchLookahead = 18;
  const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const status = {
    defaultsPatched: false,
    instancePatched: false,
    forwardBufferSeconds: 0,
    targetBufferSeconds,
    prefetchActive: 0,
    prefetchCompleted: 0,
    prefetchFailed: 0,
    prefetchMessage: 'Waiting for a segment URL',
    manifestSegments: 0,
    pageChanges: 0,
    stalePrefetchCanceled: 0,
    currentSegment: '-',
    activeSegments: [],
    cachedSegments: [],
    cacheHits: 0,
    cacheBytes: 0,
    loaderPatched: false,
  };

  const prefetchState = {
    latestSegment: null,
    latestObservedUrl: null,
    playlistSegments: [],
    playlistTimeline: [],
    manifestUrls: new Set(),
    knownUrls: new Set(),
    ownUrls: new Set(),
    completedUrls: new Set(),
    activeRequests: new Map(),
    mediaCache: new Map(),
    cacheBytes: 0,
    videoReadyAfter: 0,
    generation: 0,
    pageUrl: pageWindow.location.href,
    resourceCutoff: 0,
  };

  pageWindow.__olevodBufferBooster = status;

  function patchConfig(config) {
    if (!config || typeof config !== 'object') return false;
    if (
      typeof config.maxBufferLength !== 'number' ||
      typeof config.maxMaxBufferLength !== 'number' ||
      typeof config.maxBufferSize !== 'number'
    ) {
      return false;
    }

    config.maxBufferLength = targetBufferSeconds;
    config.maxMaxBufferLength = Math.max(600, targetBufferSeconds);
    config.maxBufferSize = targetBufferBytes;

    for (const loaderKey of ['loader', 'fLoader']) {
      const OriginalLoader = config[loaderKey];
      if (
        typeof OriginalLoader === 'function' &&
        !OriginalLoader.__olevodPrefetchAware
      ) {
        config[loaderKey] = createPrefetchAwareLoader(OriginalLoader);
        status.loaderPatched = true;
      }
    }
    return true;
  }

  function createLoadStats() {
    return {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
  }

  function takeCachedSegment(rawUrl, context) {
    const url = canonicalUrl(rawUrl);
    const cached = prefetchState.mediaCache.get(url);
    if (!cached) return null;

    prefetchState.mediaCache.delete(url);
    prefetchState.completedUrls.delete(url);
    prefetchState.cacheBytes = Math.max(0, prefetchState.cacheBytes - cached.data.byteLength);
    status.cacheBytes = prefetchState.cacheBytes;
    syncCacheStatus();

    let data = cached.data;
    if (context && context.rangeEnd) {
      data = data.slice(context.rangeStart || 0, context.rangeEnd);
    }
    return { data, loadingMs: cached.loadingMs };
  }

  function createPrefetchAwareLoader(OriginalLoader) {
    class PrefetchAwareLoader {
      constructor(loaderConfig) {
        this.loaderConfig = loaderConfig;
        this.delegate = null;
        this.context = null;
        this.callbacks = null;
        this.stats = createLoadStats();
        this.aborted = false;
      }

      load(context, config, callbacks) {
        this.context = context;
        this.callbacks = callbacks;
        this.stats.loading.start = pageWindow.performance.now();

        const url = canonicalUrl(context.url);
        const cached = takeCachedSegment(url, context);
        if (cached) {
          this.deliver(cached);
          return;
        }

        const pending = prefetchState.activeRequests.get(url);
        if (pending) {
          pending.promise.then(() => {
            if (this.aborted) return;
            const completed = takeCachedSegment(url, context);
            if (completed) {
              this.deliver(completed);
            } else {
              this.loadNormally(context, config, callbacks);
            }
          });
          return;
        }

        this.loadNormally(context, config, callbacks);
      }

      loadNormally(context, config, callbacks) {
        if (this.aborted) return;
        this.delegate = new OriginalLoader(this.loaderConfig);
        this.delegate.load(context, config, callbacks);
        this.stats = this.delegate.stats;
      }

      deliver(cached) {
        if (this.aborted || !this.callbacks) return;

        const now = pageWindow.performance.now();
        const loadingMs = Math.max(1, cached.loadingMs || 1);
        const data = cached.data;
        this.stats.loading.start = now - loadingMs;
        this.stats.loading.first = this.stats.loading.start;
        this.stats.loading.end = now;
        this.stats.loaded = data.byteLength;
        this.stats.total = data.byteLength;
        this.stats.chunkCount = 1;
        this.stats.bwEstimate = 8000 * data.byteLength / loadingMs;
        status.cacheHits += 1;

        const response = {
          url: this.context.url,
          data,
          code: 200,
        };
        if (this.callbacks.onProgress) {
          this.callbacks.onProgress(this.stats, this.context, data, null);
        }
        if (this.callbacks) {
          this.callbacks.onSuccess(response, this.stats, this.context, null);
        }
      }

      abort() {
        this.aborted = true;
        if (this.delegate) {
          this.delegate.abort();
        } else {
          this.stats.aborted = true;
          if (this.callbacks && this.callbacks.onAbort) {
            this.callbacks.onAbort(this.stats, this.context, null);
          }
        }
      }

      destroy() {
        this.aborted = true;
        if (this.delegate) this.delegate.destroy();
        this.delegate = null;
        this.context = null;
        this.callbacks = null;
      }

      getCacheAge() {
        return this.delegate && this.delegate.getCacheAge
          ? this.delegate.getCacheAge()
          : null;
      }

      getResponseHeader(name) {
        return this.delegate && this.delegate.getResponseHeader
          ? this.delegate.getResponseHeader(name)
          : null;
      }
    }

    PrefetchAwareLoader.__olevodPrefetchAware = true;
    return PrefetchAwareLoader;
  }

  function patchHlsClass(Hls) {
    try {
      if (Hls && Hls.DefaultConfig && patchConfig(Hls.DefaultConfig)) {
        Hls.DefaultConfig = Hls.DefaultConfig;
        const firstPatch = !status.defaultsPatched;
        status.defaultsPatched = true;
        if (firstPatch) {
          console.info('[Olevod Buffer] Hls.DefaultConfig patched.');
        }
        return true;
      }
    } catch (error) {
      console.warn('[Olevod Buffer] Failed to patch Hls.DefaultConfig:', error);
    }
    return false;
  }

  function installHlsHook() {
    if (patchHlsClass(pageWindow.Hls)) return;

    const descriptor = Object.getOwnPropertyDescriptor(pageWindow, 'Hls');
    if (descriptor && descriptor.configurable === false) return;

    let hlsValue;
    Object.defineProperty(pageWindow, 'Hls', {
      configurable: true,
      enumerable: true,
      get() {
        return hlsValue;
      },
      set(value) {
        hlsValue = value;
        patchHlsClass(value);
        Object.defineProperty(pageWindow, 'Hls', {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
    });
  }

  installHlsHook();

  const fallbackTimer = pageWindow.setInterval(() => {
    if (patchHlsClass(pageWindow.Hls)) {
      status.defaultsPatched = true;
      pageWindow.clearInterval(fallbackTimer);
    }
  }, 100);

  function looksLikeHlsInstance(value) {
    return (
      value &&
      typeof value === 'object' &&
      value.config &&
      typeof value.loadSource === 'function' &&
      typeof value.startLoad === 'function' &&
      typeof value.attachMedia === 'function'
    );
  }

  function collectVueRoots() {
    const roots = [];
    const elements = [document.querySelector('#app'), document.querySelector('video')].filter(Boolean);
    const video = document.querySelector('video');

    for (let element = video ? video.parentElement : null; element; element = element.parentElement) {
      elements.push(element);
    }

    for (const element of elements) {
      for (const key of Reflect.ownKeys(element)) {
        if (String(key).startsWith('__vue')) {
          try {
            roots.push(element[key]);
          } catch (error) {}
        }
      }
    }

    const appElement = document.querySelector('#app');
    const appInstance = appElement && appElement.__vue_app__
      ? appElement.__vue_app__._instance
      : null;
    if (appInstance) roots.push(appInstance);
    return roots.filter(Boolean);
  }

  function findAndPatchHlsInstance() {
    const queue = collectVueRoots().map((value) => ({ value, depth: 0 }));
    const seen = new WeakSet();
    let inspected = 0;

    while (queue.length && inspected < 20000) {
      const { value, depth } = queue.shift();
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      inspected += 1;

      if (looksLikeHlsInstance(value) && patchConfig(value.config)) {
        status.instancePatched = true;
        return true;
      }

      if (depth >= 8 || value instanceof pageWindow.Node) continue;

      let keys;
      try {
        keys = Reflect.ownKeys(value).slice(0, 300);
      } catch (error) {
        continue;
      }

      for (const key of keys) {
        let child;
        try {
          child = value[key];
        } catch (error) {
          continue;
        }
        if (child && (typeof child === 'object' || typeof child === 'function')) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }

    return false;
  }

  function parseSegmentUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, pageWindow.location.href);
      const match = url.pathname.match(/^(.*\/seg-)(\d+)(-[^/]+\.ts)$/i);
      if (!match) return null;

      return {
        number: Number(match[2]),
        sourceKey: `${url.origin}${match[1]}|${match[3]}|${url.search}`,
        build(segmentNumber) {
          const nextUrl = new URL(url.href);
          nextUrl.pathname = `${match[1]}${segmentNumber}${match[3]}`;
          return nextUrl.href;
        },
      };
    } catch (error) {
      return null;
    }
  }

  function canonicalUrl(rawUrl) {
    try {
      return new URL(rawUrl, pageWindow.location.href).href;
    } catch (error) {
      return rawUrl;
    }
  }

  function isManifestUrl(rawUrl) {
    try {
      return /\.m3u8$/i.test(new URL(rawUrl, pageWindow.location.href).pathname);
    } catch (error) {
      return false;
    }
  }

  function isMediaSegmentUrl(rawUrl) {
    try {
      return /\.(?:ts|m4s|aac)$/i.test(new URL(rawUrl, pageWindow.location.href).pathname);
    } catch (error) {
      return false;
    }
  }

  async function loadMediaPlaylist(rawUrl) {
    const generation = prefetchState.generation;
    const manifestUrl = canonicalUrl(rawUrl);
    if (prefetchState.manifestUrls.has(manifestUrl)) return;
    prefetchState.manifestUrls.add(manifestUrl);

    try {
      const response = await pageWindow.fetch(manifestUrl, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (generation !== prefetchState.generation) return;
      if (!response.ok) return;

      const text = await response.text();
      if (generation !== prefetchState.generation) return;
      const timeline = [];
      let pendingDuration = 0;
      let startTime = 0;

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
          pendingDuration = Number.parseFloat(line.slice(8)) || 0;
          continue;
        }

        if (line.startsWith('#')) continue;
        const url = canonicalUrl(new URL(line, manifestUrl).href);
        if (!isMediaSegmentUrl(url)) continue;

        timeline.push({
          url,
          start: startTime,
          duration: pendingDuration,
        });
        startTime += pendingDuration;
        pendingDuration = 0;
      }

      const segments = timeline.map((item) => item.url);

      if (segments.length) {
        prefetchState.playlistSegments = segments;
        prefetchState.playlistTimeline = timeline;
        status.manifestSegments = segments.length;
        status.prefetchMessage = `Loaded M3U8 playlist: ${segments.length} segments`;
      }
    } catch (error) {
      status.prefetchMessage = `Playlist failed; using filename fallback: ${error && error.message ? error.message : 'unknown error'}`;
    }
  }

  function recordResource(entry) {
    if (
      Number.isFinite(entry.startTime) &&
      entry.startTime < prefetchState.resourceCutoff
    ) {
      return;
    }

    const entryUrl = canonicalUrl(entry.name);
    if (isManifestUrl(entryUrl)) {
      void loadMediaPlaylist(entryUrl);
      return;
    }

    if (!isMediaSegmentUrl(entryUrl)) return;
    const segment = parseSegmentUrl(entryUrl);

    prefetchState.knownUrls.add(entryUrl);
    if (prefetchState.ownUrls.has(entryUrl) && entry.initiatorType === 'fetch') return;

    prefetchState.latestObservedUrl = entryUrl;
    if (segment) prefetchState.latestSegment = segment;
    status.prefetchMessage = 'Segment URL detected';
  }

  function observeSegmentRequests() {
    for (const entry of pageWindow.performance.getEntriesByType('resource')) {
      recordResource(entry);
    }

    if (!pageWindow.PerformanceObserver) return;
    const observer = new pageWindow.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordResource(entry);
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  }

  async function prefetchSegment(url) {
    const generation = prefetchState.generation;
    const controller = new pageWindow.AbortController();
    let resolveRequest;
    const request = {
      controller,
      promise: new Promise((resolve) => {
        resolveRequest = resolve;
      }),
      resolve: null,
    };
    request.resolve = resolveRequest;
    prefetchState.activeRequests.set(url, request);
    prefetchState.ownUrls.add(url);
    syncActiveStatus();

    try {
      const loadingStart = pageWindow.performance.now();
      const response = await pageWindow.fetch(url, {
        cache: 'no-store',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.arrayBuffer();
      if (generation !== prefetchState.generation) return;
      const loadingMs = Math.max(1, pageWindow.performance.now() - loadingStart);

      const previous = prefetchState.mediaCache.get(url);
      if (previous) {
        prefetchState.cacheBytes -= previous.data.byteLength;
      }
      prefetchState.mediaCache.set(url, { data, loadingMs });
      prefetchState.cacheBytes += data.byteLength;
      status.cacheBytes = prefetchState.cacheBytes;
      syncCacheStatus();
      prefetchState.completedUrls.add(url);
      status.prefetchCompleted = prefetchState.completedUrls.size;
      status.prefetchMessage = 'Three-way memory prefetch active';
      request.resolve(data);
    } catch (error) {
      request.resolve(null);
      if (generation === prefetchState.generation && (!error || error.name !== 'AbortError')) {
        status.prefetchFailed += 1;
        status.prefetchMessage = `Prefetch failed: ${error && error.message ? error.message : 'unknown error'}`;
      }
    } finally {
      if (
        generation === prefetchState.generation &&
        prefetchState.activeRequests.get(url) === request
      ) {
        prefetchState.activeRequests.delete(url);
        syncActiveStatus();
      }
    }
  }

  function segmentLabel(rawUrl) {
    try {
      const name = new URL(rawUrl).pathname.split('/').pop() || rawUrl;
      const match = name.match(/seg-(\d+)/i);
      return match ? match[1] : name;
    } catch (error) {
      return rawUrl;
    }
  }

  function syncActiveStatus() {
    status.prefetchActive = prefetchState.activeRequests.size;
    status.activeSegments = Array.from(prefetchState.activeRequests.keys(), segmentLabel);
  }

  function syncCacheStatus() {
    status.cachedSegments = Array.from(prefetchState.mediaCache.keys(), segmentLabel);
    status.cacheBytes = prefetchState.cacheBytes;
  }

  function clearMemoryCache() {
    prefetchState.mediaCache.clear();
    prefetchState.completedUrls.clear();
    prefetchState.cacheBytes = 0;
    syncCacheStatus();
  }

  function cancelActivePrefetches(message) {
    for (const request of prefetchState.activeRequests.values()) {
      request.controller.abort();
      request.resolve(null);
    }
    prefetchState.activeRequests.clear();
    syncActiveStatus();
    status.prefetchMessage = message;
  }

  function resetPrefetchState(message) {
    prefetchState.generation += 1;
    cancelActivePrefetches(message);
    prefetchState.latestSegment = null;
    prefetchState.latestObservedUrl = null;
    prefetchState.playlistSegments = [];
    prefetchState.playlistTimeline = [];
    prefetchState.manifestUrls.clear();
    prefetchState.knownUrls.clear();
    prefetchState.ownUrls.clear();
    clearMemoryCache();
    prefetchState.resourceCutoff = pageWindow.performance.now() - 500;
    prefetchState.videoReadyAfter = pageWindow.performance.now() + 1500;
    status.prefetchCompleted = 0;
    status.prefetchFailed = 0;
    status.manifestSegments = 0;
    status.stalePrefetchCanceled = 0;
    status.currentSegment = '-';
    status.cacheHits = 0;
    pageWindow.setTimeout(() => {
      for (const entry of pageWindow.performance.getEntriesByType('resource')) {
        recordResource(entry);
      }
    }, 250);
  }

  function checkPlaybackContext() {
    const currentPageUrl = pageWindow.location.href;
    if (currentPageUrl !== prefetchState.pageUrl) {
      prefetchState.pageUrl = currentPageUrl;
      status.pageChanges += 1;
      resetPrefetchState('Video changed; previous prefetch stopped and cleared');
    }
  }

  function findTimelineIndex(currentTime) {
    const timeline = prefetchState.playlistTimeline;
    if (!timeline.length || !Number.isFinite(currentTime)) return -1;

    return timeline.findIndex((item, index) => {
      const end = item.duration > 0
        ? item.start + item.duration
        : timeline[index + 1]
          ? timeline[index + 1].start
          : Number.POSITIVE_INFINITY;
      return currentTime >= item.start && currentTime < end;
    });
  }

  function findPlaylistUrlIndex(rawUrl) {
    const playlist = prefetchState.playlistSegments;
    let index = playlist.indexOf(rawUrl);
    if (index >= 0) return index;

    try {
      const path = new URL(rawUrl).pathname;
      index = playlist.findIndex((url) => new URL(url).pathname === path);
    } catch (error) {}
    return index;
  }

  function cancelStalePrefetches(currentIndex) {
    if (currentIndex < 0) return;

    for (const [url, request] of prefetchState.activeRequests) {
      const requestIndex = findPlaylistUrlIndex(url);
      if (requestIndex >= 0 && requestIndex <= currentIndex) {
        request.controller.abort();
        request.resolve(null);
        prefetchState.activeRequests.delete(url);
        status.stalePrefetchCanceled += 1;
      }
    }

    for (const [url, cached] of prefetchState.mediaCache) {
      const cachedIndex = findPlaylistUrlIndex(url);
      if (cachedIndex >= 0 && cachedIndex <= currentIndex) {
        prefetchState.mediaCache.delete(url);
        prefetchState.completedUrls.delete(url);
        prefetchState.cacheBytes = Math.max(0, prefetchState.cacheBytes - cached.data.byteLength);
      }
    }
    syncActiveStatus();
    syncCacheStatus();
  }

  function pumpPrefetch(video) {
    if (!video) return;
    if (pageWindow.performance.now() < prefetchState.videoReadyAfter) return;

    const base = prefetchState.latestSegment;
    const currentUrl = prefetchState.latestObservedUrl;
    const playlist = prefetchState.playlistSegments;
    const candidateUrls = [];
    const timelineIndex = findTimelineIndex(video.currentTime);

    if (timelineIndex >= 0) {
      status.currentSegment = segmentLabel(playlist[timelineIndex]);
      cancelStalePrefetches(timelineIndex);
      candidateUrls.push(...playlist.slice(timelineIndex + 1, timelineIndex + 1 + prefetchLookahead));
    } else if (currentUrl && playlist.length) {
      const currentIndex = findPlaylistUrlIndex(currentUrl);

      if (currentIndex >= 0) {
        status.currentSegment = segmentLabel(playlist[currentIndex]);
        cancelStalePrefetches(currentIndex);
        candidateUrls.push(...playlist.slice(currentIndex + 1, currentIndex + 1 + prefetchLookahead));
      }
    }

    if (!candidateUrls.length && base) {
      for (let offset = 1; offset <= prefetchLookahead; offset += 1) {
        candidateUrls.push(base.build(base.number + offset));
      }
    }

    if (!candidateUrls.length) {
      status.prefetchMessage = 'Waiting for a playlist or recognizable segment order';
      return;
    }

    for (const rawUrl of candidateUrls) {
      if (prefetchState.activeRequests.size >= prefetchConcurrency) break;
      const url = canonicalUrl(rawUrl);
      if (
        prefetchState.knownUrls.has(url) ||
        prefetchState.completedUrls.has(url) ||
        prefetchState.activeRequests.has(url)
      ) {
        continue;
      }

      void prefetchSegment(url);
    }
  }

  function ensureVideoListeners(video) {
    if (!video || video.dataset.olevodBufferBoosterBound === '1') return;
    video.dataset.olevodBufferBoosterBound = '1';
    prefetchState.videoReadyAfter = pageWindow.performance.now() + 3000;

    video.addEventListener('seeking', () => {
      cancelActivePrefetches('Seek detected; old-position prefetch canceled');
      clearMemoryCache();
      prefetchState.knownUrls.clear();
      prefetchState.ownUrls.clear();
      prefetchState.resourceCutoff = pageWindow.performance.now();
      prefetchState.latestSegment = null;
      prefetchState.latestObservedUrl = null;
      prefetchState.videoReadyAfter = pageWindow.performance.now() + 500;
    });

    video.addEventListener('loadedmetadata', () => {
      prefetchState.videoReadyAfter = pageWindow.performance.now() + 1500;
    });
  }

  function getForwardBufferSeconds(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;
    const currentTime = video.currentTime;

    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (currentTime >= start - 0.25 && currentTime <= end + 0.25) {
        return Math.max(0, end - currentTime);
      }
    }

    return 0;
  }

  function ensureBadge() {
    let badge = document.getElementById('olevod-buffer-booster-status');
    if (badge) return badge;

    badge = document.createElement('div');
    badge.id = 'olevod-buffer-booster-status';
    Object.assign(badge.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: '2147483647',
      padding: '7px 10px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.78)',
      color: '#ffd166',
      font: '12px/1.4 sans-serif',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(badge);
    return badge;
  }

  function updateStatus() {
    const video = document.querySelector('video');
    checkPlaybackContext();
    status.forwardBufferSeconds = getForwardBufferSeconds(video);

    ensureVideoListeners(video);
    pumpPrefetch(video);

    if (!status.defaultsPatched && !status.instancePatched) {
      findAndPatchHlsInstance();
    }

    const configured = status.defaultsPatched || status.instancePatched;
    const badge = ensureBadge();
    badge.style.color = configured ? '#7CFC98' : '#ffd166';
    const cachedPreview = status.cachedSegments.length
      ? `${status.cachedSegments.slice(0, 6).join(',')}${status.cachedSegments.length > 6 ? ',...' : ''}`
      : '-';
    const prefetchText = status.prefetchFailed
      ? ` | failed ${status.prefetchFailed} (hover for details)`
      : ` | current ${status.currentSegment} | prefetch ${status.prefetchActive}/${prefetchConcurrency} [${status.activeSegments.join(',') || '-'}] | memory ${status.cachedSegments.length} [${cachedPreview}] | hits ${status.cacheHits}`;
    badge.textContent = configured
      ? `Olevod buffer: active | ahead ${status.forwardBufferSeconds.toFixed(0)}s / ${targetBufferSeconds}s${prefetchText}`
      : `Olevod buffer: waiting | ahead ${status.forwardBufferSeconds.toFixed(0)}s`;
    badge.title = `${status.prefetchMessage}; loader patched ${status.loaderPatched}; memory ${(status.cacheBytes / 1048576).toFixed(1)} MB; stale requests canceled ${status.stalePrefetchCanceled}`;
  }

  observeSegmentRequests();
  pageWindow.setInterval(updateStatus, 500);
  pageWindow.setTimeout(() => pageWindow.clearInterval(fallbackTimer), 30000);
})();




