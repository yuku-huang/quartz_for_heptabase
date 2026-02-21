/**
 * fetchHeptabase.mjs  (v2)
 *
 * Pre-build script for Quartz.
 * Changes from v1:
 *   - Cards are placed in section-named folders (from whiteboard sections)
 *   - About card → content/index.md  (homepage)
 *   - Duplicate title H1 removed from body
 *   - YouTube → <iframe> embed (raw HTML, Quartz renders it)
 *   - Internal links use Quartz [[wikilink]] syntax with section path
 *   - Copies logo.png / favicon.ico to quartz/quartz/static/  (one-time, now commented out)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ─── Configuration ────────────────────────────────────────────────────────────

const WHITEBOARD_UUID = '946f23a3-75ef-48e3-8e7b-35c2376f2559'
const SITE_TITLE = '羽空的卡片盒'
const ABOUT_CARD_TITLE = 'About'                 // which card becomes index.md
const UNCATEGORIZED = '其他'                  // fallback folder name

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_DIR = path.join(__dirname, 'content')
const STATIC_DIR = path.join(__dirname, 'quartz', 'static')
const BLOG_PUBLIC = path.join(__dirname, '..', 'Heptabase_blog', 'public')

// ─── Copy icons ───────────────────────────────────────────────────────────────

// function copyIconsIfExists() {
//     const pairs = [
//         ['logo.png', 'icon.png'],
//         ['favicon.ico', 'favicon.ico'],
//         ['og-image.png','og-image.png'],
//     ]
//     for (const [src, dest] of pairs) {
//         const srcPath  = path.join(BLOG_PUBLIC, src)
//         const destPath = path.join(STATIC_DIR, dest)
//         if (fs.existsSync(srcPath)) {
//             fs.copyFileSync(srcPath, destPath)
//             console.log(`   📋 Copied ${src} → quartz/static/${dest}`)
//         }
//     }
// }

// ─── API ──────────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'heptabase-db-schema-version': '126',
}

async function fetchWhiteboardStructure(uuid) {
    const res = await fetch(
        'https://api.heptabase.com/v1/collaboration/getAllDataForWhiteboard',
        {
            method: 'POST',
            headers: BASE_HEADERS,
            body: JSON.stringify({
                whiteboardId: uuid,
                doFetchDataForWhiteboardQuickRender: true,
                permissionCheckMode: 'public',
            }),
        }
    )
    if (!res.ok) throw new Error(`getAllDataForWhiteboard failed: ${res.status}`)
    return res.json()
}

async function fetchCards(cardIds) {
    if (cardIds.length === 0) return {}
    const res = await fetch(
        'https://api.heptabase.com/v1/getObjectsMapV2',
        {
            method: 'POST',
            headers: BASE_HEADERS,
            body: JSON.stringify({
                objects: cardIds.map(id => ({ objectType: 'card', objectId: id })),
                permissionCheckMode: 'public',
            }),
        }
    )
    if (!res.ok) throw new Error(`getObjectsMapV2 failed: ${res.status}`)
    const data = await res.json()
    return data?.objectsMap?.card || {}
}

// ─── Tiptap JSON → Markdown ───────────────────────────────────────────────────

/**
 * sanitizeFolderName: strip characters invalid in Windows/Linux path names
 */
function sanitizeFolderName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '').trim() || UNCATEGORIZED
}

function tiptapToMarkdown(node, cardPathMap = {}, depth = 0) {
    if (!node) return ''
    if (Array.isArray(node)) {
        return node.map(n => tiptapToMarkdown(n, cardPathMap, depth)).join('')
    }

    const children = node.content
        ? tiptapToMarkdown(node.content, cardPathMap, depth)
        : ''

    switch (node.type) {
        case 'doc':
            return children

        case 'heading': {
            const level = node.attrs?.level ?? 1
            return `${'#'.repeat(level)} ${children}\n\n`
        }

        case 'paragraph':
            return children ? `${children}\n\n` : '\n'

        case 'blockquote':
            return children.split('\n').map(l => `> ${l}`).join('\n') + '\n\n'

        case 'horizontal_rule':
            return '---\n\n'

        case 'code_block': {
            const lang = node.attrs?.params || ''
            const raw = children.trim()
            if (raw.startsWith('{HTML}')) return ''
            return `\`\`\`${lang}\n${raw}\n\`\`\`\n\n`
        }

        case 'bullet_list':
        case 'bullet_list_item': {
            return (node.content || []).map(item => {
                const text = tiptapToMarkdown(item, cardPathMap, depth + 1).trimEnd()
                return `- ${text}\n`
            }).join('') + '\n'
        }

        case 'ordered_list':
        case 'numbered_list_item': {
            return (node.content || []).map((item, i) => {
                const text = tiptapToMarkdown(item, cardPathMap, depth + 1).trimEnd()
                return `${i + 1}. ${text}\n`
            }).join('') + '\n'
        }

        case 'list_item':
            return children.trim()

        case 'todo_list':
        case 'task_list':
            return (node.content || []).map(item => {
                const checked = item.attrs?.checked ? '[x]' : '[ ]'
                const text = tiptapToMarkdown(item, cardPathMap, depth + 1).trimEnd()
                return `- ${checked} ${text}\n`
            }).join('') + '\n'

        case 'todo_list_item':
            return children.trim()

        case 'toggle_list':
        case 'toggle_list_item':
            return children

        case 'table': {
            const rows = node.content || []
            if (rows.length === 0) return ''
            const lines = rows.map((row, ri) => {
                const cells = (row.content || []).map(cell =>
                    tiptapToMarkdown(cell, cardPathMap, depth).trim().replace(/\n+/g, ' ')
                )
                const line = `| ${cells.join(' | ')} |`
                if (ri === 0) {
                    const sep = `| ${cells.map(() => '---').join(' | ')} |`
                    return `${line}\n${sep}`
                }
                return line
            })
            return lines.join('\n') + '\n\n'
        }
        case 'table_row':
        case 'table_header':
        case 'table_cell':
            return children

        case 'image': {
            const src = node.attrs?.src || ''
            const alt = node.attrs?.alt || ''
            if (!src) return ''
            return `![${alt}](${src})\n\n`
        }

        case 'video': {
            const url = node.attrs?.url || ''
            if (!url) return ''
            // YouTube → <iframe> embed
            const yt = url.match(
                /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/
            )
            if (yt) {
                return (
                    `<iframe width="100%" style="aspect-ratio:16/9;border-radius:8px" ` +
                    `src="https://www.youtube.com/embed/${yt[1]}" ` +
                    `frameborder="0" allowfullscreen></iframe>\n\n`
                )
            }
            return `[影片連結](${url})\n\n`
        }

        // Internal card mention → Quartz wikilink
        case 'card': {
            const cardId = node.attrs?.cardId || ''
            let title = node.attrs?.cardTitle || ''
            if (!title || title === 'Invalid card') {
                title = cardPathMap[cardId]?.title || cardId
            }
            if (!cardId) return title
            const relPath = cardPathMap[cardId]?.path || cardId
            return `[[${relPath}|${title}]]`
        }

        case 'whiteboard':
            return node.attrs?.whiteboardName || ''

        case 'date':
            return node.attrs?.date || ''

        case 'math_inline':
            return `$${children}$`

        case 'text': {
            let text = node.text || ''
            const marks = node.marks || []
            for (const mark of marks) {
                switch (mark.type) {
                    case 'strong': text = `**${text}**`; break
                    case 'em': text = `*${text}*`; break
                    case 'strike': text = `~~${text}~~`; break
                    case 'code': text = `\`${text}\``; break
                    case 'color': break
                    case 'link': {
                        const href = mark.attrs?.href || mark.attrs?.['data-internal-href'] || ''
                        if (href.startsWith('meta://card/')) {
                            const cid = href.replace('meta://card/', '')
                            const ctitle = cardPathMap[cid]?.title || text
                            const cpath = cardPathMap[cid]?.path || cid
                            text = `[[${cpath}|${ctitle}]]`
                        } else if (href) {
                            text = `[${text}](${href})`
                        }
                        break
                    }
                    default: break
                }
            }
            if (text.includes('{HTML}')) return ''
            return text
        }

        default:
            return children
    }
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

function buildFrontmatter(card, tags = []) {
    const title = (card.title || 'Untitled').replace(/"/g, '\\"')
    const created = card.createdTime?.split('T')[0] || ''
    const modified = card.lastEditedTime?.split('T')[0] || ''
    const lines = [
        '---',
        `title: "${title}"`,
        created ? `date: ${created}` : null,
        modified ? `lastmod: ${modified}` : null,
        `heptabase_id: ${card.id}`,
        tags.length ? `tags:\n${tags.map(t => `  - ${t}`).join('\n')}` : null,
        '---',
        '',
    ]
    return lines.filter(l => l !== null).join('\n')
}

// ─── Remove leading H1 that duplicates the title ──────────────────────────────

function removeDuplicateTitle(bodyMd, cardTitle) {
    if (!cardTitle) return bodyMd
    // Match a leading `# Title\n` (with possible blank lines after)
    const escaped = cardTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return bodyMd.replace(new RegExp(`^#+ ${escaped}\\s*\\n+`), '')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🌿 Fetching Heptabase whiteboard data...')
    console.log(`   UUID: ${WHITEBOARD_UUID}`)

    // // ── Copy icons (one-time, already done) ──
    // console.log('🖼️  Copying icons...')
    // copyIconsIfExists()

    // ── Step 1: Whiteboard structure ──
    const structure = await fetchWhiteboardStructure(WHITEBOARD_UUID)
    const accessMap = structure?.accessibleObjectMap || {}
    const sections = accessMap.section || {}   // sectionId → {id, title, ...}
    const cardInstances = accessMap.cardInstance || {}   // instanceId → {id, cardId, ...}
    const sectionObjRel = accessMap.sectionObjectRelation || {} // "sectionId#instanceId" → {sectionId, objectId}

    console.log(`   Sections: ${Object.keys(sections).length}`)
    console.log(`   Card instances: ${Object.keys(cardInstances).length}`)

    // ── Build instanceId → cardId ──
    const instanceToCard = {}
    for (const [instId, inst] of Object.entries(cardInstances)) {
        if (inst.cardId) instanceToCard[instId] = inst.cardId
    }

    // ── Build cardId → sectionTitle ──
    const cardToSection = {}
    for (const rel of Object.values(sectionObjRel)) {
        const sectionId = rel.sectionId
        const instanceId = rel.objectId
        const cardId = instanceToCard[instanceId]
        const sectionTitle = sections[sectionId]?.title || UNCATEGORIZED
        if (cardId) cardToSection[cardId] = sectionTitle
    }

    // ── Step 2: Fetch all card contents ──
    const cardIds = [...new Set(Object.values(instanceToCard))]
    console.log(`   Unique card IDs: ${cardIds.length}`)

    console.log('📥 Fetching card contents...')
    const CHUNK = 50
    let allCardsMap = {}
    for (let i = 0; i < cardIds.length; i += CHUNK) {
        const chunk = cardIds.slice(i, i + CHUNK)
        const result = await fetchCards(chunk)
        Object.assign(allCardsMap, result)
        console.log(`   Fetched ${Math.min(i + CHUNK, cardIds.length)}/${cardIds.length}...`)
    }

    const cards = Object.values(allCardsMap)
    console.log(`   Got ${cards.length} cards`)

    // ── Step 3: Decide paths ──
    // cardPathMap: cardId → { title, path (relative to content/) }
    const cardPathMap = {}
    let aboutCard = null

    for (const card of cards) {
        if (!card.id) continue
        const isAbout = card.title === ABOUT_CARD_TITLE
        if (isAbout) aboutCard = card

        const section = cardToSection[card.id]
            ? sanitizeFolderName(cardToSection[card.id])
            : UNCATEGORIZED
        const relPath = isAbout ? 'index' : `${section}/${card.id}`
        cardPathMap[card.id] = { title: card.title || '', path: relPath, section }
    }

    // ── Step 4: Clear content (except .gitkeep) ──
    function clearDir(dir) {
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return }
        for (const entry of fs.readdirSync(dir)) {
            if (entry === '.gitkeep') continue
            const full = path.join(dir, entry)
            fs.rmSync(full, { recursive: true, force: true })
        }
    }
    clearDir(CONTENT_DIR)
    console.log('🗑️  Cleared content/')

    // ── Step 5: Write markdown files ──
    let written = 0

    for (const card of cards) {
        if (!card.id) continue
        const info = cardPathMap[card.id]
        const isAbout = card.title === ABOUT_CARD_TITLE

        // Convert Tiptap JSON → Markdown
        let bodyMd = ''
        if (card.content) {
            try {
                const doc = JSON.parse(card.content)
                bodyMd = tiptapToMarkdown(doc, cardPathMap)
            } catch (e) {
                console.warn(`   ⚠️  ${card.title}: ${e.message}`)
            }
        }

        // Remove leading H1 that duplicates the card's title
        bodyMd = removeDuplicateTitle(bodyMd, card.title)

        const section = isAbout ? null : info.section
        const tags = section && section !== UNCATEGORIZED ? [section] : []
        const fm = buildFrontmatter(card, tags)

        let destPath
        if (isAbout) {
            destPath = path.join(CONTENT_DIR, 'index.md')
        } else {
            const sectionDir = path.join(CONTENT_DIR, info.section)
            fs.mkdirSync(sectionDir, { recursive: true })
            destPath = path.join(sectionDir, `${card.id}.md`)
        }

        fs.writeFileSync(destPath, fm + bodyMd.trimEnd() + '\n', 'utf8')
        written++
    }

    // ── Fallback index.md if no About card found ──
    if (!aboutCard) {
        console.warn('   ⚠️  No "About" card found — creating a default index.md')
        const sorted = cards
            .filter(c => c.id)
            .sort((a, b) => (b.lastEditedTime || '').localeCompare(a.lastEditedTime || ''))

        const listMd = sorted
            .map(c => {
                const info = cardPathMap[c.id]
                const date = c.lastEditedTime?.split('T')[0] || ''
                return `- [[${info.path}|${c.title || c.id}]]${date ? ` — ${date}` : ''}`
            })
            .join('\n')

        const indexContent = [
            '---',
            `title: "${SITE_TITLE}"`,
            '---',
            '',
            `# ${SITE_TITLE}`,
            '',
            '## 所有筆記',
            '',
            listMd,
            '',
        ].join('\n')

        fs.writeFileSync(path.join(CONTENT_DIR, 'index.md'), indexContent, 'utf8')
    }

    console.log(`\n✅ Written ${written} card files`)

    // Print section summary
    const sectionCounts = {}
    for (const card of cards) {
        if (!card.id || card.title === ABOUT_CARD_TITLE) continue
        const s = cardPathMap[card.id]?.section || UNCATEGORIZED
        sectionCounts[s] = (sectionCounts[s] || 0) + 1
    }
    console.log('\n📂 Sections:')
    for (const [s, count] of Object.entries(sectionCounts)) {
        console.log(`   ${s}: ${count} cards`)
    }

    console.log('\n🚀 Done! Run `npx quartz build` to generate the site.')
}

main().catch(err => {
    console.error('❌ Error:', err)
    process.exit(1)
})
