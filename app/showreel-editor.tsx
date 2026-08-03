'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react'

export type ShowreelItem = {
  id: string
  name: string
  type: 'image' | 'video'
  src: string
  file: File
  duration: number
}

export type ShowreelSettings = {
  background: string
  padding: number
  fit: 'contain' | 'cover'
  aspectRatio: '16:9' | '4:3' | '1:1' | '9:16'
}

type DropPosition = 'before' | 'after'
type ExportQuality = '720p' | '1080p'

const DEFAULT_IMAGE_DURATION = 0.3
const MIN_DURATION = 0.1
const MAX_DURATION = 3
const DEFAULT_VIDEO_DURATION = MAX_DURATION
const HEIC_CONVERTER_SRC =
  'https://cdn.jsdelivr.net/npm/heic-to@1.4.2/dist/iife/heic-to.js'
const MEDIA_DATABASE_NAME = 'showreel-media'
const MEDIA_DATABASE_VERSION = 1
const MEDIA_STORE_NAME = 'sequence-items'

type StoredShowreelItem = {
  id: string
  name: string
  type: ShowreelItem['type']
  blob: Blob
  duration: number
  order: number
  lastModified: number
}

type HeicConverter = (options: {
  blob: Blob
  type: 'image/jpeg'
  quality: number
}) => Promise<Blob | Blob[]>

let heicConverterPromise: Promise<HeicConverter> | null = null

const BACKGROUNDS = [
  { label: 'Paper', value: '#ffffff' },
  { label: 'Ink', value: '#111111' },
]

const ASPECT_VALUES: Record<ShowreelSettings['aspectRatio'], string> = {
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '1:1': '1 / 1',
  '9:16': '9 / 16',
}

function AddIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m6 6 8 8M14 6l-8 8" />
    </svg>
  )
}

function PlayIcon({ paused = false }: { paused?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      {paused ? (
        <>
          <path d="M7 5v10M13 5v10" />
        </>
      ) : (
        <path d="m7 5 8 5-8 5V5Z" />
      )}
    </svg>
  )
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, Math.floor(seconds % 60))
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function createItemId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `media-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isHeicFile(file: File) {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name)
  )
}

function isSupportedMediaFile(file: File) {
  return (
    isHeicFile(file) ||
    file.type.startsWith('image/') ||
    file.type.startsWith('video/')
  )
}

function loadHeicConverter() {
  const converterWindow = window as Window & { HeicTo?: HeicConverter }
  if (converterWindow.HeicTo) return Promise.resolve(converterWindow.HeicTo)
  if (heicConverterPromise) return heicConverterPromise

  heicConverterPromise = new Promise<HeicConverter>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = HEIC_CONVERTER_SRC
    script.async = true
    script.dataset.heicConverter = 'true'
    script.onload = () => {
      if (converterWindow.HeicTo) {
        resolve(converterWindow.HeicTo)
      } else {
        reject(new Error('The HEIC converter did not initialize.'))
      }
    }
    script.onerror = () => reject(new Error('The HEIC converter could not load.'))
    document.head.appendChild(script)
  }).catch((error) => {
    heicConverterPromise = null
    throw error
  })

  return heicConverterPromise
}

async function prepareMediaFile(file: File) {
  if (!isHeicFile(file)) return file

  const convertHeic = await loadHeicConverter()
  const converted = await convertHeic({
    blob: file,
    type: 'image/jpeg',
    quality: 0.92,
  })
  const jpeg = Array.isArray(converted) ? converted[0] : converted

  if (!jpeg) throw new Error(`Could not convert ${file.name}.`)

  return new File([jpeg], file.name.replace(/\.(heic|heif)$/i, '.jpg'), {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  })
}

function openMediaDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(
      MEDIA_DATABASE_NAME,
      MEDIA_DATABASE_VERSION,
    )

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        database.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadStoredItems() {
  const database = await openMediaDatabase()

  try {
    return await new Promise<StoredShowreelItem[]>((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE_NAME, 'readonly')
      const request = transaction.objectStore(MEDIA_STORE_NAME).getAll()

      request.onsuccess = () => {
        resolve(
          (request.result as StoredShowreelItem[]).sort(
            (first, second) => first.order - second.order,
          ),
        )
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

async function storeItems(items: ShowreelItem[]) {
  const database = await openMediaDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(MEDIA_STORE_NAME)

      store.clear()
      items.forEach((item, order) => {
        const storedItem: StoredShowreelItem = {
          id: item.id,
          name: item.name,
          type: item.type,
          blob: item.file,
          duration: item.duration,
          order,
          lastModified: item.file.lastModified,
        }
        store.put(storedItem)
      })

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export default function ShowreelEditor() {
  const [items, setItems] = useState<ShowreelItem[]>([])
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_DURATION)
  const [hasLoadedStoredItems, setHasLoadedStoredItems] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: DropPosition
  } | null>(null)
  const [settings, setSettings] = useState<ShowreelSettings>({
    background: '#ffffff',
    padding: 56,
    fit: 'contain',
    aspectRatio: '16:9',
  })
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [isInspectorOpen, setIsInspectorOpen] = useState(false)
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false)
  const [status, setStatus] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const elapsedRef = useRef(0)
  const objectUrlsRef = useRef(new Set<string>())

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [activeId, items],
  )
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null
  const selectedItem =
    items.find((item) => item.id === selectedId) ?? activeItem
  const selectedDuration =
    selectedItem?.type === 'image' ? imageDuration : selectedItem?.duration
  const totalDuration = items.reduce((total, item) => total + item.duration, 0)
  const elapsedBeforeActive = items
    .slice(0, Math.max(activeIndex, 0))
    .reduce((total, item) => total + item.duration, 0)
  const totalElapsed = elapsedBeforeActive + elapsed
  const overallProgress =
    totalDuration > 0 ? Math.min(100, (totalElapsed / totalDuration) * 100) : 0

  useLayoutEffect(() => {
    if (!isInspectorOpen) return

    const stage = stageRef.current
    const inspector = inspectorRef.current
    if (!stage || !inspector) return

    const positionInspector = () => {
      if (window.matchMedia('(max-width: 900px)').matches) return

      const stageBounds = stage.getBoundingClientRect()
      inspector.style.setProperty(
        '--sr-inspector-top',
        `${stageBounds.top}px`,
      )
    }

    const resizeObserver = new ResizeObserver(positionInspector)
    resizeObserver.observe(stage)
    window.addEventListener('resize', positionInspector)
    positionInspector()

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', positionInspector)
    }
  }, [isInspectorOpen])

  useEffect(() => {
    let cancelled = false

    const restoreItems = async () => {
      try {
        const storedItems = await loadStoredItems()
        if (cancelled) return

        const storedImageDuration = storedItems.find(
          (item) => item.type === 'image',
        )?.duration
        const restoredImageDuration = Math.min(
          MAX_DURATION,
          Math.max(MIN_DURATION, storedImageDuration ?? DEFAULT_IMAGE_DURATION),
        )
        const restoredItems = storedItems.map((item): ShowreelItem => {
          const file = new File([item.blob], item.name, {
            type: item.blob.type,
            lastModified: item.lastModified,
          })
          const src = URL.createObjectURL(file)
          objectUrlsRef.current.add(src)

          return {
            id: item.id,
            name: item.name,
            type: item.type,
            src,
            file,
            duration:
              item.type === 'image' ? restoredImageDuration : item.duration,
          }
        })

        setImageDuration(restoredImageDuration)
        setItems(restoredItems)
        setSelectedId(restoredItems[0]?.id ?? null)
        setActiveId(restoredItems[0]?.id ?? null)
        if (restoredItems.length > 0) {
          setStatus(
            `${restoredItems.length} ${
              restoredItems.length === 1 ? 'item' : 'items'
            } restored.`,
          )
        }
      } catch (error) {
        console.error(error)
        if (!cancelled) {
          setStatus('Saved media could not be restored in this browser.')
        }
      } finally {
        if (!cancelled) setHasLoadedStoredItems(true)
      }
    }

    void restoreItems()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hasLoadedStoredItems) return

    const timeout = window.setTimeout(() => {
      void storeItems(items).catch((error) => {
        console.error(error)
        setStatus('Media could not be saved for the next reload.')
      })
    }, 200)

    return () => window.clearTimeout(timeout)
  }, [hasLoadedStoredItems, items])

  const setPlaybackElapsed = useCallback((value: number) => {
    elapsedRef.current = value
    setElapsed(value)
  }, [])

  const updateItem = useCallback(
    (id: string, updates: Partial<Pick<ShowreelItem, 'duration'>>) => {
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, ...updates } : item,
        ),
      )
    },
    [],
  )

  const updateImageDuration = useCallback((duration: number) => {
    const nextDuration = Math.min(
      MAX_DURATION,
      Math.max(MIN_DURATION, duration),
    )

    setImageDuration(nextDuration)
    setItems((current) =>
      current.map((item) =>
        item.type === 'image'
          ? { ...item, duration: nextDuration }
          : item,
      ),
    )
  }, [])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const supportedFiles = Array.from(files).filter(isSupportedMediaFile)

      if (supportedFiles.length === 0) {
        setStatus('Choose image or video files to add to your showreel.')
        return
      }

      const heicCount = supportedFiles.filter(isHeicFile).length
      if (heicCount > 0) {
        setStatus(
          `Converting ${heicCount} HEIC ${heicCount === 1 ? 'image' : 'images'}…`,
        )
      }

      const preparedResults = await Promise.allSettled(
        supportedFiles.map(prepareMediaFile),
      )
      const preparedFiles = preparedResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      const failedCount = preparedResults.length - preparedFiles.length

      if (preparedFiles.length === 0) {
        setStatus('The HEIC image could not be converted. Please try again.')
        return
      }

      const additions = preparedFiles.map((file): ShowreelItem => {
        const src = URL.createObjectURL(file)
        objectUrlsRef.current.add(src)
        return {
          id: createItemId(),
          name: file.name,
          type: file.type.startsWith('video/') ? 'video' : 'image',
          src,
          file,
          duration: file.type.startsWith('video/')
            ? DEFAULT_VIDEO_DURATION
            : imageDuration,
        }
      })

      setItems((current) => [...current, ...additions])
      setSelectedId((current) => current ?? additions[0].id)
      setActiveId((current) => current ?? additions[0].id)
      setStatus(
        `${additions.length} ${additions.length === 1 ? 'item' : 'items'} added.${
          failedCount > 0 ? ` ${failedCount} could not be converted.` : ''
        }`,
      )
    },
    [imageDuration],
  )

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .filter((file) => isHeicFile(file) || file.type.startsWith('image/'))

      if (imageFiles.length === 0) return

      event.preventDefault()
      void addFiles(imageFiles)
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [addFiles])

  useEffect(() => {
    if (!isExportMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !exportMenuRef.current?.contains(event.target)
      ) {
        setIsExportMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExportMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isExportMenuOpen])

  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
    }
  }, [])

  const advance = useCallback(() => {
    if (items.length === 0) {
      setIsPlaying(false)
      return
    }

    const currentIndex = items.findIndex((item) => item.id === activeId)
    if (currentIndex < 0 || currentIndex >= items.length - 1) {
      setIsPlaying(false)
      setPlaybackElapsed(items[Math.max(currentIndex, 0)]?.duration ?? 0)
      return
    }

    const next = items[currentIndex + 1]
    setActiveId(next.id)
    setSelectedId(next.id)
    setPlaybackElapsed(0)
  }, [activeId, items, setPlaybackElapsed])

  useEffect(() => {
    if (!isPlaying || !activeItem || activeItem.type !== 'image') return

    const startedAt = performance.now() - elapsedRef.current * 1_000
    let frame = 0

    const tick = (now: number) => {
      const nextElapsed = (now - startedAt) / 1_000
      if (nextElapsed >= activeItem.duration) {
        setPlaybackElapsed(activeItem.duration)
        advance()
        return
      }
      setPlaybackElapsed(nextElapsed)
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [activeItem, advance, isPlaying, setPlaybackElapsed])

  useEffect(() => {
    if (!activeItem || activeItem.type !== 'video' || !videoRef.current) return

    if (isPlaying) {
      void videoRef.current.play().catch(() => {
        setIsPlaying(false)
        setStatus('Playback was blocked. Press play to try again.')
      })
    } else {
      videoRef.current.pause()
    }
  }, [activeItem, isPlaying])

  const selectItem = (id: string) => {
    setIsPlaying(false)
    setSelectedId(id)
    setActiveId(id)
    setPlaybackElapsed(0)
  }

  const togglePlayback = useCallback(() => {
    if (items.length === 0) {
      fileInputRef.current?.click()
      return
    }

    const isAtEnd =
      activeIndex === items.length - 1 &&
      activeItem &&
      elapsedRef.current >= activeItem.duration - 0.05

    if (!isPlaying && isAtEnd) {
      setActiveId(items[0].id)
      setSelectedId(items[0].id)
      setPlaybackElapsed(0)
    }
    setIsPlaying((current) => !current)
  }, [activeIndex, activeItem, isPlaying, items, setPlaybackElapsed])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || items.length === 0) return

      const target = event.target
      const interactiveTarget =
        target instanceof HTMLElement
          ? target.closest('input, textarea, select, [contenteditable], button')
          : null

      if (
        interactiveTarget &&
        !interactiveTarget.hasAttribute('data-space-playback')
      ) {
        return
      }

      event.preventDefault()
      togglePlayback()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [items.length, togglePlayback])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 't' ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }

      const target = event.target
      const interactiveTarget =
        target instanceof HTMLElement
          ? target.closest('input, textarea, select, [contenteditable]')
          : null

      if (interactiveTarget) return

      setIsInspectorOpen((current) => !current)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'e' ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        items.length === 0 ||
        isExporting
      ) {
        return
      }

      const target = event.target
      const interactiveTarget =
        target instanceof HTMLElement
          ? target.closest('input, textarea, select, [contenteditable]')
          : null

      if (interactiveTarget) return

      setIsExportMenuOpen((current) => !current)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExporting, items.length])

  const reorderItem = (targetId: string, position: DropPosition) => {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null)
      setDropTarget(null)
      return
    }

    setItems((current) => {
      const from = current.findIndex((item) => item.id === draggedId)
      const targetIndex = current.findIndex((item) => item.id === targetId)
      if (from < 0 || targetIndex < 0) return current

      let insertionIndex =
        position === 'before' ? targetIndex : targetIndex + 1

      const reordered = [...current]
      const [moved] = reordered.splice(from, 1)
      if (from < insertionIndex) insertionIndex -= 1
      reordered.splice(insertionIndex, 0, moved)
      return reordered
    })
    setDraggedId(null)
    setDropTarget(null)
  }

  const deleteItem = (id: string) => {
    const deletedIndex = items.findIndex((item) => item.id === id)
    if (deletedIndex < 0) return

    const deletedItem = items[deletedIndex]
    const remainingItems = items.filter((item) => item.id !== id)
    const fallbackItem =
      remainingItems[Math.min(deletedIndex, remainingItems.length - 1)] ?? null

    setItems(remainingItems)
    setDraggedId((current) => (current === id ? null : current))
    setDropTarget((current) => (current?.id === id ? null : current))

    if (objectUrlsRef.current.delete(deletedItem.src)) {
      URL.revokeObjectURL(deletedItem.src)
    }

    if (!fallbackItem) {
      setIsPlaying(false)
      setSelectedId(null)
      setActiveId(null)
      setPlaybackElapsed(0)
      setIsInspectorOpen(false)
      setStatus('Sequence cleared.')
      return
    }

    if (selectedId === id) setSelectedId(fallbackItem.id)
    if (activeId === id) {
      setIsPlaying(false)
      setActiveId(fallbackItem.id)
      setPlaybackElapsed(0)
    }
    setStatus(`${deletedItem.name} removed from the sequence.`)
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setIsDragOver(false)
    if (event.dataTransfer.files.length > 0) {
      void addFiles(event.dataTransfer.files)
    }
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) void addFiles(event.currentTarget.files)
    event.currentTarget.value = ''
  }

  const handleVideoMetadata = () => {
    if (!activeItem || activeItem.type !== 'video' || !videoRef.current) return
    const naturalDuration = videoRef.current.duration
    if (!Number.isFinite(naturalDuration) || naturalDuration <= 0) return

    if (Math.abs(activeItem.duration - DEFAULT_VIDEO_DURATION) < 0.001) {
      updateItem(activeItem.id, {
        duration: Math.min(
          MAX_DURATION,
          Math.max(0.5, Math.round(naturalDuration * 10) / 10),
        ),
      })
    }
  }

  const handleVideoTime = () => {
    if (!activeItem || !videoRef.current) return
    const nextElapsed = videoRef.current.currentTime
    setPlaybackElapsed(Math.min(nextElapsed, activeItem.duration))
    if (isPlaying && nextElapsed >= activeItem.duration) {
      advance()
    }
  }

  const runExport = async (
    intent: 'download' | 'share',
    quality: ExportQuality,
  ) => {
    if (items.length === 0 || isExporting) return

    setIsExporting(true)
    setExportProgress(0)
    setStatus('Preparing your showreel…')

    try {
      const { exportShowreel } = await import('./lib/export-showreel')
      const blob = await exportShowreel(
        items,
        { ...settings, quality },
        (progress: number) => {
          const normalized = progress > 1 ? progress : progress * 100
          setExportProgress(Math.min(100, Math.max(0, normalized)))
        },
      )
      const extension = blob.type.includes('mp4') ? 'mp4' : 'webm'
      const filename = `showreel.${extension}`
      const file = new File([blob], filename, { type: blob.type })
      const canShare =
        intent === 'share' &&
        typeof navigator.share === 'function' &&
        (typeof navigator.canShare !== 'function' ||
          navigator.canShare({ files: [file] }))

      if (canShare) {
        await navigator.share({
          files: [file],
          title: 'Showreel',
          text: 'A showreel of my work.',
        })
        setStatus('Showreel shared.')
      } else {
        downloadBlob(blob, filename)
        setStatus(
          intent === 'share'
            ? 'Sharing is unavailable here, so your showreel was downloaded.'
            : 'Showreel downloaded.',
        )
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('Sharing cancelled.')
      } else {
        console.error(error)
        setStatus('The export could not be completed. Please try again.')
      }
    } finally {
      setIsExporting(false)
    }
  }

  const stageStyle = {
    '--sr-stage-color': settings.background,
    '--sr-stage-padding': `${settings.padding}px`,
    aspectRatio: ASPECT_VALUES[settings.aspectRatio],
  } as CSSProperties

  return (
    <section
      className={`sr-editor${items.length === 0 ? ' sr-editor-empty' : ''}`}
      aria-label="Showreel editor"
    >
      <input
        ref={fileInputRef}
        className="sr-file-input"
        type="file"
        accept="image/*,video/*,.heic,.heif,image/heic,image/heif"
        multiple
        onChange={handleFileInput}
      />

      <div className="sr-workspace sr-workspace-canvas-only">
        <main className="sr-main">
          <div className="sr-preview-area">
            <div className="sr-stage-slot">
              {items.length > 0 && (
                <button
                  className={`sr-frame-control sr-frame-toolbar${
                    isInspectorOpen ? ' sr-frame-toolbar-active' : ''
                  }`}
                  type="button"
                  aria-expanded={isInspectorOpen}
                  onClick={() => setIsInspectorOpen((current) => !current)}
                >
                  Toolbar <span aria-hidden="true">(t)</span>
                </button>
              )}
              <div
                ref={stageRef}
                className={`sr-stage${isDragOver ? ' sr-stage-dragging' : ''}${
                  items.length === 0 ? ' sr-stage-empty' : ''
                }`}
                data-ratio={settings.aspectRatio}
                style={stageStyle}
                onDragEnter={(event) => {
                  event.preventDefault()
                  if (event.dataTransfer.types.includes('Files')) {
                    setIsDragOver(true)
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setIsDragOver(false)
                  }
                }}
                onDrop={handleDrop}
              >
                {activeItem ? (
                  <div className="sr-stage-media">
                    {activeItem.type === 'image' ? (
                      // Object URLs are intentionally rendered with a native image.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={activeItem.src}
                        alt={activeItem.name}
                        draggable={false}
                        style={{ objectFit: settings.fit }}
                      />
                    ) : (
                      <video
                        key={activeItem.id}
                        ref={videoRef}
                        src={activeItem.src}
                        aria-label={activeItem.name}
                        muted
                        playsInline
                        preload="metadata"
                        style={{ objectFit: settings.fit }}
                        onLoadedMetadata={handleVideoMetadata}
                        onTimeUpdate={handleVideoTime}
                        onEnded={advance}
                      />
                    )}
                  </div>
                ) : (
                  <button
                    className="sr-empty-prompt"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span className="sr-empty-title">Drop images or clips</span>
                    <span className="sr-empty-copy">or click to browse</span>
                  </button>
                )}
                {isDragOver && (
                  <div className="sr-drop-overlay" aria-hidden="true">
                    Drop to add
                  </div>
                )}
                {items.length > 0 && (
                  <button
                    className="sr-frame-play"
                    type="button"
                    aria-label={isPlaying ? 'Pause showreel' : 'Play showreel'}
                    aria-pressed={isPlaying}
                    data-space-playback
                    onClick={togglePlayback}
                  >
                    <PlayIcon paused={isPlaying} />
                  </button>
                )}
              </div>
              {items.length > 0 && (
                <div className="sr-export sr-frame-export" ref={exportMenuRef}>
                  <button
                    className={`sr-frame-control sr-frame-export-trigger${
                      isExportMenuOpen ? ' sr-frame-export-trigger-active' : ''
                    }`}
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={isExportMenuOpen}
                    disabled={isExporting}
                    onClick={() => setIsExportMenuOpen((current) => !current)}
                  >
                    {isExporting
                      ? `Exporting ${Math.round(exportProgress)}%`
                      : <>
                          Export <span aria-hidden="true">(e)</span>
                        </>}
                  </button>
                  {isExportMenuOpen && (
                    <div className="sr-export-menu" role="menu">
                      <button
                        className="sr-export-option"
                        type="button"
                        role="menuitem"
                        disabled={isExporting}
                        onClick={() => {
                          setIsExportMenuOpen(false)
                          void runExport('download', '720p')
                        }}
                      >
                        <span>Download standard</span>
                        <span className="sr-export-option-meta">720p</span>
                      </button>
                      <button
                        className="sr-export-option"
                        type="button"
                        role="menuitem"
                        disabled={isExporting}
                        onClick={() => {
                          setIsExportMenuOpen(false)
                          void runExport('download', '1080p')
                        }}
                      >
                        <span>Download high quality</span>
                        <span className="sr-export-option-meta">1080p</span>
                      </button>
                      <button
                        className="sr-export-option"
                        type="button"
                        role="menuitem"
                        disabled={isExporting}
                        onClick={() => {
                          setIsExportMenuOpen(false)
                          void runExport('share', '1080p')
                        }}
                      >
                        <span>Share video</span>
                        <span className="sr-export-option-meta">1080p</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="sr-playback">
            <button
              className="sr-icon-button sr-play-button"
              type="button"
              aria-label={isPlaying ? 'Pause showreel' : 'Play showreel'}
              onClick={togglePlayback}
            >
              <PlayIcon paused={isPlaying} />
            </button>
            <span className="sr-time">
              {formatTime(totalElapsed)} / {formatTime(totalDuration)}
            </span>
            <div
              className="sr-progress"
              role="progressbar"
              aria-label="Showreel playback"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(overallProgress)}
            >
              <span
                className="sr-progress-fill"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>

          <section className="sr-timeline-section" aria-labelledby="timeline-title">
            <div className="sr-section-heading">
              <div>
                <h2 id="timeline-title">Sequence</h2>
                <span>{items.length} items</span>
              </div>
            </div>

            {items.length > 0 ? (
              <ol className="sr-timeline" aria-label="Showreel sequence">
                {items.map((item, index) => (
                  <li
                    key={item.id}
                    className={`sr-timeline-item${
                      selectedId === item.id ? ' sr-timeline-item-selected' : ''
                    }${activeId === item.id ? ' sr-timeline-item-active' : ''}${
                      dropTarget?.id === item.id
                        ? ` sr-drop-${dropTarget.position}`
                        : ''
                    }`}
                    draggable
                    onDragStart={(event) => {
                      setDraggedId(item.id)
                      setDropTarget(null)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', item.id)
                    }}
                    onDragEnd={() => {
                      setDraggedId(null)
                      setDropTarget(null)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      const bounds =
                        event.currentTarget.getBoundingClientRect()
                      const position =
                        event.clientX < bounds.left + bounds.width / 2
                          ? 'before'
                          : 'after'
                      setDropTarget((current) =>
                        current?.id === item.id &&
                        current.position === position
                          ? current
                          : { id: item.id, position },
                      )
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node,
                        )
                      ) {
                        setDropTarget((current) =>
                          current?.id === item.id ? null : current,
                        )
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const bounds =
                        event.currentTarget.getBoundingClientRect()
                      const position =
                        event.clientX < bounds.left + bounds.width / 2
                          ? 'before'
                          : 'after'
                      reorderItem(item.id, position)
                    }}
                  >
                    <button
                      className="sr-timeline-select"
                      type="button"
                      aria-pressed={selectedId === item.id}
                      aria-label={`Select ${item.name}, item ${index + 1}`}
                      onClick={() => selectItem(item.id)}
                    >
                      <span className="sr-thumbnail">
                        {item.type === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.src} alt="" draggable={false} />
                        ) : (
                          <video
                            src={item.src}
                            aria-hidden="true"
                            muted
                            preload="metadata"
                          />
                        )}
                      </span>
                    </button>
                    <button
                      className="sr-timeline-delete"
                      type="button"
                      aria-label={`Remove ${item.name} from sequence`}
                      draggable={false}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        deleteItem(item.id)
                      }}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
                <li className="sr-timeline-add">
                  <button
                    type="button"
                    aria-label="Add more images or clips"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <AddIcon />
                  </button>
                </li>
              </ol>
            ) : (
              <p className="sr-timeline-empty">
                Your sequence will appear here after you add media.
              </p>
            )}
          </section>
        </main>

        <aside
          ref={inspectorRef}
          className={`sr-inspector${
            isInspectorOpen ? ' sr-inspector-open' : ''
          }`}
          aria-label="Showreel settings"
          aria-hidden={!isInspectorOpen}
        >
          <section className="sr-inspector-section">
            <fieldset className="sr-control sr-color-control">
              <legend>Background</legend>
              <div className="sr-swatches">
                {BACKGROUNDS.map((background) => (
                  <button
                    key={background.value}
                    className={`sr-swatch${
                      settings.background === background.value
                        ? ' sr-swatch-selected'
                        : ''
                    }`}
                    type="button"
                    aria-label={`${background.label} background`}
                    aria-pressed={settings.background === background.value}
                    style={{ backgroundColor: background.value }}
                    onClick={() =>
                      setSettings((current) => ({
                        ...current,
                        background: background.value,
                      }))
                    }
                  />
                ))}
                <label className="sr-color-picker">
                  <span className="sr-visually-hidden">
                    Custom background color
                  </span>
                  <input
                    type="color"
                    value={settings.background}
                    onChange={(event) => {
                      const background = event.currentTarget.value
                      setSettings((current) => ({
                        ...current,
                        background,
                      }))
                    }}
                  />
                  <span aria-hidden="true">+</span>
                </label>
              </div>
            </fieldset>

            <div className="sr-control">
              <div className="sr-control-label">
                <label htmlFor="sr-padding">Padding</label>
                <output htmlFor="sr-padding">{settings.padding}px</output>
              </div>
              <input
                id="sr-padding"
                type="range"
                min="0"
                max="120"
                step="4"
                value={settings.padding}
                style={
                  {
                    '--sr-range-progress': `${(settings.padding / 120) * 100}%`,
                  } as CSSProperties
                }
                onChange={(event) => {
                  const padding = Number(event.currentTarget.value)
                  setSettings((current) => ({
                    ...current,
                    padding,
                  }))
                }}
              />
            </div>

            <fieldset className="sr-control">
              <legend>Fit</legend>
              <div className="sr-segmented">
                {(['contain', 'cover'] as const).map((fit) => (
                  <button
                    key={fit}
                    type="button"
                    aria-pressed={settings.fit === fit}
                    className={settings.fit === fit ? 'sr-selected' : undefined}
                    onClick={() =>
                      setSettings((current) => ({ ...current, fit }))
                    }
                  >
                    {fit === 'contain' ? 'Fit' : 'Fill'}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="sr-control">
              <legend>Aspect ratio</legend>
              <div className="sr-segmented">
                {(['16:9', '4:3', '1:1', '9:16'] as const).map((aspectRatio) => (
                  <button
                    key={aspectRatio}
                    type="button"
                    aria-pressed={settings.aspectRatio === aspectRatio}
                    className={
                      settings.aspectRatio === aspectRatio
                        ? 'sr-selected'
                        : undefined
                    }
                    onClick={() =>
                      setSettings((current) => ({ ...current, aspectRatio }))
                    }
                  >
                    {aspectRatio}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>

          <section className="sr-inspector-section">
            {selectedItem ? (
              <div className="sr-control">
                <div className="sr-control-label">
                  <label htmlFor="sr-duration">
                    {selectedItem.type === 'image'
                      ? 'Image duration'
                      : 'Clip duration'}
                  </label>
                  <output htmlFor="sr-duration">
                    {selectedDuration?.toFixed(1)}s
                  </output>
                </div>
                <input
                  id="sr-duration"
                  type="range"
                  min={MIN_DURATION}
                  max={MAX_DURATION}
                  step="0.1"
                  value={selectedDuration}
                  style={
                    {
                      '--sr-range-progress': `${
                        (((selectedDuration ?? MIN_DURATION) - MIN_DURATION) /
                          (MAX_DURATION - MIN_DURATION)) *
                          100
                      }%`,
                    } as CSSProperties
                  }
                  onChange={(event) => {
                    const duration = Number(event.currentTarget.value)

                    if (selectedItem.type === 'image') {
                      updateImageDuration(duration)
                      return
                    }

                    updateItem(selectedItem.id, { duration })
                  }}
                />
              </div>
            ) : (
              <p className="sr-inspector-empty">Select an item to edit it.</p>
            )}
          </section>
        </aside>
      </div>

      <p className="sr-status sr-visually-hidden" aria-live="polite">
        {status}
      </p>
    </section>
  )
}
