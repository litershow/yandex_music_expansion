import {EventType, DownloadItem} from '../services/download-manager/interfaces';

export enum ChromeMessageType {
  DOWNLOAD_TRACK = 0,
  DOWNLOAD_ALBUM = 1,
  DOWNLOAD_PLAYLIST = 2,
  DOWNLOAD_ARTIST = 3,

  ADD_DOWNLOAD_LISTENER = 4,
  ADD_ERROR_LISTENER = 5,

  DOWNLOAD_EVENT = 6,
  DOWNLOAD_ERROR_EVENT = 7,
  ERROR_EVENT = 8,

  LIST_DOWNLOAD_ITEMS = 9,
  INTERRUPT_DOWNLOAD = 10,
}

type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
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

type TrackMeta = {
  title?: string;
  album?: string;
  artist?: string;
};

export type ChromeMessage =
  | {
      type: ChromeMessageType.DOWNLOAD_TRACK;
      trackId: number;
      resolvedTrack?: ResolvedTrackPayload;
      trackMeta?: TrackMeta;
    }
  | {
      type: ChromeMessageType.DOWNLOAD_ALBUM;
      albumId: number;
    }
  | {
      type: ChromeMessageType.DOWNLOAD_PLAYLIST;
      owner: string | number;
      kind: number;
    }
  | {
      type: ChromeMessageType.DOWNLOAD_ARTIST;
      artistId: number;
    }
  | {
      type: ChromeMessageType.ADD_DOWNLOAD_LISTENER;
    }
  | {
      type: ChromeMessageType.ADD_ERROR_LISTENER;
    }
  | {
      type: ChromeMessageType.DOWNLOAD_EVENT;
      eventType: EventType;
      downloadItem: DownloadItem & {bytes: null};
    }
  | {
      type: ChromeMessageType.DOWNLOAD_ERROR_EVENT;
      downloadItem: DownloadItem & {bytes: null};
      error: SerializedError;
    }
  | {
      type: ChromeMessageType.ERROR_EVENT;
      error: SerializedError;
    }
  | {
      type: ChromeMessageType.LIST_DOWNLOAD_ITEMS;
      items: (DownloadItem & {bytes: null})[];
    }
  | {
      type: ChromeMessageType.INTERRUPT_DOWNLOAD;
      downloadItemId: number;
    };
