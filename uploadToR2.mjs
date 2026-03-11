/**
 * uploadToR2.mjs
 *
 * Scans `blog-img/` for image files and uploads them to Cloudflare R2.
 * Uses content-hash as the object key to avoid duplicates.
 *
 * Environment variables (or .env file):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_PUBLIC_URL
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import {
    S3Client,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3'

// ─── Load .env if present ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '.env')

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8')
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) continue
        const key = trimmed.slice(0, eqIdx).trim()
        const val = trimmed.slice(eqIdx + 1).trim()
        if (!process.env[key]) process.env[key] = val
    }
}

// ─── Configuration ────────────────────────────────────────────────────────────

const BLOG_IMG_DIR = process.env.BLOG_IMG_DIR
    ? path.resolve(process.env.BLOG_IMG_DIR)
    : path.resolve(__dirname, '..', 'blog-img')
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'])

const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
} = process.env

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    console.error('❌ Missing required R2 environment variables.')
    console.error('   Required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL')
    process.exit(1)
}

// ─── MIME type mapping ────────────────────────────────────────────────────────

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
}

// ─── S3 Client (R2-compatible) ────────────────────────────────────────────────

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashFile(filePath) {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

async function objectExists(key) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
        return true
    } catch {
        return false
    }
}

function getImageFiles(dir) {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
        .filter(f => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .map(f => ({
            name: f,
            fullPath: path.join(dir, f),
            ext: path.extname(f).toLowerCase(),
        }))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🖼️  Cloudflare R2 Image Uploader')
    console.log(`   Source: ${BLOG_IMG_DIR}`)
    console.log(`   Bucket: ${R2_BUCKET_NAME}`)
    console.log(`   Public URL: ${R2_PUBLIC_URL}`)
    console.log()

    const images = getImageFiles(BLOG_IMG_DIR)

    if (images.length === 0) {
        console.log('📭 No images found in blog-img/. Nothing to upload.')
        return
    }

    console.log(`📂 Found ${images.length} image(s):\n`)

    let uploaded = 0
    let skipped = 0
    const results = []

    for (const img of images) {
        const hash = hashFile(img.fullPath)
        const key = `blog/${hash}${img.ext}`
        const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`

        const exists = await objectExists(key)
        if (exists) {
            console.log(`   ⏭️  ${img.name} → already exists (${key})`)
            skipped++
            results.push({ file: img.name, url: publicUrl, status: 'skipped' })
            continue
        }

        const body = fs.readFileSync(img.fullPath)
        const contentType = MIME_TYPES[img.ext] || 'application/octet-stream'

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType,
        }))

        console.log(`   ✅ ${img.name} → ${publicUrl}`)
        uploaded++
        results.push({ file: img.name, url: publicUrl, status: 'uploaded' })
    }

    console.log()
    console.log(`🎉 Done! Uploaded: ${uploaded}, Skipped: ${skipped}`)

    if (results.length > 0) {
        console.log('\n📋 Markdown（可直接複製）:\n')
        for (const r of results) {
            console.log(`![${r.file}](${r.url})`)
        }
        console.log()
    }
}

main().catch(err => {
    console.error('❌ Error:', err)
    process.exit(1)
})
