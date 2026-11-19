// Bundled themes in ghostty format, parsed by `parseGhosttyTheme`.
// `bs-accent`, `bs-orange` and `bs-cmd-color` are Beads Station extras: the
// interface accent and warm highlight are chosen per theme instead of being
// guessed from ANSI blue and yellow. Light or dark comes from the background.
import { parseGhosttyTheme, type ThemePalette } from '../lib/themeImport'

const RAW_THEMES: Array<{ id: string; source: string }> = [
  {
    // Verified against https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/ghostty/Fahrenheit. The accent and orange keep the colours the interface already derived, so the look is unchanged; typed commands use its bright orange.
    id: 'fahrenheit',
    source: `
background = #000000
foreground = #ffffce
cursor-color = #bbbbbb
selection-background = #4e739f
selection-foreground = #ffffce
palette = 0=#1d1d1d
palette = 1=#cda074
palette = 2=#9e744d
palette = 3=#fecf75
palette = 4=#7f0e0f
palette = 5=#734c4d
palette = 6=#979797
palette = 7=#ffffce
palette = 8=#404040
palette = 9=#fecea0
palette = 10=#cc734d
palette = 11=#fd9f4d
palette = 12=#cb4a05
palette = 13=#4e739f
palette = 14=#fed04d
palette = 15=#ffffff
bs-accent = #d2ab8b
bs-orange = #fecf75
bs-cmd-color = #fd9f4d
`,
  },
  {
    id: 'tokyonight-storm',
    source: `
background = #24283b
foreground = #c0caf5
cursor-color = #c0caf5
selection-background = #364a82
selection-foreground = #c0caf5
palette = 0=#1d202f
palette = 1=#f7768e
palette = 2=#9ece6a
palette = 3=#e0af68
palette = 4=#7aa2f7
palette = 5=#bb9af7
palette = 6=#7dcfff
palette = 7=#a9b1d6
palette = 8=#414868
palette = 9=#f7768e
palette = 10=#9ece6a
palette = 11=#e0af68
palette = 12=#7aa2f7
palette = 13=#bb9af7
palette = 14=#7dcfff
palette = 15=#c0caf5
bs-accent = #7aa2f7
bs-orange = #ff9e64
`,
  },
  {
    id: 'catppuccin-mocha',
    source: `
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
selection-background = #585b70
selection-foreground = #cdd6f4
palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#bac2de
palette = 8=#585b70
palette = 9=#f38ba8
palette = 10=#a6e3a1
palette = 11=#f9e2af
palette = 12=#89b4fa
palette = 13=#f5c2e7
palette = 14=#94e2d5
palette = 15=#a6adc8
bs-accent = #89b4fa
bs-orange = #fab387
`,
  },
  {
    id: 'gruvbox-dark',
    source: `
background = #282828
foreground = #ebdbb2
cursor-color = #ebdbb2
selection-background = #504945
selection-foreground = #ebdbb2
palette = 0=#282828
palette = 1=#cc241d
palette = 2=#98971a
palette = 3=#d79921
palette = 4=#458588
palette = 5=#b16286
palette = 6=#689d6a
palette = 7=#a89984
palette = 8=#928374
palette = 9=#fb4934
palette = 10=#b8bb26
palette = 11=#fabd2f
palette = 12=#83a598
palette = 13=#d3869b
palette = 14=#8ec07c
palette = 15=#ebdbb2
bs-accent = #83a598
bs-orange = #fe8019
`,
  },
  {
    // Cursor was #524f67 (nearly invisible on the background); now the foreground rose.
    id: 'rose-pine',
    source: `
background = #191724
foreground = #e0def4
cursor-color = #e0def4
selection-background = #403d52
selection-foreground = #e0def4
palette = 0=#26233a
palette = 1=#eb6f92
palette = 2=#31748f
palette = 3=#f6c177
palette = 4=#9ccfd8
palette = 5=#c4a7e7
palette = 6=#ebbcba
palette = 7=#e0def4
palette = 8=#6e6a86
palette = 9=#eb6f92
palette = 10=#31748f
palette = 11=#f6c177
palette = 12=#9ccfd8
palette = 13=#c4a7e7
palette = 14=#ebbcba
palette = 15=#e0def4
bs-accent = #9ccfd8
bs-orange = #f6c177
`,
  },
  {
    // White and bright white used to be the background colour (invisible text); they are now readable greys.
    id: 'one-light',
    source: `
background = #fafafa
foreground = #383a42
cursor-color = #526fff
selection-background = #dbe4fb
selection-foreground = #383a42
palette = 0=#383a42
palette = 1=#e45649
palette = 2=#50a14f
palette = 3=#c18401
palette = 4=#4078f2
palette = 5=#a626a4
palette = 6=#0184bc
palette = 7=#696c77
palette = 8=#4f525e
palette = 9=#e45649
palette = 10=#50a14f
palette = 11=#c18401
palette = 12=#4078f2
palette = 13=#a626a4
palette = 14=#0184bc
palette = 15=#383a42
bs-accent = #2f5bd0
bs-orange = #986801
`,
  },
  {
    // Official Dracula palette. Accent is its cyan: the interface keeps purple out of the accent role.
    id: 'dracula',
    source: `
background = #282a36
foreground = #f8f8f2
cursor-color = #f8f8f2
selection-background = #44475a
selection-foreground = #f8f8f2
palette = 0=#21222c
palette = 1=#ff5555
palette = 2=#50fa7b
palette = 3=#f1fa8c
palette = 4=#bd93f9
palette = 5=#ff79c6
palette = 6=#8be9fd
palette = 7=#f8f8f2
palette = 8=#6272a4
palette = 9=#ff6e6e
palette = 10=#69ff94
palette = 11=#ffffa5
palette = 12=#d6acff
palette = 13=#ff92df
palette = 14=#a4ffff
palette = 15=#ffffff
bs-accent = #8be9fd
bs-orange = #ffb86c
`,
  },
  {
    id: 'nord',
    source: `
background = #2e3440
foreground = #d8dee9
cursor-color = #d8dee9
selection-background = #434c5e
selection-foreground = #d8dee9
palette = 0=#3b4252
palette = 1=#bf616a
palette = 2=#a3be8c
palette = 3=#ebcb8b
palette = 4=#81a1c1
palette = 5=#b48ead
palette = 6=#88c0d0
palette = 7=#e5e9f0
palette = 8=#4c566a
palette = 9=#bf616a
palette = 10=#a3be8c
palette = 11=#ebcb8b
palette = 12=#81a1c1
palette = 13=#b48ead
palette = 14=#8fbcbb
palette = 15=#eceff4
bs-accent = #88c0d0
bs-orange = #d08770
`,
  },
  {
    id: 'kanagawa-wave',
    source: `
background = #1f1f28
foreground = #dcd7ba
cursor-color = #c8c093
selection-background = #2d4f67
selection-foreground = #c8c093
palette = 0=#090618
palette = 1=#c34043
palette = 2=#76946a
palette = 3=#c0a36e
palette = 4=#7e9cd8
palette = 5=#957fb8
palette = 6=#6a9589
palette = 7=#c8c093
palette = 8=#727169
palette = 9=#e82424
palette = 10=#98bb6c
palette = 11=#e6c384
palette = 12=#7fb4ca
palette = 13=#938aa9
palette = 14=#7aa89f
palette = 15=#dcd7ba
bs-accent = #7e9cd8
bs-orange = #ffa066
`,
  },
  {
    id: 'everforest-dark',
    source: `
background = #2d353b
foreground = #d3c6aa
cursor-color = #d3c6aa
selection-background = #475258
selection-foreground = #d3c6aa
palette = 0=#475258
palette = 1=#e67e80
palette = 2=#a7c080
palette = 3=#dbbc7f
palette = 4=#7fbbb3
palette = 5=#d699b6
palette = 6=#83c092
palette = 7=#d3c6aa
palette = 8=#5c6a72
palette = 9=#e67e80
palette = 10=#a7c080
palette = 11=#dbbc7f
palette = 12=#7fbbb3
palette = 13=#d699b6
palette = 14=#83c092
palette = 15=#e6dcc0
bs-accent = #a7c080
bs-orange = #e69875
`,
  },
  {
    // Official Solarized Light, except white and bright white (the background shades) are replaced by readable greys, and the accent is a darker blue so it reads on cream.
    id: 'solarized-light',
    source: `
background = #fdf6e3
foreground = #586e75
cursor-color = #586e75
selection-background = #eee8d5
selection-foreground = #586e75
palette = 0=#073642
palette = 1=#dc322f
palette = 2=#859900
palette = 3=#b58900
palette = 4=#268bd2
palette = 5=#d33682
palette = 6=#2aa198
palette = 7=#586e75
palette = 8=#002b36
palette = 9=#cb4b16
palette = 10=#586e75
palette = 11=#657b83
palette = 12=#839496
palette = 13=#6c71c4
palette = 14=#93a1a1
palette = 15=#073642
bs-accent = #1c6ea8
bs-orange = #cb4b16
`,
  },
  {
    id: 'github-dark',
    source: `
background = #0d1117
foreground = #e6edf3
cursor-color = #58a6ff
selection-background = #264f78
selection-foreground = #e6edf3
palette = 0=#484f58
palette = 1=#ff7b72
palette = 2=#3fb950
palette = 3=#d29922
palette = 4=#58a6ff
palette = 5=#bc8cff
palette = 6=#39c5cf
palette = 7=#b1bac4
palette = 8=#6e7681
palette = 9=#ffa198
palette = 10=#56d364
palette = 11=#e3b341
palette = 12=#79c0ff
palette = 13=#d2a8ff
palette = 14=#56d4dd
palette = 15=#f0f6fc
bs-accent = #58a6ff
bs-orange = #ffa657
`,
  },
  {
    id: 'github-light',
    source: `
background = #ffffff
foreground = #24292f
cursor-color = #0969da
selection-background = #b6e3ff
selection-foreground = #24292f
palette = 0=#24292f
palette = 1=#cf222e
palette = 2=#116329
palette = 3=#4d2d00
palette = 4=#0969da
palette = 5=#8250df
palette = 6=#1b7c83
palette = 7=#6e7781
palette = 8=#57606a
palette = 9=#a40e26
palette = 10=#1a7f37
palette = 11=#633c01
palette = 12=#218bff
palette = 13=#a475f9
palette = 14=#3192aa
palette = 15=#8c959f
bs-accent = #0969da
bs-orange = #bc4c00
`,
  },
  {
    id: 'monokai-pro',
    source: `
background = #2d2a2e
foreground = #fcfcfa
cursor-color = #fcfcfa
selection-background = #5b595c
selection-foreground = #fcfcfa
palette = 0=#403e41
palette = 1=#ff6188
palette = 2=#a9dc76
palette = 3=#ffd866
palette = 4=#fc9867
palette = 5=#ab9df2
palette = 6=#78dce8
palette = 7=#fcfcfa
palette = 8=#727072
palette = 9=#ff6188
palette = 10=#a9dc76
palette = 11=#ffd866
palette = 12=#fc9867
palette = 13=#ab9df2
palette = 14=#78dce8
palette = 15=#fcfcfa
bs-accent = #78dce8
bs-orange = #fc9867
`,
  },
]

export const BUNDLED_THEMES: ThemePalette[] = RAW_THEMES.map(({ id, source }) =>
  parseGhosttyTheme(id, source),
)

export const DEFAULT_THEME_ID = 'tokyonight-storm'
/** Pair used by "Match system appearance" until the user picks others. */
export const DEFAULT_LIGHT_THEME_ID = 'one-light'
export const DEFAULT_DARK_THEME_ID = DEFAULT_THEME_ID
