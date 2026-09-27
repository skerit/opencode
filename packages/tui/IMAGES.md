# Inline Images

The TUI previews persisted image attachments in user messages, completed tool results, and assistant file parts. The existing `read` tool, custom tools, and MCP tools already expose these attachments to models. Rendering them does not add a tool or modify the conversation sent to a provider.

## Rendering

Automatic selection uses high-resolution Kitty Unicode placeholders when RGB, Kitty graphics, and a known placeholder-capable terminal are detected. Kitty, Ghostty, Otty, Rio, and sketerm are currently recognized. Direct sketerm sessions are recognized through the terminal's version response or `TERM_PROGRAM`, even when OpenTUI does not report its graphics capability; multiplexer sessions still require the graphics capability. Otherwise the viewer uses full-color half-block character cells, which integrate with ordinary clipping and scrolling but are not high-resolution raster graphics.

Set `OPENCODE_IMAGE_PROTOCOL` in the TUI process environment to override selection:

| Value           | Behavior                                                   |
| --------------- | ---------------------------------------------------------- |
| `auto` or unset | Capability-based selection                                 |
| `kitty`         | Force Kitty placeholders; the terminal must support them   |
| `blocks`        | Always use character-cell previews                         |
| `off`           | Keep attachment labels and layout, without decoding pixels |

Kitty commands are wrapped for tmux when detected. The outer terminal must support placeholders and tmux must allow passthrough; OpenCode does not enable it automatically. Screen and Zellij default to blocks. iTerm2 and Sixel raster backends are not implemented.

Tool-result images obey the existing Show/Hide tool details control. Draft prompt previews are not added; submitted images render in the conversation.

## Safety And Resources

- Only canonical inline base64 PNG, JPEG, GIF, and static WebP data is decoded. SVG, animated WebP, unsupported types, damaged files, remote URLs, and local file URLs produce labels rather than being fetched or opened. GIF previews are static.
- Input is limited to 10 MiB of base64. Headers are checked before pixel decoding, with limits of 8192 pixels per side and 16 Mi-pixels total.
- Display renditions are at most 1000x1000 pixels and 8 MiB of combined RGBA/PNG data. The shared LRU holds at most 16 entries and 32 MiB.
- Each renderer owns at most eight pending/decoded previews, up to 64 MiB of retained pixel data in addition to the cache. Transient decoding and WASM allocations are separate from these retained-memory bounds.
- Hidden and offscreen images retain their dimensions and layout, but release pixel ownership. Only visible previews are decoded. Disabled previews inspect headers without running the pixel decoder.
- Previews fit the actual parent width, at most 80 columns and 20 rows or 60% of terminal height. Reported pixel dimensions preserve physical aspect ratio where available; otherwise a 1:2 cell aspect ratio is assumed. Cell rounding makes fitting approximate.
- Kitty uploads use randomized, locally unique 24-bit IDs and transmit once per resident rendition. Placement changes, viewport eviction, suspension, external editors, and shutdown are renderer-owned. Cleanup deletes only tracked image IDs, never all terminal images.
- Display resizing never changes persisted image attachments or provider input.

## Forked Conversations

`packages/opencode/src/session/llm/fork.ts` stores media-bearing provider snapshots using a versioned JSON codec. Binary file data is encoded with explicit byte tags, URL objects with URL tags, and supported tool-content variants retain their original data and order. Inheritance reconstructs fresh SDK-facing values without fetching, resizing, or re-encoding images. Existing v1 text-only snapshots remain readable.

Only known media fields interpret codec tags; tag-shaped application JSON is not rewritten. Provider options, cache markers, tool definitions, and the OpenAI OAuth cache-routing identity remain part of the inherited prefix. Display protocol selection is independent of model image support.

## Verification

From `packages/tui`:

```sh
bun test
bun typecheck
```

Tests exercise actual Session-route hydration and live part updates, native OpenTUI cell/color buffers, viewport ownership, idle cached redraws, resizing, clipping, overlays, and suspend/destroy cleanup. Kitty tests feed real renderer output into the Kitty VT WASM parser, including placeholder coordinates and simulated tmux unwrapping. They are not a substitute for testing every terminal application or an actual tmux graphics passthrough setup.

The pinned `kitty-vt-wasm` test dependency exposes graphics command events rather than decoded image pixels. PNG payloads are therefore validated with Photon; a separate expected-failure test records that dependency's duplicate named-placement bookkeeping limitation.

The oc11 `smoke --tui --images` script verifies the compiled host in a real tmux session using the block backend, including image-only messages and narrow/restored window sizes, without inference. `fork-smoke --live --astra --image` checks genuine OpenAI OAuth cache usage with an image before the inherited text prefix. Both scripts isolate configuration and data; only the latter makes model requests.
