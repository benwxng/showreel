export type ShowreelExportItem = {
  id: string
  name: string
  type: 'image' | 'video'
  src: string
  /** Display duration in seconds. */
  duration: number
}

export type ShowreelExportSettings = {
  background: string
  /** Padding around the media, matching the editor's 510px-tall preview scale. */
  padding: number
  fit: 'contain' | 'cover'
  aspectRatio: '16:9' | '4:3' | '1:1' | '9:16'
  quality?: '720p' | '1080p'
}

type PreparedMedia =
  | {
      item: ShowreelExportItem
      element: HTMLImageElement
      duration: number
      width: number
      height: number
    }
  | {
      item: ShowreelExportItem
      element: HTMLVideoElement
      duration: number
      width: number
      height: number
    }

const FRAME_RATE = 30
const MEDIA_LOAD_TIMEOUT_MS = 30_000

const FRAME_SIZES: Record<
  NonNullable<ShowreelExportSettings['quality']>,
  Record<ShowreelExportSettings['aspectRatio'], { width: number; height: number }>
> = {
  '720p': {
    '16:9': { width: 1280, height: 720 },
    '4:3': { width: 960, height: 720 },
    '1:1': { width: 720, height: 720 },
    '9:16': { width: 720, height: 1280 },
  },
  '1080p': {
    '16:9': { width: 1920, height: 1080 },
    '4:3': { width: 1440, height: 1080 },
    '1:1': { width: 1080, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
  },
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

function cleanUpMediaElement(element: HTMLImageElement | HTMLVideoElement) {
  if (element instanceof HTMLVideoElement) {
    element.pause()
    element.removeAttribute('src')
    element.load()
    return
  }

  element.removeAttribute('src')
}

function waitForMediaEvent(
  element: HTMLImageElement | HTMLVideoElement,
  eventName: 'load' | 'loadeddata',
  description: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish()
      reject(new Error(`Timed out while loading ${description}.`))
    }, MEDIA_LOAD_TIMEOUT_MS)

    const handleSuccess = () => {
      finish()
      resolve()
    }

    const handleError = () => {
      finish()
      reject(new Error(`Could not load ${description}.`))
    }

    const finish = () => {
      window.clearTimeout(timeout)
      element.removeEventListener(eventName, handleSuccess)
      element.removeEventListener('error', handleError)
    }

    element.addEventListener(eventName, handleSuccess, { once: true })
    element.addEventListener('error', handleError, { once: true })
  })
}

async function prepareItem(item: ShowreelExportItem): Promise<PreparedMedia> {
  if (!Number.isFinite(item.duration) || item.duration <= 0) {
    throw new Error(`"${item.name}" must have a duration greater than zero.`)
  }

  if (!item.src) {
    throw new Error(`"${item.name}" does not have a media source.`)
  }

  if (item.type === 'image') {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'

    try {
      const loaded = waitForMediaEvent(image, 'load', `"${item.name}"`)
      image.src = item.src
      await loaded

      if (typeof image.decode === 'function') {
        await image.decode()
      }

      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error(`"${item.name}" has invalid image dimensions.`)
      }

      return {
        item,
        element: image,
        duration: item.duration,
        width: image.naturalWidth,
        height: image.naturalHeight,
      }
    } catch (error) {
      cleanUpMediaElement(image)
      throw toError(error, `Could not prepare "${item.name}".`)
    }
  }

  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  try {
    const loaded = waitForMediaEvent(video, 'loadeddata', `"${item.name}"`)
    video.src = item.src
    video.load()
    await loaded

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error(`"${item.name}" has invalid video dimensions.`)
    }

    const mediaDuration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : item.duration

    return {
      item,
      element: video,
      duration: Math.min(item.duration, mediaDuration),
      width: video.videoWidth,
      height: video.videoHeight,
    }
  } catch (error) {
    cleanUpMediaElement(video)
    throw toError(error, `Could not prepare "${item.name}".`)
  }
}

function drawMedia(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  settings: ShowreelExportSettings,
) {
  const { width, height } = context.canvas
  const paddingRatio = Math.min(0.45, Math.max(0, settings.padding) / 510)
  const paddingX = Math.min(width, height) * paddingRatio
  const paddingY = Math.min(width, height) * paddingRatio
  const contentWidth = Math.max(1, width - paddingX * 2)
  const contentHeight = Math.max(1, height - paddingY * 2)
  const scale =
    settings.fit === 'cover'
      ? Math.max(contentWidth / sourceWidth, contentHeight / sourceHeight)
      : Math.min(contentWidth / sourceWidth, contentHeight / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  const drawX = paddingX + (contentWidth - drawWidth) / 2
  const drawY = paddingY + (contentHeight - drawHeight) / 2

  context.save()
  context.fillStyle = settings.background
  context.fillRect(0, 0, width, height)
  context.beginPath()
  context.rect(paddingX, paddingY, contentWidth, contentHeight)
  context.clip()
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight)
  context.restore()
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function getSupportedWebMMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]

  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return 'video/webm'
  }

  const supported = candidates.find((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
  )

  if (!supported) {
    throw new Error('This browser cannot export WebM video.')
  }

  return supported
}

/**
 * Renders a showreel in real time and returns a silent WebM video.
 *
 * This function is intentionally browser-only. Call it from a Client Component
 * in response to a user action so that media playback is permitted.
 */
export async function exportShowreel(
  items: ShowreelExportItem[],
  settings: ShowreelExportSettings,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const reportProgress = (progress: number) => {
    try {
      onProgress?.(Math.min(1, Math.max(0, progress)))
    } catch {
      // A display-only progress handler should not invalidate a finished export.
    }
  }

  reportProgress(0)

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Showreel export is only available in a browser.')
  }

  if (
    typeof MediaRecorder === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined' ||
    typeof HTMLCanvasElement.prototype.captureStream !== 'function'
  ) {
    throw new Error('This browser does not support video export.')
  }

  if (!items.length) {
    throw new Error('Add at least one image or video before exporting.')
  }

  if (!(settings.aspectRatio in FRAME_SIZES['720p'])) {
    throw new Error('The selected aspect ratio is not supported.')
  }

  if (settings.fit !== 'contain' && settings.fit !== 'cover') {
    throw new Error('The selected media fit is not supported.')
  }

  const quality = settings.quality ?? '720p'
  if (!(quality in FRAME_SIZES)) {
    throw new Error('The selected export quality is not supported.')
  }

  const prepared: PreparedMedia[] = []
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let recordingResult: Promise<Blob> | null = null
  let recordingError: Error | null = null

  try {
    for (const item of items) {
      prepared.push(await prepareItem(item))
    }

    const totalDuration = prepared.reduce(
      (duration, media) => duration + media.duration,
      0,
    )
    const dimensions = FRAME_SIZES[quality][settings.aspectRatio]
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: false,
    })

    if (!context) {
      throw new Error('Could not create the video rendering canvas.')
    }

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.fillStyle = settings.background
    context.fillRect(0, 0, canvas.width, canvas.height)

    stream = canvas.captureStream(FRAME_RATE)
    const mimeType = getSupportedWebMMimeType()
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: quality === '1080p' ? 10_000_000 : 6_000_000,
    })

    const chunks: BlobPart[] = []
    recordingResult = new Promise<Blob>((resolve, reject) => {
      recorder!.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      recorder!.onerror = (event) => {
        const recorderEvent = event as Event & { error?: DOMException }
        recordingError =
          recorderEvent.error ?? new Error('The video encoder stopped unexpectedly.')
        reject(recordingError)
      }

      recorder!.onstop = () => {
        if (recordingError) {
          reject(recordingError)
          return
        }

        if (!chunks.length) {
          reject(new Error('The video encoder did not produce any data.'))
          return
        }

        resolve(
          new Blob(chunks, {
            type: recorder?.mimeType || mimeType,
          }),
        )
      }
    })
    // Prevent an encoder error from becoming an unhandled rejection while the
    // render loop advances to its next frame and observes recordingError.
    void recordingResult.catch(() => undefined)

    recorder.start(250)

    let completedDuration = 0
    const updateTimelineProgress = (itemProgress: number) => {
      const currentDuration =
        prepared[Math.min(prepared.length - 1, currentMediaIndex)].duration
      reportProgress(
        (completedDuration + currentDuration * itemProgress) / totalDuration,
      )
    }
    let currentMediaIndex = 0

    for (currentMediaIndex = 0; currentMediaIndex < prepared.length; currentMediaIndex++) {
      const media = prepared[currentMediaIndex]
      const startedAt = performance.now()

      if (media.element instanceof HTMLImageElement) {
        while (true) {
          if (recordingError) {
            throw recordingError
          }

          const elapsed = Math.min(
            media.duration,
            (performance.now() - startedAt) / 1_000,
          )
          drawMedia(
            context,
            media.element,
            media.width,
            media.height,
            settings,
          )
          updateTimelineProgress(elapsed / media.duration)

          if (elapsed >= media.duration) {
            break
          }

          await nextAnimationFrame()
        }
      } else {
        const video = media.element
        video.currentTime = 0

        try {
          await video.play()
        } catch (error) {
          throw new Error(
            `Could not play "${media.item.name}" during export.`,
            { cause: error },
          )
        }

        while (true) {
          if (recordingError) {
            throw recordingError
          }

          const elapsed = Math.min(
            media.duration,
            (performance.now() - startedAt) / 1_000,
          )
          drawMedia(context, video, media.width, media.height, settings)
          updateTimelineProgress(elapsed / media.duration)

          if (elapsed >= media.duration || video.ended) {
            break
          }

          await nextAnimationFrame()
        }

        video.pause()
      }

      completedDuration += media.duration
      reportProgress(completedDuration / totalDuration)
    }

    if (recorder.state !== 'inactive') {
      // Give short reels enough time to flush an encoded keyframe before stop.
      // Some Chromium builds otherwise produce an empty recording under one
      // second even though the canvas stream rendered successfully.
      await delay(120)
      recorder.requestData()
      await delay(120)
      recorder.stop()
    }

    const blob = await recordingResult
    reportProgress(1)
    return blob
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // The original error is more useful than a cleanup failure.
      }
    }

    if (recordingResult) {
      await recordingResult.catch(() => undefined)
    }

    throw toError(error, 'Could not export the showreel.')
  } finally {
    stream?.getTracks().forEach((track) => track.stop())

    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
    }

    prepared.forEach((media) => cleanUpMediaElement(media.element))
  }
}
