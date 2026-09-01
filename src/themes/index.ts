// Bundled themes in ghostty format. Imported as raw strings so the parser
// can be tested independently of the bundler.
import { parseGhosttyTheme, type ThemePalette } from '../lib/themeImport'

const RAW_THEMES: Array<{ id: string; source: string }> = [
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
`,
  },
  {
    id: 'gruvbox-dark',
    source: `
background = #282828
foreground = #ebdbb2
cursor-color = #ebdbb2
selection-background = #3c3836
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
`,
  },
  {
    id: 'rose-pine',
    source: `
background = #191724
foreground = #e0def4
cursor-color = #524f67
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
`,
  },
  {
    id: 'one-light',
    source: `
background = #fafafa
foreground = #383a42
cursor-color = #526fff
selection-background = #e5e5e6
selection-foreground = #383a42
palette = 0=#383a42
palette = 1=#e45649
palette = 2=#50a14f
palette = 3=#c18401
palette = 4=#4078f2
palette = 5=#a626a4
palette = 6=#0184bc
palette = 7=#fafafa
palette = 8=#4f525e
palette = 9=#e45649
palette = 10=#50a14f
palette = 11=#c18401
palette = 12=#4078f2
palette = 13=#a626a4
palette = 14=#0184bc
palette = 15=#fafafa
`,
  },
]

export const BUNDLED_THEMES: ThemePalette[] = RAW_THEMES.map(({ id, source }) =>
  parseGhosttyTheme(id, source),
)

export const DEFAULT_THEME_ID = 'tokyonight-storm'
