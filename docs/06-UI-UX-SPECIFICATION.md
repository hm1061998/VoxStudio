# 06 — UI/UX Specification

## Design direction

Desktop-first dark audio workstation. Professional, focused, high information density without visual clutter. Responsive tablet mode. Do not imitate a specific commercial product pixel-for-pixel.

## Main application shell

1. Left navigation: Dashboard, Projects, Voices, Presets, Pronunciation, Settings.
2. Top bar: project title, save status, locale, undo/redo, render, export.
3. Center workspace: text/segment editor.
4. Right inspector: voice, engine, style, synthesis controls, DSP.
5. Bottom dock: player, waveform/timeline, render queue.

## Required screens

### A. Authentication

Sign in, register, password reset, validation and error states.

### B. Dashboard

Recent projects, create project, search, sort, empty state.

### C. Project editor / Voice Studio

Segment list/editor, selected segment, voice settings, preview, autosave.

### D. Voice library

Filter locale/engine, preview, capability comparison, license/quality details.

### E. Preset manager

Built-in and custom presets, edit, duplicate, delete, apply.

### F. Pronunciation dictionary

Search, add/edit entry, locale and engine scope, preview.

### G. Audio timeline

Waveform, segment boundaries, playhead, playback, zoom, selection, silence gaps.

### H. Render center

Queue, progress, logs safe for users, retry/cancel, output history.

### I. Export dialog

Format, sample rate, channels, bit depth/bitrate, estimated size, download.

### J. Settings/admin

Profile, storage, engine health, approved engine/voice toggles.

## Voice Studio layout

- Left: ordered segments and text.
- Center: focused text editor and preview controls.
- Right: selected voice and settings.
- Bottom: timeline/player.
- Avoid making every setting visible at once; group into Voice, Timing, Emphasis, DSP, Advanced.

## Interaction rules

- A slider updates a draft setting; explicit preview applies it to audio.
- Show whether a setting is engine-native, DSP-derived, or unsupported.
- If unsupported, disable control and explain why.
- Preset application must show which values will change.
- Autosave debounce and show Saving/Saved/Save failed.
- Unsaved changes must be recoverable.
- Render button disabled only when genuinely invalid or already locked by policy.
- Never show 100% until the worker confirms completion and validates output.
- Destructive operations require confirmation.
- Keyboard shortcuts must be discoverable and not conflict with text editing.

## Visual states

Every data view must include loading, empty, error, and populated states. Audio controls include idle, loading, playing, paused, failed, and stale states. Render job states are queued/running/succeeded/failed/cancelled.

## Accessibility

- Semantic headings and landmarks.
- Labels for sliders and inputs.
- Keyboard-operable editor controls.
- Visible focus state.
- Color is not the only status indicator.
- Respect reduced motion.
- Contrast suitable for dark UI.

## Responsive behavior

- Desktop: full five-region studio.
- Tablet: collapsible left navigation and inspector drawer; timeline remains accessible.
- Small screens: support project review and playback; advanced editing may be explicitly limited rather than compressed into an unusable layout.

## UX copy

Use plain, honest language. Example: “Pitch shift (DSP)” rather than “Make voice sound naturally deeper.” Explain artifacts can occur at extreme settings.
