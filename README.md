# DeV marketplace

The default marketplace in [DeV Code](https://trydev.work): popular, maintained plugins, skills and MCP servers, rebuilt every night from public sources.

## What gets listed

- **MCP servers** from the official [MCP Registry](https://registry.modelcontextprotocol.io) that can run from an npm, PyPI or Docker package, or a fixed URL.
- **Plugins** from the plugin marketplaces that popular GitHub repos publish.
- **Skills** from GitHub repos of agent skills.

An entry is listed when its GitHub repo has at least 50 stars and a license, was pushed to in the last year, and isn't archived. A server must also come from the owner of the repo it names. One repo lists at most five servers. Entries in [`verified.json`](verified.json) are always listed and show a Verified badge.

Listing is not an endorsement. Read what a plugin adds before installing it: hooks and MCP servers run on your machine.

## Use it

DeV adds this marketplace for you. Any agent that reads the common plugin marketplace format can add it too:

```
devcode plugins marketplace add Harsha-code-per/dev-marketplace
```

To turn it off in DeV, set `"marketplaces": { "dev": { "source": "" } }` in your config.

## Build it yourself

```
GITHUB_TOKEN=$(gh auth token) bun scripts/build.ts
```

It writes `.dev-plugin/marketplace.json` and one small plugin folder per MCP server under `mcp/`.

## Ask for a change

Open an issue to add a Verified entry, or to report a listing that misleads or shouldn't be here.
