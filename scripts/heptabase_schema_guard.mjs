#!/usr/bin/env node

/**
 * Resolve Heptabase's current public schema version and verify it with the
 * public whiteboard API. With --apply, update only the known schema headers in
 * this repository. If Heptabase changes its bundle shape, fail closed so the
 * monitor warns instead of guessing a number.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = process.env.HEPTABASE_APP_URL || 'https://app.heptabase.com/'
const API_URL = 'https://api.heptabase.com/v1/collaboration/getAllDataForWhiteboard'
const WHITEBOARD_UUID = process.env.HEPTABASE_WHITEBOARD_UUID || '946f23a3-75ef-48e3-8e7b-35c2376f2559'
const DEPLOYED_URL = process.env.BLOG_URL || 'https://heptabase-blog-git-main-yuku-huangs-projects.vercel.app/'
const REQUEST_TIMEOUT_MS = 30_000

const args = new Set(process.argv.slice(2))
const shouldApply = args.has('--apply')
const shouldCheckDeployment = args.has('--deployed')

const TARGETS = [
    {
        relativePath: 'src/config.js',
        pattern: /('heptabase_db_schema_version'\s*:\s*')(\d+)(')/,
    },
    {
        relativePath: 'api/heptabase.js',
        pattern: /(heptabase_db_schema_version\s*\|\|\s*')(\d+)(')/,
    },
    {
        relativePath: 'src/constantFunction.js',
        pattern: /(CONFIG\.heptabase_db_schema_version\s*\|\|\s*')(\d+)(')/,
    },
    {
        relativePath: 'fetchHeptabase.mjs',
        pattern: /('heptabase-db-schema-version'\s*:\s*')(\d+)(')/,
    },
]

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = await response.text()
    return { response, body }
}

function resolveMainAsset(html) {
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)]
        .map(match => match[1])
    const mainAsset = scripts.find(asset => /(?:^|\/)main[-.][^/]+\.js$/.test(asset))
    if (!mainAsset) throw new Error('Could not find Heptabase main JavaScript bundle')
    return mainAsset
}

function resolveSchemaChunk(mainBundle) {
    const header = mainBundle.match(
        /["']Heptabase-Db-Schema-Version["']\s*:\s*([A-Za-z_$][\w$]*)\.toString\(\)/,
    )
    if (!header) throw new Error('Could not find Heptabase schema header binding')

    const alias = header[1]
    const importedBinding = mainBundle.match(
        new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${escapeRegExp(alias)}\\b`),
    )
    if (!importedBinding) throw new Error(`Could not resolve schema import alias ${alias}`)

    const source = [...mainBundle.matchAll(/from["']([^"']+\.js)["']/g)]
        .find(match => match.index > importedBinding.index)
    if (!source) throw new Error('Could not resolve schema chunk URL')

    return {
        alias,
        exportAlias: importedBinding[1],
        chunkPath: source[1],
    }
}

function resolveSchemaVersion(chunk, exportAlias) {
    const exported = chunk.match(
        new RegExp(
            `export\\s*\\{[^}]*?\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${escapeRegExp(exportAlias)}\\b[^}]*\\}`,
        ),
    )

    const exportedBinding = exported
        ? exported[1]
        : null

    if (!exportedBinding) {
        throw new Error('Could not find the exported schema binding in Heptabase chunk')
    }

    const schemaMap = chunk.match(
        new RegExp(
            `\\b${escapeRegExp(exportedBinding)}\\s*=\\s*Object\\.keys\\(([A-Za-z_$][\\w$]*)\\)\\.length\\s*\\+\\s*1`,
        ),
    )
    if (!schemaMap) throw new Error('Could not find Heptabase schema migration map')

    const mapName = schemaMap[1]
    const objectStart = chunk.indexOf(`${mapName}={`)
    if (objectStart < 0) throw new Error('Could not locate Heptabase schema migration map body')

    const objectEnd = chunk.indexOf(`},${exportedBinding}=Object.keys`, objectStart)
    if (objectEnd < 0) throw new Error('Could not determine Heptabase schema migration map boundary')

    const body = chunk.slice(objectStart + mapName.length + 2, objectEnd)
    const numericKeys = new Set(
        [...body.matchAll(/(?:^|,)\s*(\d+)\s*:/g)].map(match => match[1]),
    )
    if (numericKeys.size === 0) throw new Error('Heptabase schema migration map has no numeric entries')

    return numericKeys.size + 1
}

async function resolveUpstreamSchema() {
    const app = new URL(APP_URL)
    const appPage = await fetchText(app)
    if (!appPage.response.ok) throw new Error(`Heptabase app returned ${appPage.response.status}`)

    const mainPath = resolveMainAsset(appPage.body)
    const mainUrl = new URL(mainPath, app).href
    const mainBundle = await fetchText(mainUrl)
    if (!mainBundle.response.ok) throw new Error(`Heptabase main bundle returned ${mainBundle.response.status}`)

    const chunkInfo = resolveSchemaChunk(mainBundle.body)
    const chunkUrl = new URL(chunkInfo.chunkPath, mainUrl).href
    const chunk = await fetchText(chunkUrl)
    if (!chunk.response.ok) throw new Error(`Heptabase schema chunk returned ${chunk.response.status}`)

    const schemaVersion = resolveSchemaVersion(chunk.body, chunkInfo.exportAlias)
    const apiCheck = await fetchText(API_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'heptabase-db-schema-version': String(schemaVersion),
        },
        body: JSON.stringify({
            whiteboardId: WHITEBOARD_UUID,
            doFetchDataForWhiteboardQuickRender: true,
            permissionCheckMode: 'public',
        }),
    })
    if (!apiCheck.response.ok) {
        throw new Error(`Heptabase API rejected schema ${schemaVersion}: ${apiCheck.response.status}`)
    }

    let data
    try {
        data = JSON.parse(apiCheck.body)
    } catch {
        throw new Error('Heptabase API returned invalid JSON')
    }
    if (!data?.accessibleObjectMap || typeof data.accessibleObjectMap !== 'object') {
        throw new Error('Heptabase API response is missing accessibleObjectMap')
    }

    return {
        schemaVersion,
        mainUrl,
        chunkUrl,
        cardInstanceCount: Object.keys(data.accessibleObjectMap.cardInstance || {}).length,
    }
}

function readCurrentVersions() {
    const versions = {}
    for (const target of TARGETS) {
        const absolutePath = path.join(ROOT, target.relativePath)
        if (!fs.existsSync(absolutePath)) continue

        const content = fs.readFileSync(absolutePath, 'utf8')
        const match = content.match(target.pattern)
        if (!match) throw new Error(`Could not find schema header in ${target.relativePath}`)
        versions[target.relativePath] = Number(match[2])
    }

    if (Object.keys(versions).length === 0) {
        throw new Error('No supported schema header files found in this repository')
    }
    return versions
}

function applySchemaVersion(schemaVersion) {
    const changedFiles = []
    for (const target of TARGETS) {
        const absolutePath = path.join(ROOT, target.relativePath)
        if (!fs.existsSync(absolutePath)) continue

        const content = fs.readFileSync(absolutePath, 'utf8')
        const updated = content.replace(target.pattern, (_full, prefix, _oldVersion, suffix) => {
            return `${prefix}${schemaVersion}${suffix}`
        })
        if (updated !== content) {
            fs.writeFileSync(absolutePath, updated, 'utf8')
            changedFiles.push(target.relativePath)
        }
    }
    return changedFiles
}

async function checkDeployment(expectedSchemaVersion) {
    const baseUrl = DEPLOYED_URL.endsWith('/') ? DEPLOYED_URL : `${DEPLOYED_URL}/`
    const pageUrl = new URL(`?_heptabase_health=${Date.now()}`, baseUrl)
    const page = await fetchText(pageUrl)
    if (!page.response.ok) throw new Error(`Deployed blog page returned ${page.response.status}`)

    const mainPath = resolveMainAsset(page.body)
    const bundleUrl = new URL(mainPath, pageUrl).href
    const bundle = await fetchText(bundleUrl)
    if (!bundle.response.ok) throw new Error(`Deployed blog bundle returned ${bundle.response.status}`)

    const deployedSchema = bundle.body.match(
        /["']?heptabase_db_schema_version["']?\s*:\s*["']?(\d+)/,
    )?.[1]
    if (!deployedSchema) throw new Error('Deployed blog bundle has no schema version')
    if (Number(deployedSchema) !== expectedSchemaVersion) {
        throw new Error(`Deployed blog is still on schema ${deployedSchema}; expected ${expectedSchemaVersion}`)
    }

    const apiUrl = new URL('api/heptabase', baseUrl)
    apiUrl.searchParams.set('whiteboard_uuid', WHITEBOARD_UUID)
    const api = await fetchText(apiUrl)
    if (!api.response.ok) throw new Error(`Deployed /api/heptabase returned ${api.response.status}`)

    let data
    try {
        data = JSON.parse(api.body)
    } catch {
        throw new Error('Deployed /api/heptabase returned invalid JSON')
    }
    if (!Array.isArray(data?.data?.cards)) {
        throw new Error('Deployed /api/heptabase response is missing data.cards[]')
    }

    return {
        url: baseUrl,
        deployedSchema: Number(deployedSchema),
        cardCount: data.data.cards.length,
    }
}

function writeGithubOutput(values) {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath) return
    fs.appendFileSync(
        outputPath,
        Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
        'utf8',
    )
}

async function main() {
    const upstream = await resolveUpstreamSchema()
    const currentVersions = readCurrentVersions()
    const changedFiles = shouldApply ? applySchemaVersion(upstream.schemaVersion) : []
    const result = {
        ok: true,
        schemaVersion: upstream.schemaVersion,
        currentVersions,
        changedFiles,
        cardInstanceCount: upstream.cardInstanceCount,
        mainUrl: upstream.mainUrl,
    }

    if (shouldCheckDeployment) {
        result.deployment = await checkDeployment(upstream.schemaVersion)
    }

    console.log(JSON.stringify(result, null, 2))
    writeGithubOutput({
        schema_version: upstream.schemaVersion,
        changed: changedFiles.length > 0,
    })
}

main().catch(error => {
    console.error(`HEPTABASE_SCHEMA_GUARD_FAILED: ${error.message}`)
    process.exitCode = 1
})
