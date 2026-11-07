// Builds DeV's marketplace index: popular, maintained plugins, skills and MCP servers from public sources.
//
// Sources:
//   - the official MCP Registry (registry.modelcontextprotocol.io): servers and how to run them
//   - GitHub repos tagged as plugins or skills, and repos that publish a plugin marketplace.json
// Every entry's GitHub repo is checked for stars, license and recent activity. An entry is listed when it has
// at least MIN_STARS stars, a license, a push in the last year and isn't archived, or when verified.json names it.
//
// Output: .dev-plugin/marketplace.json in the common plugin marketplace format, so any compatible agent can add
// this repo as a marketplace. MCP servers become small plugin folders under mcp/. Run: GITHUB_TOKEN=… bun scripts/build.ts

import path from "path"
import fs from "fs/promises"

const ROOT = path.resolve(import.meta.dir, "..")
const MIN_STARS = Number(process.env.MIN_STARS ?? 50)
const MAX_AGE_DAYS = 365
const MAX_SERVERS_PER_REPO = 5
const TOKEN = process.env.GITHUB_TOKEN ?? ""
const PLUGIN_TOPICS = ["claude-code-plugin", "claude-code-plugins", "claude-plugins", "claude-plugin", "plugin-marketplace", "agent-plugins"]
const SKILL_TOPICS = ["agent-skills", "agent-skill", "claude-skills", "claude-skill", "skills-collection"]
const NAME = /^[a-zA-Z0-9][\w.-]*$/

type Repo = {
  full: string
  stars: number
  license?: string
  pushedAt: string
  archived: boolean
  description?: string
  marketplace?: string
  skillsDir: boolean
  rootSkill: boolean
}

type Entry = {
  name: string
  description?: string
  source: unknown
  category: "plugin" | "skill" | "mcp"
  tags?: string[]
  license?: string
  homepage?: string
  metadata: { stars: number; updated: string; repo: string; verified?: boolean; from?: string; needs?: string[] }
}

const verified = new Set<string>(await Bun.file(path.join(ROOT, "verified.json")).json().catch(() => []))

// ---------- GitHub ----------

async function gh(url: string, init: RequestInit = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "dev-marketplace-index",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...init.headers,
      },
    })
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now()
      await Bun.sleep(Math.min(Math.max(reset, 10_000), 120_000))
      continue
    }
    if (!response.ok) return undefined
    return response.json() as Promise<any>
  }
  return undefined
}

async function searchRepos(query: string) {
  const names: string[] = []
  for (let page = 1; page <= 10; page++) {
    const data = await gh(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=100&page=${page}`)
    const items = (data?.items ?? []) as { full_name: string }[]
    names.push(...items.map((item) => item.full_name))
    if (items.length < 100) break
    await Bun.sleep(2500) // search allows 30 requests a minute
  }
  return names
}

async function searchMarketplaceFiles() {
  const names: string[] = []
  for (let page = 1; page <= 10; page++) {
    const data = await gh(
      `/search/code?q=${encodeURIComponent("filename:marketplace.json path:.claude-plugin")}&per_page=100&page=${page}`,
    )
    const items = (data?.items ?? []) as { repository: { full_name: string } }[]
    names.push(...items.map((item) => item.repository.full_name))
    if (items.length < 100) break
    await Bun.sleep(7000) // code search allows 10 requests a minute
  }
  return names
}

/**
 * Stars, license, activity and plugin/skill layout for many repos: 40 per GraphQL request with file lookups, 100
 * without, 4 requests in flight. The registry alone names ~30k repos, so one request at a time took over 25 minutes.
 */
async function repos(names: string[], withFiles: boolean) {
  const out = new Map<string, Repo>()
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()]
  const size = withFiles ? 40 : 100
  const batches = Array.from({ length: Math.ceil(unique.length / size) }, (_, i) => unique.slice(i * size, (i + 1) * size))
  let done = 0
  const worker = async () => {
    for (let batch = batches.shift(); batch; batch = batches.shift()) {
      await fetchBatch(batch)
      done += batch.length
      process.stdout.write(`\r  repos ${done}/${unique.length}`)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  process.stdout.write("\n")
  return out

  async function fetchBatch(batch: string[]) {
    const fields = `stargazerCount isArchived pushedAt description licenseInfo { spdxId } nameWithOwner${
      withFiles
        ? ` mk: object(expression: "HEAD:.claude-plugin/marketplace.json") { ... on Blob { text } }
            mk2: object(expression: "HEAD:.dev-plugin/marketplace.json") { ... on Blob { text } }
            skills: object(expression: "HEAD:skills") { ... on Tree { entries { type } } }
            root: object(expression: "HEAD:SKILL.md") { id }`
        : ""
    }`
    const query = `{ ${batch
      .map((full, index) => {
        const [owner, name] = full.split("/")
        return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`
      })
      .join("\n")} }`
    const data = await gh("/graphql", { method: "POST", body: JSON.stringify({ query }) })
    for (const value of Object.values(data?.data ?? {}) as any[]) {
      if (!value) continue
      out.set(value.nameWithOwner.toLowerCase(), {
        full: value.nameWithOwner,
        stars: value.stargazerCount,
        license: value.licenseInfo?.spdxId ?? undefined,
        pushedAt: value.pushedAt,
        archived: value.isArchived,
        description: value.description ?? undefined,
        marketplace: value.mk?.text ?? value.mk2?.text,
        skillsDir: (value.skills?.entries ?? []).some((entry: { type: string }) => entry.type === "tree"),
        rootSkill: Boolean(value.root?.id),
      })
    }
  }
}

function listed(repo: Repo | undefined, id: string) {
  if (verified.has(id)) return true
  if (!repo || repo.archived || !repo.license) return false
  if (repo.stars < MIN_STARS) return false
  return Date.now() - Date.parse(repo.pushedAt) < MAX_AGE_DAYS * 86_400_000
}

/**
 * Whether a registry server's publisher plausibly owns the repo it names, whose stars it would show. The registry
 * proves an io.github.<owner> namespace belongs to that GitHub owner, so the repo must be theirs; one listing put
 * its own npm package behind Google's 55k-star repo. A domain namespace (com.acme) is proven by DNS, so the
 * domain's name must appear in the repo's owner or name.
 * ponytail: name-match heuristic for domains; check the npm/PyPI package's repository field if impostors get through.
 */
function owns(serverName: string, repo: string) {
  const namespace = serverName.split("/")[0]!.toLowerCase()
  if (namespace.startsWith("io.github.")) return namespace.slice("io.github.".length) === repo.split("/")[0]!.toLowerCase()
  const key = repo.toLowerCase().replace(/[^a-z0-9]/g, "")
  return namespace
    .split(".")
    .slice(1)
    .map((label) => label.replace(/[^a-z0-9]/g, ""))
    .some((label) => label.length >= 4 && key.includes(label))
}

function githubRepo(url: string | undefined) {
  const match = url?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/)
  return match ? `${match[1]}/${match[2]}` : undefined
}

// ---------- MCP Registry ----------

async function registry() {
  const servers: any[] = []
  let cursor = ""
  for (let page = 0; page < 1000; page++) {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=100&version=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    const data = (await fetch(url).then((response) => (response.ok ? response.json() : undefined))) as any
    if (!data) break
    servers.push(...(data.servers ?? []).map((item: any) => item.server))
    cursor = data.metadata?.nextCursor ?? ""
    process.stdout.write(`\r  registry ${servers.length}`)
    if (!cursor) break
  }
  process.stdout.write("\n")
  return servers
}

/** How to run a registry server, in the common .mcp.json shape, and the environment variables it needs. */
function runSpec(server: any): { spec: Record<string, unknown>; needs: string[] } | undefined {
  const packages = (server.packages ?? []) as any[]
  const needs = (pkg: any) =>
    (pkg?.environmentVariables ?? []).filter((item: any) => item.isRequired).map((item: any) => String(item.name))
  const stdio = (pkg: any) => !pkg.transport || pkg.transport.type === "stdio"
  const npm = packages.find((pkg) => pkg.registryType === "npm" && stdio(pkg))
  if (npm) return { spec: { command: "npx", args: ["-y", `${npm.identifier}@${npm.version ?? "latest"}`] }, needs: needs(npm) }
  const pypi = packages.find((pkg) => pkg.registryType === "pypi" && stdio(pkg))
  if (pypi)
    return {
      spec: { command: "uvx", args: [pypi.version ? `${pypi.identifier}==${pypi.version}` : pypi.identifier] },
      needs: needs(pypi),
    }
  const oci = packages.find((pkg) => pkg.registryType === "oci" && stdio(pkg))
  if (oci) {
    const image = oci.identifier.includes(":") || !oci.version ? oci.identifier : `${oci.identifier}:${oci.version}`
    const env = needs(oci).flatMap((name) => ["-e", name])
    return { spec: { command: "docker", args: ["run", "-i", "--rm", ...env, image] }, needs: needs(oci) }
  }
  const remote = (server.remotes ?? []).find((item: any) => item.type === "streamable-http" || item.type === "sse")
  if (remote && !/\{[^}]+\}/.test(remote.url)) return { spec: { type: "http", url: remote.url }, needs: [] }
  return undefined
}

// ---------- build ----------

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64)
}

const taken = new Set<string>()
function unique(name: string, owner: string) {
  for (const candidate of [name, `${name}-${slug(owner)}`, ...Array.from({ length: 50 }, (_, i) => `${name}-${i + 2}`)])
    if (NAME.test(candidate) && !taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  throw new Error(`no free name for ${name}`)
}

function pluginSource(source: any, repo: string) {
  if (typeof source === "string") {
    const sub = source.replace(/^\.\//, "").replace(/\/$/, "")
    if (sub.includes("..")) return undefined
    return sub === "" || sub === "."
      ? { source: "github", repo }
      : { source: "git-subdir", url: `https://github.com/${repo}.git`, path: sub }
  }
  if (source?.source === "github" || source?.source === "url" || source?.source === "git-subdir") return source
  return undefined
}

async function main() {
  console.log("Collecting candidates")
  const pluginRepos = (await Promise.all(PLUGIN_TOPICS.map((topic) => searchRepos(`topic:${topic} stars:>=${MIN_STARS}`)))).flat()
  const skillRepos = (await Promise.all(SKILL_TOPICS.map((topic) => searchRepos(`topic:${topic} stars:>=${MIN_STARS}`)))).flat()
  const marketplaceRepos = await searchMarketplaceFiles()
  const servers = await registry()
  console.log(`  ${pluginRepos.length} plugin, ${skillRepos.length} skill, ${marketplaceRepos.length} marketplace repos; ${servers.length} MCP servers`)

  console.log("Checking repos")
  const withFiles = await repos([...pluginRepos, ...skillRepos, ...marketplaceRepos, ...verifiedRepos()], true)
  // Only servers DeV can run (an npm, PyPI or Docker package, or a fixed URL) are worth looking up.
  const runnable = servers.filter((server) => runSpec(server))
  console.log(`  ${runnable.length} of ${servers.length} MCP servers are runnable`)
  const mcpRepos = await repos(runnable.map((server) => githubRepo(server.repository?.url)).filter((item): item is string => !!item), false)

  const entries: Entry[] = []
  const seenSources = new Set<string>()
  const add = (entry: Entry) => {
    const key = JSON.stringify(entry.source)
    if (seenSources.has(key)) return
    seenSources.add(key)
    entries.push(entry)
  }

  // Plugins from the marketplaces popular repos publish, each pointing back at its own repo.
  for (const repo of [...withFiles.values()].sort((a, b) => b.stars - a.stars)) {
    if (!repo.marketplace) continue
    const manifest = (() => {
      try {
        return JSON.parse(repo.marketplace)
      } catch {
        return undefined
      }
    })()
    for (const plugin of (manifest?.plugins ?? []).slice(0, 200)) {
      if (typeof plugin?.name !== "string" || !NAME.test(plugin.name)) continue
      const id = `${plugin.name}@${repo.full}`
      if (!listed(repo, id)) continue
      const source = pluginSource(plugin.source, repo.full)
      if (!source) continue
      add({
        name: unique(slug(plugin.name), repo.full.split("/")[0]!),
        description: plugin.description ?? repo.description,
        source,
        category: "plugin",
        tags: [...(plugin.tags ?? []), ...(plugin.keywords ?? [])].filter((tag: unknown) => typeof tag === "string").slice(0, 8),
        license: plugin.license ?? repo.license,
        homepage: plugin.homepage ?? `https://github.com/${repo.full}`,
        metadata: { stars: repo.stars, updated: repo.pushedAt, repo: repo.full, verified: verified.has(repo.full) || undefined, from: manifest.name },
      })
    }
  }

  // Skill collections and single skills that aren't already in a marketplace.
  for (const repo of [...withFiles.values()].sort((a, b) => b.stars - a.stars)) {
    if (repo.marketplace || !(repo.skillsDir || repo.rootSkill) || !listed(repo, repo.full)) continue
    add({
      name: unique(slug(repo.full.split("/")[1]!), repo.full.split("/")[0]!),
      description: repo.description,
      source: { source: "github", repo: repo.full },
      category: "skill",
      license: repo.license,
      homepage: `https://github.com/${repo.full}`,
      metadata: { stars: repo.stars, updated: repo.pushedAt, repo: repo.full, verified: verified.has(repo.full) || undefined },
    })
  }

  // MCP servers: one small plugin folder each, holding how to run it.
  await fs.rm(path.join(ROOT, "mcp"), { recursive: true, force: true })
  const seenServers = new Set<string>()
  // A repo that publishes a plugin already ships its server inside it, and one repo can list over a hundred
  // servers that would all inherit its stars.
  const perRepo = new Map<string, number>(entries.map((entry) => [entry.metadata.repo.toLowerCase(), Infinity]))
  for (const server of runnable) {
    const full = githubRepo(server.repository?.url)
    const repo = full ? mcpRepos.get(full.toLowerCase()) : undefined
    if (!repo || !listed(repo, server.name) || seenServers.has(server.name)) continue
    if (!verified.has(server.name) && !owns(server.name, repo.full)) continue
    const count = perRepo.get(repo.full.toLowerCase()) ?? 0
    if (count >= MAX_SERVERS_PER_REPO) continue
    perRepo.set(repo.full.toLowerCase(), count + 1)
    const run = runSpec(server)
    if (!run) continue
    seenServers.add(server.name)
    const base = slug(server.name.split("/").at(-1)!.replace(/^(mcp-server-|server-)/, "")) || slug(repo.full.split("/")[1]!)
    const name = unique(base.includes("mcp") ? base : `${base}-mcp`, repo.full.split("/")[0]!)
    const dir = path.join(ROOT, "mcp", name)
    await fs.mkdir(path.join(dir, ".dev-plugin"), { recursive: true })
    await Bun.write(
      path.join(dir, ".dev-plugin", "plugin.json"),
      JSON.stringify(
        { name, description: server.description, license: repo.license, mcpServers: { [base || name]: run.spec } },
        null,
        2,
      ) + "\n",
    )
    add({
      name,
      description: [server.title && server.title !== server.name ? server.title + ": " : "", server.description, run.needs.length ? ` Needs ${run.needs.join(", ")} in your environment.` : ""].join(""),
      source: `./mcp/${name}`,
      category: "mcp",
      license: repo.license,
      homepage: server.websiteUrl ?? `https://github.com/${repo.full}`,
      metadata: {
        stars: repo.stars,
        updated: repo.pushedAt,
        repo: repo.full,
        verified: verified.has(server.name) || verified.has(repo.full) || undefined,
        from: server.name,
        ...(run.needs.length ? { needs: run.needs } : {}),
      },
    })
  }

  entries.sort((a, b) => Number(b.metadata.verified ?? 0) - Number(a.metadata.verified ?? 0) || b.metadata.stars - a.metadata.stars)
  const marketplace = {
    $schema: "https://trydev.work/schema/marketplace.json",
    name: "dev",
    owner: { name: "DeV", url: "https://trydev.work" },
    description: "Popular, maintained plugins, skills and MCP servers, rebuilt nightly from public sources.",
    metadata: { generated: new Date().toISOString(), minStars: MIN_STARS },
    plugins: entries,
  }
  await fs.mkdir(path.join(ROOT, ".dev-plugin"), { recursive: true })
  await Bun.write(path.join(ROOT, ".dev-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 1) + "\n")
  const counts = entries.reduce<Record<string, number>>((all, entry) => ({ ...all, [entry.category]: (all[entry.category] ?? 0) + 1 }), {})
  console.log(`Wrote ${entries.length} entries`, counts)
}

function verifiedRepos() {
  return [...verified].filter((item) => /^[\w.-]+\/[\w.-]+$/.test(item))
}

await main()
