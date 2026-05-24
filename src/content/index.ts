import {ChromeMessageType, ChromeMessage} from '../background/interfaces';

const DEBOUNCE_TIMEOUT = 1000;
const APP_SYNC_TIMEOUT = 150;

const PLAYER_ROOT_SELECTOR = [
  'section[class*="PlayerBarDesktopWithBackgroundProgressBar_root"]',
  '.player-controls',
].join(', ');

type TrackMeta = {
  title?: string;
  album?: string;
  artist?: string;
};

type ResolvedTrackPayload = {
  available: boolean;
  downloadInfo: {
    codec: string;
    bitrateInKbps: number;
    downloadInfoUrl: string;
    direct: boolean;
    gain: boolean;
    preview: boolean;
  };
};

const locale = (() => {
  const domains = window.location.host.split('.');
  return domains[domains.length - 1];
})();

const OAUTH_REDIRECT_URI = `${window.location.origin}/oauth`;

const PAGE_REQUEST_SOURCE = 'YMD_CONTENT';
const PAGE_RESPONSE_SOURCE = 'YMD_PAGE';

const FETCH_TRACK_DATA = 'FETCH_TRACK_DATA';

const FETCH_TRACK_DATA_RESULT = 'FETCH_TRACK_DATA_RESULT';

let oauthTokenCache = '';
let oauthClientIdCache = '';

let lastErrorMessage = '';

let pendingDownloadAction: (() => void) | null = null;

let port: chrome.runtime.Port | null = null;

/**
 * STORAGE
 */

chrome.storage.local.get(['oauthToken', 'oauthClientId'], localItems => {
  oauthTokenCache = localItems.oauthToken ?? '';

  oauthClientIdCache = localItems.oauthClientId ?? '';

  chrome.storage.sync.get(['oauthToken', 'oauthClientId'], syncItems => {
    if (!oauthTokenCache) {
      oauthTokenCache = syncItems.oauthToken ?? '';
    }

    if (!oauthClientIdCache) {
      oauthClientIdCache = syncItems.oauthClientId ?? '';
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!['local', 'sync'].includes(areaName)) {
    return;
  }

  if (changes.oauthToken) {
    oauthTokenCache = changes.oauthToken.newValue ?? '';
  }

  if (changes.oauthClientId) {
    oauthClientIdCache = changes.oauthClientId.newValue ?? '';
  }

  if (oauthTokenCache && pendingDownloadAction) {
    const action = pendingDownloadAction;

    pendingDownloadAction = null;

    window.setTimeout(() => {
      action();
    }, 500);
  }
});

/**
 * HELPERS
 */

const showDownloadError = (message: string) => {
  if (!message) return;

  if (lastErrorMessage === message) return;

  lastErrorMessage = message;

  window.alert(`Ошибка загрузки: ${message}`);

  window.setTimeout(() => {
    if (lastErrorMessage === message) {
      lastErrorMessage = '';
    }
  }, 1500);
};

const showInfo = (message: string) => {
  if (!message) return;

  if (window.location.pathname === '/oauth') {
    window.alert('После авторизации вернитесь в Яндекс Музыку.');

    return;
  }

  window.alert(message);
};

/**
 * CLIENT ID
 */

const saveClientId = async (clientId: string) => {
  oauthClientIdCache = clientId;

  await chrome.storage.local.set({
    oauthClientId: clientId,
  });

  await chrome.storage.sync.set({
    oauthClientId: clientId,
  });
};

const extractClientId = (): string | null => {
  const scripts = Array.from(document.scripts);

  const patterns = [
    /client_id["']?\s*:\s*["']([a-zA-Z0-9]+)["']/i,
    /clientId["']?\s*:\s*["']([a-zA-Z0-9]+)["']/i,
    /"client_id":"([a-zA-Z0-9]+)"/i,
    /"clientId":"([a-zA-Z0-9]+)"/i,
  ];

  for (const script of scripts) {
    const content = script.textContent || '';

    for (const pattern of patterns) {
      const match = content.match(pattern);

      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
};

const resolveOauthClientId = async (): Promise<string> => {
  if (oauthClientIdCache) {
    return oauthClientIdCache;
  }

  let clientId = extractClientId();

  if (!clientId) {
    clientId = '97fe03033fa34407ac9bcf91d5afed5b';
  }

  await saveClientId(clientId);

  return clientId;
};

/**
 * PORT
 */

const handlePortMessage = (message: ChromeMessage) => {
  if (message.type === ChromeMessageType.ERROR_EVENT) {
    showDownloadError(message.error.message || 'Неизвестная ошибка');

    return;
  }

  if (message.type === ChromeMessageType.DOWNLOAD_ERROR_EVENT) {
    showDownloadError(message.error.message || 'Ошибка скачивания');
  }
};

const getPort = () => {
  if (port) return port;

  port = chrome.runtime.connect({
    name: locale,
  });

  port.onMessage.addListener(handlePortMessage);

  port.onDisconnect.addListener(() => {
    port = null;
  });

  port.postMessage({
    type: ChromeMessageType.ADD_ERROR_LISTENER,
  });

  return port;
};

const postToPort = (message: ChromeMessage) => {
  try {
    getPort().postMessage(message);
  } catch (_error) {
    port = null;

    getPort().postMessage(message);
  }
};

/**
 * PAGE BRIDGE
 */

const injectPageBridge = () => {
  if (document.querySelector('script[data-ymd-page-bridge="1"]')) {
    return;
  }

  const script = document.createElement('script');

  script.src = chrome.runtime.getURL('page-bridge.js');

  script.dataset.ymdPageBridge = '1';

  script.onload = () => {
    script.remove();
  };

  (document.head || document.documentElement).append(script);
};

const requestPageTrackData = (trackId: number, oauthToken: string) => {
  injectPageBridge();

  const requestId = `ymd-${trackId}-${Date.now()}`;

  return new Promise<ResolvedTrackPayload>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);

      reject(new Error('Track fetch timeout'));
    }, 10000);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;

      const data = event.data;

      if (!data || data.source !== PAGE_RESPONSE_SOURCE) {
        return;
      }

      if (data.type !== FETCH_TRACK_DATA_RESULT) {
        return;
      }

      if (data.requestId !== requestId) {
        return;
      }

      window.clearTimeout(timeoutId);

      window.removeEventListener('message', onMessage);

      if (data.error) {
        reject(new Error(String(data.error)));

        return;
      }

      resolve(data.payload as ResolvedTrackPayload);
    };

    window.addEventListener('message', onMessage);

    window.postMessage(
      {
        source: PAGE_REQUEST_SOURCE,
        type: FETCH_TRACK_DATA,
        requestId,
        trackId,
        oauthToken,
      },
      window.location.origin
    );
  });
};

/**
 * AUTH
 */

const captureOauthTokenFromHash = async () => {
  const hash = window.location.hash.replace(/^#/u, '');

  if (!hash) return;

  const params = new URLSearchParams(hash);

  const token = params.get('access_token');

  if (!token) return;

  oauthTokenCache = token;

  await chrome.storage.local.set({
    oauthToken: token,
  });

  await chrome.storage.sync.set({
    oauthToken: token,
  });

  const storage = await new Promise<{
    oauthReturnUrl?: string;
  }>(resolve => {
    chrome.storage.local.get(['oauthReturnUrl'], items => resolve(items));
  });

  const returnUrl = storage.oauthReturnUrl;

  if (returnUrl && returnUrl.includes('music.yandex')) {
    await chrome.storage.local.remove('oauthReturnUrl');

    window.location.href = returnUrl;

    return;
  }

  showInfo('Авторизация завершена.');
};

const ensureOauthToken = async (action: () => void): Promise<boolean> => {
  if (oauthTokenCache) {
    return true;
  }

  pendingDownloadAction = action;

  await chrome.storage.local.set({
    oauthReturnUrl: window.location.href,
  });

  const clientId = await resolveOauthClientId();

  const params = new URLSearchParams();

  params.set('response_type', 'token');

  params.set('client_id', clientId);

  params.set('redirect_uri', OAUTH_REDIRECT_URI);

  const oauthUrl = new URL('https://oauth.yandex.ru/authorize');
  oauthUrl.search = params.toString();

  window.location.href = oauthUrl.toString();

  return false;
};

/**
 * DOWNLOADS
 */

const requestTrackDownload = (
  trackId: number,
  trackMeta?: TrackMeta,
  resolvedTrack?: ResolvedTrackPayload
) => {
  postToPort({
    type: ChromeMessageType.DOWNLOAD_TRACK,
    trackId,
    trackMeta,
    resolvedTrack,
  });
};

const downloadTrack = (trackId: number, trackMeta?: TrackMeta) => {
  const action = () => {
    void (async () => {
      try {
        const resolvedTrack = await requestPageTrackData(
          trackId,
          oauthTokenCache
        );

        console.log('track', trackId, resolvedTrack);

        requestTrackDownload(trackId, trackMeta, resolvedTrack);
      } catch (error) {
        console.error(error);

        // fallback
        requestTrackDownload(trackId, trackMeta);
      }
    })();
  };

  void (async () => {
    if (!(await ensureOauthToken(action))) {
      return;
    }

    action();
  })();
};

void captureOauthTokenFromHash();

if (window.location.pathname === '/oauth') {
  throw new Error('OAuth redirect handled');
}

getPort();

function debounce<T extends (...args: never[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      func(...args);
    }, wait);
  };
}

const createLockedHandler = (callback: () => void) => {
  let isLocked = false;

  return (event: Event) => {
    event.preventDefault();
    event.stopPropagation();

    if (isLocked) return;

    isLocked = true;
    callback();

    window.setTimeout(() => {
      isLocked = false;
    }, DEBOUNCE_TIMEOUT);
  };
};

const isDarkTheme = () => {
  return (
    document.body.classList.contains('theme-black') ||
    document.body.classList.contains('ym-dark-theme')
  );
};

const applyThemeToIcon = (icon: Element) => {
  if (isDarkTheme()) {
    icon.classList.remove('YMD-icon-light');
    icon.classList.add('YMD-icon-dark');
    return;
  }

  icon.classList.remove('YMD-icon-dark');
  icon.classList.add('YMD-icon-light');
};

const updateAllIconsTheme = () => {
  document.querySelectorAll('.YMD-icon').forEach(applyThemeToIcon);
};

const parseTrackIdFromHref = (href: string) => {
  const match = href.match(/\/track\/(\d+)(?:[/?#]|$)/);
  return match ? +match[1] : null;
};

const getTrackMeta = (element: ParentNode, trackId: number): TrackMeta => {
  const links = element.querySelectorAll<HTMLAnchorElement>('a[href]');
  let title = '';
  let album = '';
  let artist = '';

  for (let i = 0; i < links.length; ++i) {
    const link = links[i];
    const href = link.getAttribute('href') || '';
    const text = link.textContent?.trim() || '';

    if (!text) continue;

    if (!title && parseTrackIdFromHref(href) === trackId) {
      title = text;
      continue;
    }

    if (!artist && /\/artist\/\d+/.test(href)) {
      artist = text;
      continue;
    }

    if (!album && /\/album\/\d+/.test(href)) {
      album = text;
    }
  }

  return {title, album, artist};
};

const createIcon = (className: string) => {
  const icon = document.createElement('span');
  icon.classList.add('YMD-icon', className);
  applyThemeToIcon(icon);
  return icon;
};

const createIconButton = (
  classNames: string[],
  title: string,
  onClick: () => void,
  label?: string
) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.classList.add(...classNames);
  button.addEventListener('mousedown', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', createLockedHandler(onClick));
  button.append(createIcon('YMD-button-icon'));

  if (label) {
    const text = document.createElement('span');
    text.classList.add('YMD-button-label');
    text.textContent = label;
    button.append(text);
  }

  return button;
};

const createTrackActionButton = (trackId: number, trackMeta?: TrackMeta) => {
  const button = createIconButton(
    ['YMD-track-action-button'],
    'Скачать трек',
    () => downloadTrack(trackId, trackMeta)
  );

  button.dataset.ymdTrackId = String(trackId);

  button.setAttribute('aria-label', 'Скачать трек');

  return button;
};

const isSupportedTrackLink = (link: HTMLAnchorElement) => {
  const href = link.getAttribute('href');
  if (!href || !parseTrackIdFromHref(href)) return false;
  if (!link.textContent?.trim()) return false;
  if (link.closest('.YMD-inline-button')) return false;
  if (link.closest(PLAYER_ROOT_SELECTOR)) return false;
  return !link.closest('button,[role="button"]');
};

const addInlineTrackButtons = () => {
  const links =
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/track/"]');

  links.forEach(link => {
    if (!isSupportedTrackLink(link)) return;
    if (link.nextElementSibling?.classList.contains('YMD-inline-button'))
      return;

    const href = link.getAttribute('href');
    if (!href) return;

    const trackId = parseTrackIdFromHref(href);
    if (!trackId) return;
    const trackMeta = getTrackMeta(link.parentElement || document, trackId);

    const button = createIconButton(['YMD-inline-button'], 'Скачать трек', () =>
      downloadTrack(trackId, trackMeta)
    );

    button.dataset.ymdTrackId = String(trackId);
    link.insertAdjacentElement('afterend', button);
  });
};

const findTrackControlsBar = (trackRow: Element) => {
  return (
    trackRow.querySelector('[class*="CommonControlsBar_root__"]') ||
    trackRow.querySelector('[class*="CommonControlsBar_controls__"]') ||
    trackRow.querySelector('[class*="TrackPlaylist_controlsBarCell__"]')
  );
};

const addTrackRowButtons = () => {
  const links =
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/track/"]');

  links.forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    const trackId = parseTrackIdFromHref(href);
    if (!trackId) return;

    const trackRow =
      link.closest('[class*="TrackPlaylist_trackWithDots__"]') ||
      link.closest('[class*="CommonTrack_root__"]') ||
      link.closest('[class*="PlaylistPageDnDItemWrapper_root__"]') ||
      link.closest('[data-index]');
    if (!trackRow) return;

    const controlsBar = findTrackControlsBar(trackRow);
    if (!controlsBar) return;
    if (controlsBar.querySelector('.YMD-track-action-button')) return;
    const trackMeta = getTrackMeta(trackRow, trackId);

    const contextMenuWrapper = controlsBar.querySelector(
      '[class*="CommonControlsBar_contextMenuWrapper__"]'
    );
    const button = createTrackActionButton(trackId, trackMeta);

    if (contextMenuWrapper?.parentElement === controlsBar) {
      controlsBar.insertBefore(button, contextMenuWrapper);
      return;
    }

    controlsBar.append(button);
  });
};

const getCurrentPlayerTrackId = () => {
  // Новый UI
  const player = document.querySelector<HTMLElement>(PLAYER_ROOT_SELECTOR);

  if (player) {
    const links =
      player.querySelectorAll<HTMLAnchorElement>('a[href*="/track/"]');

    let foundTrackId: number | null = null;

    links.forEach(link => {
      if (foundTrackId) return;

      const href = link.getAttribute('href');

      if (!href) return;

      const trackId = parseTrackIdFromHref(href);

      if (trackId) {
        console.log('PLAYER TRACK:', trackId);

        foundTrackId = trackId;
      }
    });

    if (foundTrackId) {
      return foundTrackId;
    }
  }

  // Старый UI
  const legacyTrackLink = document.querySelector<HTMLAnchorElement>(
    '.player-controls .track__name a'
  );

  const legacyHref = legacyTrackLink?.getAttribute('href');

  if (!legacyHref) return null;

  return parseTrackIdFromHref(legacyHref);
};

const removeElement = (selector: string) => {
  document.querySelector(selector)?.remove();
};

const syncPlayerButton = () => {
  const trackId = getCurrentPlayerTrackId();

  if (!trackId) {
    removeElement('.YMD-floating-player-button');

    return;
  }

  const existingButton = document.querySelector<HTMLButtonElement>(
    '.YMD-floating-player-button'
  );

  // если кнопка уже существует
  // и трек не поменялся
  // ничего не делаем
  if (existingButton && existingButton.dataset.ymdTrackId === String(trackId)) {
    return;
  }

  removeElement('.YMD-floating-player-button');

  const playerRoot = document.querySelector(PLAYER_ROOT_SELECTOR) || document;

  const trackMeta = getTrackMeta(playerRoot, trackId);

  const button = createIconButton(
    ['YMD-floating-button', 'YMD-floating-player-button'],
    'Скачать текущий трек',
    () => {
      console.log('DOWNLOAD CURRENT TRACK', trackId);

      downloadTrack(trackId, trackMeta);
    }
  );

  button.dataset.ymdTrackId = String(trackId);

  button.style.position = 'fixed';
  button.style.right = '200px';
  button.style.bottom = '20px';
  button.style.zIndex = '999999';

  document.body.append(button);
};

const syncContent = () => {
  addTrackRowButtons();
  addInlineTrackButtons();
  syncPlayerButton();
  updateAllIconsTheme();
};

const debouncedSyncContent = debounce(syncContent, APP_SYNC_TIMEOUT);

const startObservers = () => {
  syncContent();

  const bodyObserver = new MutationObserver(() => {
    debouncedSyncContent();
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  const themeObserver = new MutationObserver(() => {
    updateAllIconsTheme();
  });

  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  let currentUrl = window.location.href;
  window.setInterval(() => {
    if (currentUrl === window.location.href) return;
    currentUrl = window.location.href;
    syncContent();
  }, 500);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObservers, {once: true});
} else {
  startObservers();
}
