import { publicUrlFor } from '../config.js'
import type { EbookFormat } from '../types.js'
import { NATIVE_RESOURCES } from './native-resources.js'
import type { QueuedBook } from './queue.js'

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000001'

const COVER_PATH = '/v1/books/{ImageId}/thumbnail/{Width}/{Height}'

const KOBO_FORMAT: Partial<Record<EbookFormat, string>> = {
  kepub: 'KEPUB',
  epub: 'EPUB',
  pdf: 'PDF',
  cbz: 'CBZ',
  cbr: 'CBR',
  txt: 'TXT',
  html: 'HTML',
  mobi: 'MOBI',
  azw3: 'AZW3',
  kfx: 'KFX',
  kfxZip: 'KFX',
}

function koboFormat(format: EbookFormat): string {
  return KOBO_FORMAT[format] ?? 'EPUB'
}

function downloadUrl(token: string, book: QueuedBook): string {
  return publicUrlFor(`/kobo/${token}/download/${book.id}`)
}

function origin(): string {
  return publicUrlFor('/').replace(/\/+$/, '')
}

function bookMetadata(book: QueuedBook, token: string): Record<string, unknown> {
  const when = book.queuedAt.toISOString()
  return {
    Categories: [PLACEHOLDER_ID],
    Contributors: book.authors.length > 0 ? book.authors : ['send2ereader'],
    CoverImageId: book.id,
    CrossRevisionId: book.id,
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
    CurrentLoveDisplayPrice: { TotalAmount: 0 },
    Description: 'Sent with send2ereader',
    DownloadUrls: [
      {
        Format: koboFormat(book.format),
        Size: book.size,
        Url: downloadUrl(token, book),
        Platform: 'Generic',
        DrmType: 'None',
      },
    ],
    EntitlementId: book.id,
    ExternalIds: [],
    Genre: PLACEHOLDER_ID,
    IsEligibleForKoboLove: false,
    IsInternetArchive: false,
    IsPreOrder: false,
    IsSocialEnabled: true,
    Language: book.language ?? 'en',
    PhoneticPronunciations: {},
    PublicationDate: when,
    Publisher: { Imprint: '', Name: 'send2ereader' },
    RevisionId: book.id,
    Title: book.title,
    WorkId: book.id,
    ZeroDollarPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
    Slug: book.id,
    IsbnValue: null,
  }
}

function bookEntitlement(book: QueuedBook): Record<string, unknown> {
  const when = book.queuedAt.toISOString()
  return {
    Accessibility: 'Full',
    ActivePeriod: { From: when },
    Created: when,
    CrossRevisionId: book.id,
    Id: book.id,
    IsHiddenFromArchive: false,
    IsLocked: false,
    IsRemoved: false,
    LastModified: when,
    OriginCategory: 'Imported',
    RevisionId: book.id,
    Status: 'Active',
  }
}

export function readingState(book: QueuedBook): Record<string, unknown> {
  const when = book.queuedAt.toISOString()
  return {
    EntitlementId: book.id,
    Created: when,
    LastModified: when,
    PriorityTimestamp: when,
    StatusInfo: { LastModified: when, Status: 'ReadyToRead', TimesStartedReading: 0 },
  }
}

export function newEntitlement(book: QueuedBook, token: string): Record<string, unknown> {
  return {
    NewEntitlement: {
      BookEntitlement: bookEntitlement(book),
      BookMetadata: bookMetadata(book, token),
      ReadingState: readingState(book),
    },
  }
}

export function metadataResponse(book: QueuedBook, token: string): Record<string, unknown> {
  return bookMetadata(book, token)
}

export function initializationResources(
  token: string,
  upstream: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = publicUrlFor(`/kobo/${token}`)
  return {
    ...NATIVE_RESOURCES,
    ...upstream,
    image_host: origin(),
    image_url_quality_template: `${base}${COVER_PATH}/{Quality}/{IsGreyscale}/image.jpg`,
    image_url_template: `${base}${COVER_PATH}/false/image.jpg`,
    library_sync: `${base}/v1/library/sync`,
    library_items: `${base}/v1/library/`,
    library_metadata: `${base}/v1/library/`,
    library_stack: `${base}/v1/library/`,
    content_access_book: `${base}/v1/library/`,
  }
}
