import {DownloadManager} from './services/download-manager';
import {DownloadItem} from './services/download-manager/interfaces';

import {YandexMusicAPI} from './services/yandex-music-api';
import {TrackID3TagWriter} from './services/id3-tag-writer';
import {UserSettings} from './services/user-settings';

import {ChromeMessageType, ChromeMessage} from './interfaces';

type ErrorCallback = (err: Error) => void;

const serializeError = (error: Error) => {
  return {
    message: error.message || 'Unknown error',
    name: error.name,
    stack: error.stack,
  };
};

export class BackgroundApiService {
  private yandexMusicApi: YandexMusicAPI;

  static userSettings: UserSettings;
  static downloadManager: DownloadManager;

  private static errorListeners_: ErrorCallback[] = [];
  private static completeEventCallback_: (
    downloadItem: DownloadItem
  ) => Promise<void>;
  protected static instance_: BackgroundApiService | null;
  /**
   * @return instance of BackgroundApiService.
   * It shares downloadManager and userSettings with other instances
   */
  static async getInstance(locale: string): Promise<BackgroundApiService> {
    if (!this.userSettings) {
      this.userSettings = new UserSettings();
      await this.userSettings.load();
    }
    const yma = new YandexMusicAPI(locale, this.userSettings.oauthToken);
    if (!this.downloadManager) {
      this.downloadManager = new DownloadManager(this.userSettings.concurrency);
      this.completeEventCallback_ = async item => {
        await this.processDownloadItem_(item);
      };
      this.downloadManager.on('complete', this.completeEventCallback_);
    }

    return new BackgroundApiService(
      yma,
      this.userSettings,
      this.downloadManager
    );
  }
  /**
   * Save reference to downloadManager userSettings and yandexMusicApi
   */
  private constructor(
    yandexMusicApi: YandexMusicAPI,
    userSettings: UserSettings,
    downloadManager: DownloadManager
  ) {
    this.yandexMusicApi = yandexMusicApi;
    BackgroundApiService.userSettings = userSettings;
    BackgroundApiService.downloadManager = downloadManager;
  }

  private createApi_(): YandexMusicAPI {
    return new YandexMusicAPI(
      this.yandexMusicApi.getLocale(),
      BackgroundApiService.userSettings.oauthToken
    );
  }

  /**
   * Passes error object to all error listeners
   */
  private static emitError_(err: Error) {
    console.error(err);
    for (const callback of this.errorListeners_) {
      callback(err);
    }
  }

  /**
   * Service workers are unreliable with blob URLs, so use a data URL
   * when handing the tagged mp3 over to chrome.downloads.
   */
  private static bufferToDataUrl_(buffer: Buffer): string {
    return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
  }
  private static async saveBytes_(
    bytes: Buffer,
    filename: string,
    downloadPath: string
  ): Promise<void> {
    const url = this.bufferToDataUrl_(bytes);

    return new Promise<void>(resolve => {
      chrome.downloads.download(
        {
          url,
          filename: downloadPath + filename,
        },
        () => resolve()
      );
    });
  }
  private static async startBrowserDownload_(
    url: string,
    filename: string,
    downloadPath: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: downloadPath + filename,
          conflictAction: 'uniquify',
        },
        downloadId => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (typeof downloadId !== 'number') {
            reject(new Error('Failed to start browser download'));
            return;
          }

          resolve();
        }
      );
    });
  }
  /**
   * Downloads buffer
   */
  private static async downloadCover_(uri: string): Promise<Buffer> {
    const response = await fetch(uri, {
      headers: {
        Accept: '*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`Cover download failed with status ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
  /**
   * Used as callback to onComplete event on downloadManager.
   * Sets id3 tags and saves file to specified folder
   */
  private static async processDownloadItem_(item: DownloadItem) {
    if (!item.bytes) return;

    try {
      if (!item.customData?.trackId || !item.customData?.locale) {
        await this.saveBytes_(item.bytes, item.filename, item.downloadPath);
        return;
      }

      const yandexMusicApi = new YandexMusicAPI(
        item.customData.locale as string,
        BackgroundApiService.userSettings.oauthToken
      );

      /* get track info */
      const track = await yandexMusicApi.getTrack(+item.customData.trackId);

      /* set id3 tags */
      const tagWriter = new TrackID3TagWriter(item.bytes!);

      tagWriter
        .setTitle(track.track.title)
        .setType(track.track.type)
        .setDuration(track.track.durationMs);

      /* set album info */
      if (track.track.albums.length > 0) {
        tagWriter
          .setPositionInAlbum(track.track.albums[0].trackPosition.index)
          .setVolume(track.track.albums[0].trackPosition.volume)
          .setGenre(track.track.albums[0].genre)
          .setAlbum({
            title: track.track.albums[0].title,
            artist:
              track.track.albums[0].artists.length > 0
                ? track.track.albums[0].artists[0].name
                : undefined,
            year: track.track.albums[0].year,
          });
      }

      /* set artist info */
      if (track.track.artists.length > 0) {
        tagWriter.setArtists(track.artists.map(artist => artist.name));
      }

      /* set cover */
      if (track.track.coverUri) {
        const cover = await this.downloadCover_(
          await yandexMusicApi.getCoverDownloadLink(
            track.track.coverUri,
            BackgroundApiService.userSettings.coverSize
          )
        );
        tagWriter.setCover(cover, track.track.title);
      }

      if (
        track.track.albums.length > 0 &&
        track.track.albums[0].labels.length !== 0
      ) {
        tagWriter.setLabel(track.track.albums[0].labels[0].name);
      }

      if (track.lyric.length !== 0) {
        tagWriter.setLyric(
          track.lyric[0].fullLyrics,
          track.track.title,
          track.lyric[0].textLanguage
        );
      }

      await this.saveBytes_(
        tagWriter.getTrack(),
        item.filename,
        item.downloadPath
      );
    } catch (err) {
      BackgroundApiService.emitError_(err);
      await this.saveBytes_(item.bytes, item.filename, item.downloadPath);
    }
  }
  /**
   * Encodes file to filesystem friendly format by escaping banned symbols
   */
  private static encodeFilename_(filename: string): string {
    const res = filename
      .replaceAll(':', '%58')
      .replaceAll('?', '%63')
      .replaceAll('*', '%2A')
      .replaceAll('/', '%47')
      .replaceAll('\\', '%5C')
      .replaceAll('"', '%22')
      .replaceAll('|', '%124');
    return res;
  }
  /**
   * Alias for encodeFoldermame_
   */
  private static encodeFolderName_(folderName: string): string {
    return this.encodeFilename_(folderName);
  }
  /**
   * Generate filename based on provided template and args
   */
  private static generateTrackFilename_(
    template: string,
    title: string,
    album: string,
    artist: string
  ): string {
    const filename = template
      .replaceAll('{title}', title)
      .replaceAll('{album}', album)
      .replaceAll('{artist}', artist)
      .trim();

    return this.encodeFilename_(filename);
  }

  /* API */
  /**
   * Add error listener.
   * Only errors fired in BackgroundApiService will be emitted
   */
  static on(_type: 'error', callback: ErrorCallback) {
    if (this.errorListeners_.includes(callback)) return;
    this.errorListeners_.push(callback);
  }
  /**
   * Removes error listener.
   */
  static removeListener(_type: 'error', callback: ErrorCallback) {
    const index = this.errorListeners_.indexOf(callback);
    if (index === -1) return;

    this.errorListeners_.splice(index, 1);
  }
  /**
   * Adds track to the download queue
   */
  async downloadTrack(
    trackId: number,
    resolvedTrack?: {
      available: boolean;
      downloadInfo: {
        codec: string;
        bitrateInKbps: number;
        downloadInfoUrl: string;
        direct: boolean;
        gain: boolean;
        preview: boolean;
      };
    },
    trackMeta?: {
      title?: string;
      album?: string;
      artist?: string;
    }
  ): Promise<void> {
    try {
      const yandexMusicApi = this.createApi_();
      let title = trackMeta?.title?.trim() || `track-${trackId}`;
      let album = trackMeta?.album?.trim() || '';
      let artist = trackMeta?.artist?.trim() || '';
      let downloadUrl = '';

      if (resolvedTrack && !resolvedTrack.downloadInfo.preview) {
        if (!resolvedTrack.available) return;

        downloadUrl = await yandexMusicApi.resolveTrackDownloadInfo(
          +trackId,
          resolvedTrack.downloadInfo
        );
      } else {
        downloadUrl = await yandexMusicApi.getTrackDownloadLink(+trackId);
      }

      if (!resolvedTrack || resolvedTrack.downloadInfo.preview) {
        const track = await yandexMusicApi.getTrack(+trackId);
        if (!track.track.available) return;

        title = title || track.track.title;
        album =
          album ||
          (track.track.albums.length > 0 ? track.track.albums[0].title : '');
        artist =
          artist ||
          (track.track.artists.length > 0 ? track.track.artists[0].name : '');
      }

      const filename = BackgroundApiService.generateTrackFilename_(
        BackgroundApiService.userSettings.filenameFormat,
        title,
        album,
        artist
      );

      const path = BackgroundApiService.userSettings.downloadPath;
      await BackgroundApiService.startBrowserDownload_(
        downloadUrl,
        filename + '.mp3',
        path
      );
    } catch (err) {
      BackgroundApiService.emitError_(err);
    }
  }
  /**
   * Download all songs from provided album
   */
  async downloadAlbum(albumId: number): Promise<void> {
    /* get album info */
    const yandexMusicApi = this.createApi_();
    const album = await yandexMusicApi.getAlbum(albumId);

    let volumeIndex = 1;
    for (const volume of album.volumes) {
      for (const track of volume) {
        try {
          if (!track.available) continue;
          const downloadUrl = await yandexMusicApi.getTrackDownloadLink(
            +track.id
          );

          const filename = BackgroundApiService.generateTrackFilename_(
            BackgroundApiService.userSettings.filenameFormat,
            track.title,
            track.albums.length > 0 ? track.albums[0].title : '',
            track.artists.length > 0 ? track.artists[0].name : ''
          );

          let path = BackgroundApiService.userSettings.downloadPath;
          if (
            BackgroundApiService.userSettings.downloadAlbumsInSeparateFolder
          ) {
            if (album.artists.length > 0) {
              path += `${BackgroundApiService.encodeFolderName_(
                album.artists[0].name
              )}-${BackgroundApiService.encodeFolderName_(album.title)}/`;
            } else {
              path += `${BackgroundApiService.encodeFolderName_(album.title)}/`;
            }
          }
          if (album.volumes.length > 1) {
            path += `volume ${volumeIndex}/`;
          }

          BackgroundApiService.downloadManager.download(
            downloadUrl,
            track.title,
            filename + '.mp3',
            path,
            {trackId: track.id, locale: yandexMusicApi.getLocale()}
          );
        } catch (err) {
          BackgroundApiService.emitError_(err);
        }
      }
      ++volumeIndex;
    }
  }
  /**
   * Downloads all songs from provided playlist
   */
  async downloadPlaylist(owner: string | number, kind: number): Promise<void> {
    /* get playlist info */
    const yandexMusicApi = this.createApi_();
    const {playlist} = await yandexMusicApi.getPlaylist(owner, kind);

    for (const track of playlist.tracks) {
      try {
        if (!track.available) continue;
        const downloadUrl = await yandexMusicApi.getTrackDownloadLink(
          +track.id
        );

        const filename = BackgroundApiService.generateTrackFilename_(
          BackgroundApiService.userSettings.filenameFormat,
          track.title,
          track.albums.length > 0 ? track.albums[0].title : '',
          track.artists.length > 0 ? track.artists[0].name : ''
        );

        let path = BackgroundApiService.userSettings.downloadPath;
        if (
          BackgroundApiService.userSettings.downloadPlaylistsInSeparateFolder
        ) {
          path += `${BackgroundApiService.encodeFolderName_(playlist.title)}/`;
        }

        BackgroundApiService.downloadManager.download(
          downloadUrl,
          track.title,
          filename + '.mp3',
          path,
          {trackId: track.id, locale: yandexMusicApi.getLocale()}
        );
      } catch (err) {
        BackgroundApiService.emitError_(err);
      }
    }
  }
  /**
   * Downloads all songs of provided artist
   */
  async downloadArtist(artistId: number): Promise<void> {
    /* get artist info */
    const yandexMusicApi = this.createApi_();
    const artist = await yandexMusicApi.getArtist(artistId);

    for (const trackId of artist.trackIds) {
      try {
        /* get track info */
        const {track} = await yandexMusicApi.getTrack(+trackId);
        if (!track.available) continue;

        const downloadUrl = await yandexMusicApi.getTrackDownloadLink(
          +track.id
        );

        const filename = BackgroundApiService.generateTrackFilename_(
          BackgroundApiService.userSettings.filenameFormat,
          track.title,
          track.albums.length > 0 ? track.albums[0].title : '',
          track.artists.length > 0 ? track.artists[0].name : ''
        );

        let path = BackgroundApiService.userSettings.downloadPath;
        if (BackgroundApiService.userSettings.downloadArtistsInSeparateFolder) {
          path += `${BackgroundApiService.encodeFolderName_(
            artist.artist.name
          )}/`;
        }

        BackgroundApiService.downloadManager.download(
          downloadUrl,
          track.title,
          filename + '.mp3',
          path,
          {trackId: track.id, locale: yandexMusicApi.getLocale()}
        );
      } catch (err) {
        BackgroundApiService.emitError_(err);
      }
    }
  }
}

const setTabActionIcon = (tabId?: number) => {
  if (typeof tabId !== 'number') return;

  const details = {
    path: 'images/active-icon.png',
    tabId,
  };

  if (chrome.action?.setIcon) {
    chrome.action.setIcon(details);
    return;
  }

  if (chrome.browserAction?.setIcon) {
    chrome.browserAction.setIcon(details);
  }
};

chrome.runtime.onConnect.addListener(async port => {
  /* `port.name` is locale */
  setTabActionIcon(port.sender?.tab?.id);

  const addEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'add',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const progressEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'progress',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const interruptedEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'interrupted',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const completeEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'complete',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const downloadErrorEventCallback = async (
    downloadItem: DownloadItem,
    error: Error
  ) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_ERROR_EVENT,
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
      error: serializeError(error),
    };

    port.postMessage(message);
  };

  const errorEventCallback = (error: Error) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.ERROR_EVENT,
      error: serializeError(error),
    };

    port.postMessage(message);
  };

  const backgroundApi = await BackgroundApiService.getInstance(port.name);
  port.onMessage.addListener((message: ChromeMessage) => {
    switch (message.type) {
      case ChromeMessageType.ADD_DOWNLOAD_LISTENER: {
        BackgroundApiService.downloadManager.on('add', addEventCallback);
        BackgroundApiService.downloadManager.on(
          'progress',
          progressEventCallback
        );
        BackgroundApiService.downloadManager.on(
          'interrupted',
          interruptedEventCallback
        );
        BackgroundApiService.downloadManager.on(
          'complete',
          completeEventCallback
        );
        break;
      }
      case ChromeMessageType.ADD_ERROR_LISTENER: {
        BackgroundApiService.downloadManager.on(
          'error',
          downloadErrorEventCallback
        );
        BackgroundApiService.on('error', errorEventCallback);
        break;
      }
      case ChromeMessageType.DOWNLOAD_TRACK: {
        backgroundApi.downloadTrack(
          message.trackId,
          message.resolvedTrack,
          message.trackMeta
        );
        break;
      }
      case ChromeMessageType.DOWNLOAD_ALBUM: {
        backgroundApi.downloadAlbum(message.albumId);
        break;
      }
      case ChromeMessageType.DOWNLOAD_PLAYLIST: {
        backgroundApi.downloadPlaylist(message.owner, message.kind);
        break;
      }
      case ChromeMessageType.DOWNLOAD_ARTIST: {
        backgroundApi.downloadArtist(message.artistId);
        break;
      }
      case ChromeMessageType.LIST_DOWNLOAD_ITEMS: {
        const message: ChromeMessage = {
          type: ChromeMessageType.LIST_DOWNLOAD_ITEMS,
          items: BackgroundApiService.downloadManager.list().map(item => {
            return {...item, bytes: null};
          }),
        };

        port.postMessage(message);
        break;
      }
      case ChromeMessageType.INTERRUPT_DOWNLOAD: {
        BackgroundApiService.downloadManager.interrupt(message.downloadItemId);
        break;
      }
      default: {
        console.debug('Unknown message type: ' + message.type);
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    /* Remove registered hooks */
    BackgroundApiService.downloadManager.removeListener(
      'add',
      addEventCallback
    );
    BackgroundApiService.downloadManager.removeListener(
      'progress',
      progressEventCallback
    );
    BackgroundApiService.downloadManager.removeListener(
      'interrupted',
      interruptedEventCallback
    );
    BackgroundApiService.downloadManager.removeListener(
      'complete',
      completeEventCallback
    );
    /* Remove registered error listeners */
    BackgroundApiService.downloadManager.removeListener(
      'error',
      downloadErrorEventCallback
    );
    BackgroundApiService.removeListener('error', errorEventCallback);
  });
});
