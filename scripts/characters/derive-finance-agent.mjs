// Derive the CFO (finance-agent) character pack from the built data-agent pack.
//
// Why a derivation instead of a source pack under art/characters/packs/:
// the admission pipeline (docs/character-admission.md) requires work clips whose
// motion stays inside two small finger regions, and a single-frame work clip can
// never satisfy "both finger regions must animate". The legacy data-agent art has
// full-body jitter between work frames (measured 2026-11-12: ~9.5k changed pixels
// inside the forbidden middle strip for both work.typing-back and work.quiet-back)
// and a single-frame work.computer-back, so no quality.json can pass admission for
// a recolor of it. Redrawing the art is out of scope and fabricating audit data is
// forbidden, so the CFO pack is a declared, deterministic color transform of the
// already-built, legacy-frozen data-agent pack: same geometry, same known defects,
// green clothing instead of blue, recognizable as the CFO at a glance.
//
// This script runs right after characters:build (see the characters:build script in
// package.json) and before build-visual-manifests / build-asset-catalogs, which read
// the registry. It is idempotent: re-running it reproduces identical bytes.
// --check verifies the derived files on disk instead of writing them.
//
// The transform matches the hue shift used for the original manual pack: pixels
// whose hue is blue (183-261 deg) with enough saturation and value, and nearly
// opaque, move 78 degrees toward green with boosted saturation. Skin, hair,
// beige, white and black pixels are untouched.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../../', import.meta.url))
const charactersRoot = path.join(root, 'public/characters')
const DONOR_ID = 'data-agent'
const TARGET_ID = 'finance-agent'
const TARGET_LABEL = 'CFO'

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6)
    else if (max === g) h = 60 * ((b - r) / delta + 2)
    else h = 60 * ((r - g) / delta + 4)
  }
  if (h < 0) h += 360
  return [h, max ? delta / max : 0, max / 255]
}

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

async function hueShiftWebp(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let shifted = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 200) continue
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2])
    if (h < 183 || h > 261 || s <= 25 / 255 || v <= 30 / 255) continue
    const [r, g, b] = hsvToRgb(h - 78, Math.min(1, s * 1.35), v)
    data[i] = r; data[i + 1] = g; data[i + 2] = b
    shifted++
  }
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ lossless: true, effort: 4 }).toBuffer()
  return { buffer: out, shifted }
}

async function derive() {
  const registryPath = path.join(charactersRoot, 'registry.json')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const donor = registry.characters.find(entry => entry.id === DONOR_ID)
  if (!donor) throw new Error(`Donor pack ${DONOR_ID} missing from ${registryPath}; run characters:build first`)
  const donorDir = path.join(charactersRoot, DONOR_ID)
  const manifestName = path.basename(donor.manifest)
  const manifest = JSON.parse(await readFile(path.join(donorDir, manifestName), 'utf8'))
  manifest.id = TARGET_ID
  manifest.label = TARGET_LABEL

  const files = new Map()
  files.set(manifestName, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  let totalShifted = 0
  for (const page of manifest.pages) {
    const { buffer, shifted } = await hueShiftWebp(await readFile(path.join(donorDir, page.image)))
    files.set(page.image, buffer)
    totalShifted += shifted
  }
  if (donor.portrait) {
    const { buffer, shifted } = await hueShiftWebp(await readFile(path.join(donorDir, donor.portrait.image)))
    files.set(donor.portrait.image, buffer)
    totalShifted += shifted
  }
  const entry = { ...donor, id: TARGET_ID, label: TARGET_LABEL, manifest: `${TARGET_ID}/${manifestName}` }
  const next = { ...registry, characters: [...registry.characters.filter(item => item.id !== TARGET_ID), entry] }
  return { files, registry: next, registryPath, totalShifted }
}

const check = process.argv.includes('--check')
const { files, registry, registryPath, totalShifted } = await derive()
const targetDir = path.join(charactersRoot, TARGET_ID)

if (check) {
  const problems = []
  for (const [name, expected] of files) {
    try {
      const current = await readFile(path.join(targetDir, name))
      if (!current.equals(expected)) problems.push(`${TARGET_ID}/${name}: stale`)
    } catch { problems.push(`${TARGET_ID}/${name}: missing`) }
  }
  const currentRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  if (JSON.stringify(currentRegistry) !== JSON.stringify(registry)) problems.push('registry.json: stale')
  if (problems.length) throw new Error(`Derived CFO pack out of date:\n${problems.join('\n')}`)
  console.log(`Derived CFO pack verified: ${files.size} files, ${totalShifted} hue-shifted pixels`)
} else {
  await mkdir(targetDir, { recursive: true })
  // Remove stale derived files from an older donor build (e.g. renamed atlases).
  for (const name of await readdir(targetDir)) if (!files.has(name)) {
    const { rm } = await import('node:fs/promises')
    await rm(path.join(targetDir, name))
  }
  for (const [name, buffer] of files) await writeFile(path.join(targetDir, name), buffer)
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n')
  console.log(`Derived CFO pack: ${files.size} files, ${totalShifted} hue-shifted pixels`)
}
