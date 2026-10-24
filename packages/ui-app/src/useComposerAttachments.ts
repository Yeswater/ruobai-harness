import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentMeta } from '@ruobai/chat-protocol'
import {
  filesToAttachments, folderManifest, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, totalSize,
} from './attachments.ts'

export function useComposerAttachments(sessionId?: string) {
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<AttachmentMeta[]>([])

  useEffect(() => {
    latest.current = attachments
  }, [attachments])

  useEffect(() => {
    latest.current = []
    setAttachments([])
    setError(null)
  }, [sessionId])

  const append = useCallback((next: AttachmentMeta[]) => {
    if (!next.length) return
    const merged = [...latest.current, ...next]
    if (merged.length > MAX_ATTACHMENTS) {
      setError(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
      return
    }
    if (totalSize(merged) > MAX_TOTAL_BYTES) {
      setError('附件总大小超过 25 MB')
      return
    }
    latest.current = merged
    setAttachments(merged)
    setError(null)
  }, [])

  const addFiles = useCallback(async (files: Iterable<File>) => {
    try {
      const next = await filesToAttachments(files, latest.current)
      append(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [append])

  const addFolder = useCallback((files: FileList) => {
    try {
      if (!files.length) return
      append([folderManifest(files)])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [append])

  const addOne = useCallback((attachment: AttachmentMeta) => append([attachment]), [append])

  const remove = useCallback((id: string) => {
    const next = latest.current.filter(item => item.id !== id)
    latest.current = next
    setAttachments(next)
  }, [])

  const clear = useCallback(() => {
    latest.current = []
    setAttachments([])
  }, [])

  return { attachments, addFiles, addFolder, addOne, remove, clear, error, setError }
}
