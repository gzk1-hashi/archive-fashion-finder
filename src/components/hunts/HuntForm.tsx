/**
 * New-hunt form. Validates with the shared Zod contract, writes the row with
 * `createConfirmed` (resolves only once the RecordRoom has accepted it, so a
 * permission or validation refusal surfaces here instead of as a ghost row),
 * then hands the new id back so the caller can start the first scan.
 */

import { useState, type FormEvent } from 'react'
import { useMutations } from 'deepspace'
import { Button, Input, Label } from '@/components/ui'
import { HUNT_LIMITS } from '../../config'
import { fieldErrors, HuntInput, type HuntFormValues } from '../../lib/hunt-input'
import type { HuntData } from '../../types'

const EMPTY: HuntFormValues = { designer: '', piece: '', season: '', size: '', maxPriceUsd: '' }

interface Props {
  onCreated: (huntId: string) => void | Promise<void>
}

export function HuntForm({ onCreated }: Props) {
  const { createConfirmed, ready } = useMutations<HuntData>('hunts')
  const [values, setValues] = useState<HuntFormValues>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof HuntFormValues, string>>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof HuntFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [key]: e.target.value }))
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const parsed = HuntInput.safeParse(values)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    setBusy(true)
    setSubmitError(null)
    try {
      const { designer, piece, season, size, maxPriceUsd } = parsed.data
      // Only the columns in the schema's writableFields — anything else would
      // be refused by the RecordRoom anyway.
      const id = await createConfirmed({
        designer,
        piece,
        ...(season ? { season } : {}),
        ...(size ? { size } : {}),
        ...(maxPriceUsd ? { maxPriceUsd } : {}),
      })
      setValues(EMPTY)
      await onCreated(id)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save the hunt.')
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof HuntFormValues, label: string, props: React.ComponentProps<typeof Input>) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`hunt-${key}`}>{label}</Label>
      <Input
        id={`hunt-${key}`}
        value={values[key]}
        onChange={set(key)}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `hunt-${key}-error` : undefined}
        {...props}
      />
      {errors[key] && (
        <p id={`hunt-${key}-error`} className="text-xs text-destructive">
          {errors[key]}
        </p>
      )}
    </div>
  )

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {field('designer', 'Designer', { placeholder: 'Junya Watanabe', maxLength: HUNT_LIMITS.designer, autoComplete: 'off', required: true })}
      {field('piece', 'Piece', { placeholder: 'patchwork denim jacket', maxLength: HUNT_LIMITS.piece, autoComplete: 'off', required: true })}
      {field('season', 'Season (optional)', { placeholder: 'SS02', maxLength: HUNT_LIMITS.season, autoComplete: 'off' })}
      {field('size', 'Size (optional)', { placeholder: 'M, 2 or 48', maxLength: HUNT_LIMITS.size, autoComplete: 'off' })}
      {field('maxPriceUsd', 'Max landed price, USD (optional)', { placeholder: '400', inputMode: 'numeric', autoComplete: 'off' })}
      <div className="flex items-end">
        {/* disabled until the RecordRoom socket is ready, never an early return
            in the handler — that would drop the user's write silently. */}
        <Button type="submit" className="w-full" loading={busy} disabled={!ready || busy}>
          Create hunt &amp; scan
        </Button>
      </div>
      {submitError && <p className="text-sm text-destructive sm:col-span-2">{submitError}</p>}
    </form>
  )
}
