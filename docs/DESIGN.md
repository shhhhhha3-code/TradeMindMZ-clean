## Vibe
- Cyberpunk trading terminal × industrial blueprint — dark precision instrument, neon data-on-black, phosphor readouts. Inspired by: Bloomberg Terminal aesthetics filtered through Cyberpunk 2077 UI.

## Color
- Primary: #7C3AED
- On Primary: #FFFFFF
- Accent: #22C55E
- On Accent: #0A0A0A
- Background: #0D0F14
- Foreground: #E8EAF0
- Muted: #1A1D26
- Border: #252836
- Secondary: #5B21B6

## Typography
- Heading: Space Grotesk (family: 'Space Grotesk', sans-serif, weight: 700, url: https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap)
- Body: Inter (family: 'Inter', sans-serif, weight: 400, url: https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap)

## Visual Language
- Core visual signature: Phosphor-glow data readouts — key metrics have a tight `text-shadow` halo in the semantic color (purple for AI score, green for profit/recommended, orange for watch, red for loss/rejected). Thin scanline separator lines (1px border-border/40) divide pipeline stages.
- Material & depth: Three elevation layers: page bg (#0D0F14) → card surface (#111318 with subtle gradient) → elevated panel (#181C26). No box-shadows on dark surfaces; depth via background-color steps and border brightness. Active/hover cards get a 1px primary/30 border glow.
- Containers & buttons: Cards use `border border-border rounded-xl` with `bg-card` (slightly lighter than bg). Pipeline funnel nodes use monospace-label + neon border-left accent. Primary CTA: `bg-primary text-white`. Secondary: `bg-secondary text-secondary-foreground`. Status badges: filled pill with semantic bg/15 + border/30 + text in semantic color.
- Layout rhythm: Sidebar always present on desktop; content area has dense information blocks separated by 1px dividers. Top pipeline bar (5 metric tiles) spans full width. Main content: 2/3 opportunity cards + 1/3 diagnostics sidebar on desktop; stacked on mobile. Neon accent used sparingly: score numbers, active states, key metrics only.

## Animation
- Entrance: Score rings animate stroke-dashoffset on mount, 800ms ease-out.
- Interaction: Card hover — 150ms border-color transition to primary/30, translateY(-1px).
- Scroll / transition: Pipeline stage arrows pulse opacity 0.4→1 on new data arrival (CSS animation).

## Forbidden
- Large saturated color fills (no full bg-primary sections)
- Generic blue-to-purple gradient backgrounds
- Decorative emoji in headers, navigation, or labels

## Additional Notes
- green (#22C55E) = RECOMMENDED / WIN / positive / active
- orange (#F59E0B) = WATCH / warning / aging
- red (#EF4444) = NO_TRADE / LOSS / rejected / risk
- purple (#7C3AED) = AI score / primary intelligence / active state
- All status text uses uppercase monospace-style labels (font-mono text-xs tracking-wide)
- Pipeline funnel: left-border accent color changes per stage (purple→green gradient from top to bottom)
- Score rings: SVG circles with stroke in semantic color based on score value
- Signals page filters: pill-style toggle group, not dropdown
