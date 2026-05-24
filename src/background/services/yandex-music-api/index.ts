import md5 from 'md5';

import {
  Track,
  Album,
  Playlist,
  Artist,
  Lyric,
  YandexMusicAPI as IYandexMusicAPI,
} from './interfaces';

/**
 * Info about track's file
 */
type TrackDownloadInfo = {
  readonly codec: string /* should be mp3 */;
  readonly bitrateInKbps: number;
  readonly downloadInfoUrl: string;
  readonly direct: boolean;
  readonly gain: boolean;
  /* true if only preview version is available for you */
  readonly preview: boolean;
};

export type ResolvedTrackDownloadInfo = TrackDownloadInfo;

type GetFileInfoResponse = {
  readonly downloadInfo?: {
    readonly url?: string;
  };
};

type ApiResponse<T> = {
  readonly result: T;
  readonly error?: {
    readonly name?: string;
    readonly message?: string;
  };
};

/**
 * Implementation of yandex api functional
 */
export class YandexMusicAPI implements IYandexMusicAPI {
  private static readonly desktopClient_ = 'YandexMusicDesktopAppWindows/1';
  private static readonly fileInfoSecret_ = 'kzqU4XhfCaY6B6JTHODeq5';
  private static readonly oauthQualities_ = [
    'lossless-flac___aac,he-aac,mp3,flac-mp4,aac-mp4,he-aac-mp4___encraw',
    'lossless',
    'aac,he-aac,mp3,flac-mp4,aac-mp4,he-aac-mp4___encraw',
  ];
  protected static availableLocales_: string[] = [
    'by',
    'ru',
    'kz',
    'uz',
    'com',
    'net',
    'ua',
  ];

  protected locale_: string;
  protected headers_: {[header: string]: string};
  private oauthToken_: string;
  private getLanguage(): string {
    switch (this.locale_) {
      case 'by':
        return 'ru';
      case 'kz':
        return 'kk';
      case 'ua':
        return 'uk';
      case 'uz':
        return 'uz';
      case 'com':
      case 'net':
        return 'en';
      default:
        return 'ru';
    }
  }

  private async requestJson<T>(
    path: string,
    init?: {
      readonly method?: 'GET' | 'POST';
      readonly data?: {[key: string]: string | number | boolean};
      readonly headers?: {[header: string]: string};
    }
  ): Promise<T> {
    const body = init?.data
      ? new URLSearchParams(
          Object.entries(init.data).map(([key, value]) => [key, String(value)])
        ).toString()
      : undefined;

    const response = await fetch(`https://${path}`, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...this.headers_,
        Accept: 'application/json',
        ...init?.headers,
        ...(body
          ? {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            }
          : {}),
      },
      body,
    });

    const rawPayload = await response.text();
    const payload = rawPayload
      ? ((JSON.parse(rawPayload) as ApiResponse<T> | T))
      : null;

    if (!response.ok) {
      const error =
        payload && typeof payload === 'object' && 'error' in payload
          ? (payload as ApiResponse<T>).error
          : null;
      throw new Error(
        error?.message ||
          error?.name ||
          `Yandex Music API error ${response.status}`
      );
    }

    if (!payload) {
      throw new Error(`Empty response from Yandex Music API for ${path}`);
    }

    if (payload && typeof payload === 'object' && 'result' in payload) {
      return (payload as ApiResponse<T>).result;
    }

    return payload as T;
  }

  private async generateFileInfoSignature_(
    trackId: number,
    quality: string
  ): Promise<{ts: number; sign: string}> {
    const ts = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(YandexMusicAPI.fileInfoSecret_),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['sign']
    );
    const payload = `${ts}${trackId}${quality}mp3raw`;
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      encoder.encode(payload)
    );
    const binary = Array.from(new Uint8Array(signature), byte =>
      String.fromCharCode(byte)
    ).join('');

    return {
      ts,
      sign: btoa(binary).replace(/=+$/u, ''),
    };
  }

  private async getTrackDownloadLinkByOAuth_(
    trackId: number
  ): Promise<string | null> {
    if (!this.oauthToken_) return null;

    let lastError: Error | null = null;

    for (const quality of YandexMusicAPI.oauthQualities_) {
      try {
        const {ts, sign} = await this.generateFileInfoSignature_(
          trackId,
          quality
        );
        const params = new URLSearchParams({
          ts: String(ts),
          trackId: String(trackId),
          quality,
          codecs: 'mp3',
          transports: 'raw',
          sign,
        });
        params.set('byVectorserver', '1');

        const response = await this.requestJson<GetFileInfoResponse>(
          `api.music.yandex.ru/get-file-info?${params.toString()}`,
          {
            headers: {
              Authorization: `OAuth ${this.oauthToken_}`,
              'X-Yandex-Music-Client': YandexMusicAPI.desktopClient_,
            },
          }
        );
        const url = response.downloadInfo?.url ?? null;
        if (url) return url;
      } catch (err) {
        lastError = err as Error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return null;
  }

  private async requestText(pathOrUrl: string): Promise<string> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `https://${pathOrUrl}`;
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        ...this.headers_,
        Accept: '*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`Yandex Music API error ${response.status}`);
    }

    return await response.text();
  }

  private getXmlValue(xml: string, tagName: string): string {
    const match = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
    if (!match?.[1]) {
      throw new Error(`Missing "${tagName}" in track download info`);
    }

    return match[1];
  }

  private async getArtistTrackIds(artistId: number): Promise<number[]> {
    const pageSize = 200;
    const trackIds: number[] = [];
    let page = 0;

    while (true) {
      const batch = await this.requestJson<(number | string)[]>(
        `api.music.yandex.net/artists/${artistId}/track-ids?page=${page}` +
          `&page-size=${pageSize}`
      );

      if (batch.length === 0) break;

      trackIds.push(...batch.map(trackId => +trackId));

      if (batch.length < pageSize) break;
      page++;
    }

    return trackIds;
  }
  /**
   * Creates new instance of YandexMusicAPI with specified locale
   * @example new YandexMusicAPI('by')
   */
  constructor(locale = 'ru', oauthToken = '') {
    if (!YandexMusicAPI.availableLocales_.includes(locale)) {
      locale = 'com';
    }
    this.locale_ = locale;
    this.oauthToken_ = oauthToken.trim();
    this.headers_ = {
      'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
      'Accept-Language': this.getLanguage(),
    };
  }
  /**
   * @return track info
   */
  async getTrack(trackId: number): Promise<{
    readonly artists: Artist[];
    readonly otherVersions: {[version: string]: Track[]};
    readonly alsoInAlbums: Album[];
    readonly similarTracks: Track[];
    readonly track: Track;
    readonly lyric: Lyric[];
  }> {
    const tracks = await this.requestJson<Track[]>(
      'api.music.yandex.net/tracks',
      {
        method: 'POST',
        data: {
          'track-ids': trackId,
          'with-positions': true,
        },
      }
    );
    const track = tracks[0];

    if (!track) {
      throw new Error(`Track ${trackId} not found`);
    }

    return {
      artists: track.artists as Artist[],
      otherVersions: {},
      alsoInAlbums: [],
      similarTracks: [],
      track,
      lyric: [],
    };
  }
  /**
   * @return album info
   */
  async getAlbum(albumId: number): Promise<Album> {
    return await this.requestJson<Album>(
      `api.music.yandex.net/albums/${albumId}/with-tracks`
    );
  }
  /**
   * @return artist info
   */
  async getArtist(artistId: number): Promise<{
    readonly artist: Artist;
    readonly similar: Artist[];
    readonly allSimilar: Artist[];
    readonly albums: Album[];
    readonly alsoAlbums: Album[];
    readonly tracks: Track[];
    readonly playlistIds: {
      readonly uid: number;
      readonly kind: number;
    }[];
    readonly playlists: Playlist[];
    readonly trackIds: number[];
  }> {
    const artists = await this.requestJson<Artist[]>(
      'api.music.yandex.net/artists',
      {
        method: 'POST',
        data: {
          'artist-ids': artistId,
        },
      }
    );
    const artist = artists[0];

    if (!artist) {
      throw new Error(`Artist ${artistId} not found`);
    }

    return {
      artist,
      similar: [],
      allSimilar: [],
      albums: [],
      alsoAlbums: [],
      tracks: [],
      playlistIds: [],
      playlists: [],
      trackIds: await this.getArtistTrackIds(artistId),
    };
  }
  /**
   * @return playlist info
   */
  async getPlaylist(
    uid: number | string,
    kind: number
  ): Promise<{playlist: Playlist}> {
    return {
      playlist: await this.requestJson<Playlist>(
        `api.music.yandex.net/users/${uid}/playlists/${kind}`
      ),
    };
  }
  /**
   * @return link to track's mp3 file
   */
  async getTrackDownloadLink(trackId: number): Promise<string> {
    try {
      const directLink = await this.getTrackDownloadLinkByOAuth_(trackId);
      if (directLink) return directLink;
    } catch (err) {
      console.warn('OAuth file-info download failed, falling back', err);
    }

    const trackDownloadInfos = await this.requestJson<TrackDownloadInfo[]>(
      `api.music.yandex.net/tracks/${trackId}/download-info`
    );

    const trackDownloadInfo = [...trackDownloadInfos]
      .filter(trackInfo => trackInfo.codec === 'mp3')
      .sort((a, b) => {
        if (a.preview !== b.preview) {
          return Number(a.preview) - Number(b.preview);
        }
        return b.bitrateInKbps - a.bitrateInKbps;
      })[0];

    if (!trackDownloadInfo) {
      throw new Error(`No downloadable mp3 found for track ${trackId}`);
    }

    if (trackDownloadInfo.direct) {
      return trackDownloadInfo.downloadInfoUrl;
    }

    const xml = await this.requestText(trackDownloadInfo.downloadInfoUrl);
    const host = this.getXmlValue(xml, 'host');
    const path = this.getXmlValue(xml, 'path');
    const ts = this.getXmlValue(xml, 'ts');
    const s = this.getXmlValue(xml, 's');
    const hasht = md5('XGRlBW9FXlekgbPrRHuSiA' + path.substring(1) + s);

    return `https://${host}/get-mp3/${hasht}/${ts}${path}?track-id=${trackId}`;
  }
  async resolveTrackDownloadInfo(
    trackId: number,
    trackDownloadInfo: ResolvedTrackDownloadInfo
  ): Promise<string> {
    if (trackDownloadInfo.direct) {
      return trackDownloadInfo.downloadInfoUrl;
    }

    const xml = await this.requestText(trackDownloadInfo.downloadInfoUrl);
    const host = this.getXmlValue(xml, 'host');
    const path = this.getXmlValue(xml, 'path');
    const ts = this.getXmlValue(xml, 'ts');
    const s = this.getXmlValue(xml, 's');
    const hasht = md5('XGRlBW9FXlekgbPrRHuSiA' + path.substring(1) + s);

    return `https://${host}/get-mp3/${hasht}/${ts}${path}?track-id=${trackId}`;
  }
  /**
   * @return link to covers
   */
  async getCoverDownloadLink(coverUri: string, size: number): Promise<string> {
    return `https://${coverUri.replace('%%', `${size}x${size}`)}`;
  }
  /**
   * @return instance locale
   */
  getLocale(): string {
    return this.locale_;
  }
}
