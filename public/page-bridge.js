// @ts-nocheck
/* eslint-env browser */
(function () {
  if (window.__YMD_PAGE_BRIDGE__) return;
  window.__YMD_PAGE_BRIDGE__ = true;

  const REQUEST_SOURCE = 'YMD_CONTENT';
  const RESPONSE_SOURCE = 'YMD_PAGE';
  const FETCH_TRACK_DATA = 'FETCH_TRACK_DATA';
  const FETCH_TRACK_DATA_RESULT = 'FETCH_TRACK_DATA_RESULT';
  const YM_CLIENT = 'YandexMusicAndroid/24023621';
  const YM_DESKTOP_CLIENT = 'YandexMusicDesktopAppWindows/1';
  const FILE_INFO_SECRET = 'kzqU4XhfCaY6B6JTHODeq5';
  const OAUTH_QUALITIES = [
    'lossless-flac___aac,he-aac,mp3,flac-mp4,aac-mp4,he-aac-mp4___encraw',
    'lossless',
    'aac,he-aac,mp3,flac-mp4,aac-mp4,he-aac-mp4___encraw',
  ];

  const requestJson = async (url, init) => {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Yandex-Music-Client': YM_CLIENT,
        ...(init && init.body
          ? {
              'Content-Type':
                'application/x-www-form-urlencoded; charset=UTF-8',
            }
          : {}),
        ...(init && init.headers ? init.headers : {}),
      },
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload && payload.error && payload.error.message
          ? payload.error.message
          : 'Page bridge request failed'
      );
    }

    return payload && payload.result ? payload.result : payload;
  };

  const generateSign = async (secretKey, data) => {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secretKey),
      {name: 'HMAC', hash: {name: 'SHA-256'}},
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      encoder.encode(data)
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(
      /=+$/,
      ''
    );
  };

  const getTrackDownloadInfoByOAuth = async (trackId, oauthToken) => {
    const token = oauthToken || window.localStorage.getItem('ymd_oauth_token');
    if (!token) {
      throw new Error('OAuth token is missing');
    }

    let lastError = null;

    for (const quality of OAUTH_QUALITIES) {
      try {
        const ts = Math.floor(Date.now() / 1000);
        const sign = await generateSign(
          FILE_INFO_SECRET,
          `${ts}${trackId}${quality}mp3raw`
        );
        const params = new URLSearchParams({
          ts: String(ts),
          trackId: String(trackId),
          quality,
          codecs: 'mp3',
          transports: 'raw',
          sign,
          byVectorserver: '1',
        });
        const payload = await requestJson(
          `https://api.music.yandex.ru/get-file-info?${params.toString()}`,
          {
            headers: {
              Authorization: `OAuth ${token}`,
              'X-Yandex-Music-Client': YM_DESKTOP_CLIENT,
            },
          }
        );
        const downloadUrl =
          payload && payload.downloadInfo ? payload.downloadInfo.url : null;

        if (downloadUrl) {
          return {
            available: true,
            downloadInfo: {
              codec: 'mp3',
              bitrateInKbps: 320,
              downloadInfoUrl: downloadUrl,
              direct: true,
              gain: false,
              preview: false,
            },
          };
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Failed to resolve track download URL');
  };

  const postResult = (requestId, payload, error) => {
    window.postMessage(
      {
        source: RESPONSE_SOURCE,
        type: FETCH_TRACK_DATA_RESULT,
        requestId,
        payload,
        error,
      },
      window.location.origin
    );
  };

  window.addEventListener('message', async event => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== REQUEST_SOURCE) return;
    if (data.type !== FETCH_TRACK_DATA) return;

    try {
      const trackId = +data.trackId;
      const resolvedTrack = await getTrackDownloadInfoByOAuth(
        trackId,
        data.oauthToken
      );

      postResult(data.requestId, resolvedTrack);
    } catch (err) {
      postResult(
        data.requestId,
        null,
        err instanceof Error ? err.message : String(err)
      );
    }
  });
})();
