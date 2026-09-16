# @pipeworx/hsr-notices

FTC Hart-Scott-Rodino (HSR) early-termination notices — the earliest public signal that a merger was filed for antitrust review and cleared, often days or weeks before an 8-K or press release for a private-target deal.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `hsr_recent(days=7, limit=25)` — most recent notices, newest first.
- `hsr_search(party, since?, limit=25)` — notices mentioning a company or fund, matched against the notice title (which embeds both parties and the transaction number).
- `hsr_party_history(party)` — every notice mentioning a party, oldest to newest, with a total count.
- `hsr_coverage()` — total notice count, earliest/latest dates on record, and the 2021 suspension gap (below).

## Auth

Optional `_apiKey` — an [api.data.gov](https://api.data.gov/signup/) key. Omit it to use the shared Pipeworx platform key. Passed as the `api_key` query parameter.

## The 2021 suspension gap

The FTC suspended HSR early-termination grants for about five weeks in 2021. This is a real gap in the underlying data, not missing Pipeworx coverage:

- Last notice before the gap: transaction `20210958`, dated 2021-02-03.
- No notices exist for 2021-02-04 through 2021-03-11.
- First notices after the gap: transactions `20210455`/`20210456`, dated 2021-03-12.

Early termination has resumed and stays current — `hsr_coverage()` reports the live latest-notice date on every call, and each empty-result response names this gap when the requested window overlaps it.

## Field notes

- `acquired_party` is often the ultimate parent entity or an individual, and can differ from `acquired_entities` (the array of actual operating subsidiaries being acquired). Both are always returned — never collapse the array into the parent name.
- Party names are the as-filed legal name, including fund vehicles (e.g. "American Securities Partners IX(B), L.P."). `hsr_search` and `hsr_party_history` match substrings of the notice title, so a shorter fragment finds more.
- `transaction_number` is `YYYY` + a sequence number.

## Data sources

- API: `https://api.ftc.gov/v0/hsr-early-termination-notices` (JSON:API-style, brokered by api.data.gov)
- Docs: https://www.ftc.gov/developer/api/v0/endpoints/hsr-early-termination-notices-api

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hsr-notices": {
      "url": "https://gateway.pipeworx.io/hsr-notices/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hsr-notices/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hsr-notices": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hsr-notices"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hsr-notices
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hsr Notices data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
