import type { CollectionSchema } from 'deepspace/schema'

export const huntsSchema: CollectionSchema = {
  name: 'hunts',
  columns: [
    { name: 'designer', storage: 'text', interpretation: 'plain', required: true, maxLength: 80 },
    { name: 'piece', storage: 'text', interpretation: 'plain', required: true, maxLength: 120 },
    { name: 'season', storage: 'text', interpretation: 'plain', maxLength: 20 },
    { name: 'size', storage: 'text', interpretation: 'plain', maxLength: 20 },
    {
      name: 'maxPriceUsd',
      storage: 'number',
      interpretation: { kind: 'currency', symbol: '$', decimals: 0 },
    },
    { name: 'refPhotoKey', storage: 'text', interpretation: 'plain' },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['idle', 'scanning', 'done', 'failed'] },
      default: 'idle',
    },
    { name: 'lastScannedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: {
      read: 'own',
      create: true,
      update: 'own',
      delete: 'own',
      writableFields: ['designer', 'piece', 'season', 'size', 'maxPriceUsd', 'refPhotoKey'],
    },
    admin: {
      read: 'own',
      create: true,
      update: 'own',
      delete: 'own',
      writableFields: ['designer', 'piece', 'season', 'size', 'maxPriceUsd', 'refPhotoKey'],
    },
  },
}