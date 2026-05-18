import { readdir, mkdir, readFile, writeFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { getAutoMemPath } from './paths.js'
import type { MemoryHeader } from './memoryScan.js'

const ARCHIVE_SUBDIR = '_archive'
const REFCOUNT_FILE = '_refcounts.json'
const DECAY_LOG_FILE = '_decay.log'
const DEFAULT_DECAY_DAYS = 30
const DEFAULT_MIN_REFS = 0

/**
 * Freshness score for a memory file. Higher = fresher / more relevant.
 * Based on: recency (mtime), reference count, and size penalty.
 */
export type FreshnessScore = {
  filePath: string
  score: number
  mtimeMs: number
  hitCount: number
  sizeBytes: number
  isArchived: boolean
}

/**
 * Result of a decay run — which files were archived and summary stats.
 */
export type DecayResult = {
  archived: string[]
  preserved: string[]
  skipped: string[]
  totalScanned: number
  dryRun: boolean
  errors: string[]
}

/**
 * Get the memory directory path (auto-memory, not CLAUDE.md files).
 */
function getMemoryDir(): string {
  const path = getAutoMemPath()
  return path.endsWith('/') || path.endsWith('\\') ? path : path + '/'
}

/**
 * Load reference counts from the JSON index file.
 * Returns empty object if file doesn't exist or is corrupted.
 */
async function loadRefCounts(memoryDir: string): Promise<Record<string, number>> {
  try {
    const raw = await readFile(join(memoryDir, REFCOUNT_FILE), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Persist reference counts to the JSON index file.
 */
async function saveRefCounts(
  memoryDir: string,
  refCounts: Record<string, number>,
): Promise<void> {
  await writeFile(
    join(memoryDir, REFCOUNT_FILE),
    JSON.stringify(refCounts, null, 2),
    'utf-8',
  )
}

/**
 * Record a memory file hit — increment its reference count.
 * Called by findRelevantMemories when a file is surfaced to the user.
 */
export async function recordMemoryHit(memoryDir: string, filePath: string): Promise<void> {
  const refCounts = await loadRefCounts(memoryDir)
  const relPath = basename(filePath)
  refCounts[relPath] = (refCounts[relPath] || 0) + 1
  await saveRefCounts(memoryDir, refCounts)
}

/**
 * Load accumulated hit counts for all memory files.
 */
export async function getMemoryHitCounts(memoryDir: string): Promise<Record<string, number>> {
  return loadRefCounts(memoryDir)
}

/**
 * Calculate a freshness score for a single memory file.
 *
 * Formula:
 *   score = recencyScore + hitScore - sizePenalty
 *
 * Where:
 *   recencyScore = max(0, 100 - daysSinceModified * 10)  — decays 10pts/day
 *   hitScore = log2(hitCount + 1) * 10                    — logarithmic growth
 *   sizePenalty = min(sizeBytes / 1024, 20)               — up to -20 for large files
 */
function calculateFreshness(
  mtimeMs: number,
  hitCount: number,
  sizeBytes: number,
): number {
  const now = Date.now()
  const ageMs = now - mtimeMs
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24))

  // Recency: starts at 100, drops 10 points per day, floor at 0
  const recencyScore = Math.max(0, 100 - ageDays * 10)

  // Hit score: log2(n+1) * 10, so 0→0, 1→10, 3→~16, 10→~33, 100→~66
  const hitScore = Math.log2(hitCount + 1) * 10

  // Size penalty: -1 per KB, capped at -20
  const sizePenalty = Math.min(sizeBytes / 1024, 20)

  return recencyScore + hitScore - sizePenalty
}

/**
 * Determine if a file is "stale" based on age AND hit count.
 * A file is stale when:
 *   - It's older than decayDays AND has fewer than minHits references
 *
 * Exception: never archive files that have been referenced recently
 * (hitCount > 0 and score > 30), even if old.
 */
function isStale(
  ageDays: number,
  hitCount: number,
  score: number,
  decayDays: number,
  minHits: number,
): boolean {
  // Well-referenced files are never stale regardless of age
  if (hitCount >= minHits + 5 && score > 50) return false
  // Never stale if actively referenced
  if (hitCount >= minHits && score > 30) return false
  // Old + under-referenced = stale
  return ageDays > decayDays && hitCount < minHits
}

/**
 * Scan all memory files and compute their freshness scores.
 * Skips MEMORY.md, archive directory, and internal index files.
 */
export async function scanFreshness(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<FreshnessScore[]> {
  const dir = getMemoryDir()
  try {
    const entries = await readdir(dir, { recursive: true, signal })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const refCounts = await loadRefCounts(dir)

    const results: FreshnessScore[] = []
    for (const relPath of mdFiles) {
      if (signal?.aborted) break
      // Skip archive and internal files
      const parts = relPath.split('/')
      if (parts.includes(ARCHIVE_SUBDIR)) continue
      if (basename(relPath) === REFCOUNT_FILE) continue
      if (basename(relPath) === DECAY_LOG_FILE) continue

      const filePath = join(dir, relPath)
      try {
        const s = await stat(filePath)
        const score = calculateFreshness(s.mtimeMs, refCounts[relPath] || 0, s.size)
        results.push({
          filePath,
          score,
          mtimeMs: s.mtimeMs,
          hitCount: refCounts[relPath] || 0,
          sizeBytes: s.size,
          isArchived: false,
        })
      } catch {
        // File disappeared between listing and stat — skip
      }
    }

    return results.sort((a, b) => b.score - a.score)
  } catch {
    return []
  }
}

/**
 * Run the memory decay pass on the auto-memory directory.
 *
 * Moves stale memory files into `_archive/` subdirectory.
 * Conservative by default: only archives, never deletes.
 *
 * @param dryRun — if true, only report what would happen
 * @returns decay report
 */
export async function runMemoryDecay(
  dryRun = false,
  signal?: AbortSignal,
): Promise<DecayResult> {
  const dir = getMemoryDir()
  const decayDays = parseInt(process.env.MEMORY_DECAY_DAYS ?? '', 10) || DEFAULT_DECAY_DAYS
  const minRefs = parseInt(process.env.MEMORY_DECAY_MIN_REFS ?? '', 10) || DEFAULT_MIN_REFS

  const freshness = await scanFreshness(dir, signal)
  const now = new Date().toISOString()

  const result: DecayResult = {
    archived: [],
    preserved: [],
    skipped: [],
    totalScanned: freshness.length,
    dryRun,
    errors: [],
  }

  const archiveDir = join(dir, ARCHIVE_SUBDIR)

  // Ensure archive directory exists
  if (!dryRun) {
    try {
      await mkdir(archiveDir, { recursive: true })
    } catch (e) {
      result.errors.push(`Failed to create archive dir: ${e}`)
      return result
    }
  }

  for (const f of freshness) {
    if (signal?.aborted) break

    const ageDays = (Date.now() - f.mtimeMs) / (1000 * 60 * 60 * 24)

    if (isStale(ageDays, f.hitCount, f.score, decayDays, minRefs)) {
      if (dryRun) {
        result.archived.push(`${basename(f.filePath)} (score: ${f.score.toFixed(1)}, age: ${ageDays.toFixed(0)}d, hits: ${f.hitCount})`)
      } else {
        try {
          const archiveName = join(archiveDir, basename(f.filePath))
          await renameFile(f.filePath, archiveName)
          result.archived.push(basename(f.filePath))
        } catch (e) {
          result.errors.push(`Failed to archive ${basename(f.filePath)}: ${e}`)
        }
      }
    } else {
      result.preserved.push(basename(f.filePath))
    }
  }

  // Write decay log
  if (!dryRun && !signal?.aborted) {
    try {
      const logEntry = `[${now}] archived=${result.archived.length} preserved=${result.preserved.length} errors=${result.errors.length}\n`
      await writeFile(join(dir, DECAY_LOG_FILE), logEntry, { flag: 'a', encoding: 'utf-8' })
    } catch {
      // Non-critical — don't fail the whole operation for logging
    }
  }

  return result
}

/**
 * Simple rename helper (cross-device fallback: read+write+unlink).
 */
async function renameFile(src: string, dest: string): Promise<void> {
  try {
    await renameInternal(src, dest)
  } catch {
    // Fallback for cross-device rename
    const data = await readFile(src, 'utf-8')
    await writeFile(dest, data, 'utf-8')
    await unlinkFile(src)
  }
}

function renameInternal(src: string, dest: string): Promise<void>
function renameInternal(src: string, dest: string): Promise<void> {
  // @ts-expect-error — Node.js rename is available
  return import('fs/promises').then(mod => mod.rename(src, dest))
}

function unlinkFile(path: string): Promise<void> {
  // @ts-expect-error — Node.js unlink is available
  return import('fs/promises').then(mod => mod.unlink(path))
}
