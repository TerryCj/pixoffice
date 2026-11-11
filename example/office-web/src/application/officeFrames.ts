import { readCharacterManifest } from '@pixoffice/assets-office/frame/resources'
import { bindOfficeFrames } from '@pixoffice/assets-office/frame/bindings'
export { bindOfficeFrames }

/** Fallback sprite for members whose own character pack does not exist yet. The office must not go blank because one pack is missing. */
const FALLBACK_CHARACTER_ID = 'data-agent'

export async function resolveOfficeAppearance(id: string, options: { energeticWork?: boolean } = {}) {
  let manifest: Awaited<ReturnType<typeof readCharacterManifest>>['manifest']
  let url: string
  try {
    ({ manifest, url } = await readCharacterManifest(id))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown character resource pack:')) {
      console.warn(`[Office] character pack missing for ${id}; using fallback ${FALLBACK_CHARACTER_ID}`)
      ;({ manifest, url } = await readCharacterManifest(FALLBACK_CHARACTER_ID))
    } else throw error
  }
  const appearance = bindOfficeFrames(manifest, url)
  if (!options.energeticWork) return appearance
  const variantId = 'office.type.seated.back', binding = appearance.source.bindings[variantId]
  if (!binding || !manifest.clips['work.typing-back']) throw new Error(`Missing crafting work frames: ${id}`)
  return { ...appearance, source: { ...appearance.source, bindings: { ...appearance.source.bindings,
    [variantId]: { ...binding, clip: 'work.typing-back' } } } }
}
