import type { Command } from '../../commands.js'

const decay = {
  type: 'local',
  name: 'decay',
  description: 'Archive stale memory files based on age and reference count',
  aliases: ['memory-decay'],
  argumentHint: '[--dry-run]',
  supportsNonInteractive: true,
  load: () => import('./decay.js'),
} satisfies Command

export default decay
