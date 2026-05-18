import type { LocalCommandCall } from '../../types/command.js'
import { runMemoryDecay } from '../../memdir/memoryDecay.js'
import { getAutoMemPath } from '../../memdir/paths.js'

export const call: LocalCommandCall = async (args, _context) => {
  const dryRun = args.includes('--dry-run') || args.includes('-n')
  const autoMemPath = getAutoMemPath()

  const result = await runMemoryDecay(dryRun)

  const lines = [
    `Memory Decay Report`,
    `─────────────────`,
    `Directory: ${autoMemPath}`,
    `Mode: ${dryRun ? 'DRY RUN (no changes made)' : 'LIVE'}`,
    '',
    `Scanned: ${result.totalScanned} files`,
    `Preserved: ${result.preserved.length} files`,
    `${dryRun ? 'Would archive' : 'Archived'}: ${result.archived.length} files`,
    result.errors.length > 0 ? `Errors: ${result.errors.length}` : null,
    '',
  ].filter(Boolean)

  if (result.archived.length > 0) {
    lines.push(`${dryRun ? 'Files that would be archived' : 'Archived files'}:`)
    for (const f of result.archived) {
      lines.push(`  - ${f}`)
    }
    lines.push('')
  }

  if (result.errors.length > 0) {
    lines.push('Errors:')
    for (const e of result.errors) {
      lines.push(`  - ${e}`)
    }
    lines.push('')
  }

  const summary = result.archived.length === 0
    ? 'No stale memories found. Everything looks fresh!'
    : `${dryRun ? 'Would archive' : 'Archived'} ${result.archived.length} stale ${result.archived.length === 1 ? 'memory' : 'memories'} out of ${result.totalScanned} total.`

  lines.push(summary)
  lines.push('')
  lines.push('Config: set MEMORY_DECAY_DAYS and MEMORY_DECAY_MIN_REFS env vars to tune.')

  return {
    type: 'text',
    value: lines.join('\n'),
  }
}
