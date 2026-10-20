---
name: SN 扫码登记工具
description: A compact dark workspace for checking device identifiers against photographs.
colors:
  action-yellow: "#ffc700"
  ocr-green: "#35d07f"
  canvas-black: "#000000"
  workbench-surface: "#101010"
  image-stage: "#080808"
  pressed-surface: "#161616"
  selected-surface: "#242424"
  divider: "#303030"
  field-border: "#444444"
  white: "#ffffff"
  control-text: "#dedede"
  body-text: "#cccccc"
  supporting-text: "#aaaaaa"
  error-text: "#ff6b6b"
  error-border: "#f00007"
typography:
  title:
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace'
    fontSize: "14px"
    lineHeight: "20px"
  label:
    fontSize: "12px"
    lineHeight: "16px"
  section-title:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
rounded:
  square: "0px"
spacing:
  compact: "8px"
  control: "12px"
  panel: "16px"
  wide: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action-yellow}"
    textColor: "{colors.canvas-black}"
    rounded: "{rounded.square}"
    padding: "0 20px"
  button-outline:
    textColor: "{colors.control-text}"
    rounded: "{rounded.square}"
    padding: "0 12px"
  ocr-row:
    textColor: "{colors.body-text}"
    rounded: "{rounded.square}"
    padding: "8px"
  ocr-row-selected:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.white}"
---

# Design System: SN 扫码登记工具

## Overview

**Creative North Star: "The Device Inspection Workbench"**

This records the incumbent visual language as shipped in the image workbench, recognition results, and records screens. It extends an existing task interface: black surfaces, yellow actions, green recognition annotations, square controls, and compact technical text. The name describes the built interface; it is not a newly selected brand direction.

Photographs are working evidence. Controls, OCR rows, numeric boundaries, and export previews surround them with clear separators and limited decoration. Density supports comparing identifiers and image regions while keeping confirmation actions visible.

**Key Characteristics:**
- Black and charcoal surfaces with thin separators.
- Yellow for actions, selections, and crop boundaries; green for OCR annotations and verified status.
- Compact monospace identifiers and restrained section headings.
- Square controls and a persistent confirmation area.

Scope and evidence: `src/index.css`, `src/components/ImageWorkbench.tsx`, `src/components/RecordImageEditor.tsx`, `src/sections/MultiResultView.tsx`, and `src/sections/RecordsView.tsx`. The extension inherits the direction recorded in `docs/plans/2026-10-20-image-workbench.md`; reviewed desktop and mobile captures are in `.impeccable/review/`. Unused library theme variables are not the visual authority for these screens.

## Colors

A near-black neutral field lets photographs and functional yellow and green accents remain distinct. Frontmatter contains the reusable values; contextual hover shades remain component details.

### Primary
- **Action Yellow:** primary confirmation and export actions, active view/crop modes, crop boundaries, and visible keyboard focus. It also carries manual-confirmation status, so accompanying labels establish meaning.

### Secondary
- **OCR Green:** genuine OCR text bounds in the workbench and verified records. In recognition results, green also identifies barcode bounds; retain each surface's explicit legend and status text.

### Neutral
- **Canvas Black / Workbench Surface / Image Stage:** the app background, fullscreen editor, and photographic workspace respectively.
- **Pressed Surface / Selected Surface:** subtle interaction feedback in controls and selected OCR rows.
- **Divider / Field Border:** panel boundaries and input or action outlines.
- **White / Control Text / Body Text / Supporting Text:** primary content, toolbar controls, OCR rows, and secondary explanations.
- **Error Text / Error Border:** explicit mismatch, recognition failure, and destructive confirmation treatments.

### Named Rules

**The Evidence Color Rule.** Keep yellow crop bounds and green OCR bounds visually distinct in the workbench, and pair status colors with explanatory text.

## Typography

**Body Font:** the global monospace stack recorded in frontmatter, including Chinese fallbacks.

**Label/Mono Font:** explicit utility-based monospace remains on identifiers, counters, dimensions, and incumbent record actions. These utilities use Tailwind's monospace stack; they do not create a separate display identity.

**Character:** small, technical, and task-focused. The workbench inherits the body stack; its preview disclaimer explicitly uses a sans-serif utility. No display-face hierarchy is established by this extension.

### Hierarchy
- **Title:** compact semibold dialog heading; the workbench overrides size while retaining the dialog title's tight leading.
- **Section title:** semibold preview, crop-boundary, and OCR-list headings.
- **Body:** control labels and editable values use the compact body size.
- **Label:** supporting text, dimensions, and OCR rows use the smaller label size. OCR rows use more generous leading (20px) for wrapping.
- **Identifiers:** record SN values use base-size monospace with tracking (0.12em). Incumbent main export actions use bold, widely tracked monospace; workbench toolbar controls use normal tracking.

### Named Rules

**The Identifier Rule.** Keep identifiers, image dimensions, and numeric counters in monospace; allow long OCR text to wrap and break within the available width.

## Layout

The app occupies the dynamic viewport height (100dvh). The workbench is a fullscreen dialog with nonshrinking header, wrapping toolbar, flexible central workspace, and nonshrinking footer. Content panes scroll internally; the footer remains available as the image or OCR list grows.

At the medium breakpoint (768px), the workbench places the image beside a fixed-width sidebar (320px). Below it, the panes stack: the image takes the remaining space and the lower preview/text pane receives 34% of the central grid. At the small breakpoint (640px), horizontal workbench padding grows from panel to wide spacing, zoom control width increases, and the records crop action reveals its text label.

Use the observed compact, control, panel, and wide spacing rhythm for gaps and padding. Header and footer respect safe-area insets, with minimum top/bottom padding. The image stage fits the complete image initially, retains padding around it, and scrolls when zoomed. Four boundary inputs share equal columns. Records use separated rows rather than a tiled card grid.

## Elevation & Depth

The interface primarily separates regions using charcoal tones and thin borders. Dialogs retain the shared library's soft shadow and dark overlay; the fullscreen workbench suppresses its opening/closing animation. Crop selection dims the outside image with a mask-like shadow. This is spatial editing feedback, not a card-elevation convention.

### Named Rules

**The Evidence Plane Rule.** Keep OCR and crop overlays anchored to the image coordinate plane; contain their number badges within the image.

## Shapes

All elements inherit a global square-corner override (zero radius, marked important). The library's radius variables and rounded utilities therefore do not establish a rounded component system. Controls, fields, panels, badges, and region outlines use rectangular geometry. Borders are generally thin (1px); crop bounds use a stronger outline (2px).

## Components

### Buttons

Compact, explicit actions with square edges.

- **Primary:** yellow fill with black text. Workbench confirmation has a minimum height (44px), semibold text, and horizontal padding (20px); hover darkens the fill. Main record export actions stretch across the available width.
- **Outline:** transparent controls with a charcoal border, minimum height (40px), horizontal padding (12px), and compact icon/text gaps (8px). Workbench hover adds a subtle charcoal fill.
- **Selected mode:** yellow text and border, with `aria-pressed` reflecting view/crop state.
- **Focus:** visible yellow outlines on workbench controls, OCR rows, crop-entry actions, and export-quality fields. Confirmation uses an offset outline.
- **Disabled:** subdued opacity on toolbar actions; incumbent large export buttons use charcoal fill and muted text.
- **Icons:** the extension uses small inline stroke SVG icons alongside labels, or accessible names for icon-only close/crop controls.

### Chips

Recognition status labels are thin outlined rectangular tags. Green identifies agreement, red identifies mismatch, and yellow identifies pending or partial evidence. Text names the state; color supplements it.

### Cards / Containers

The workbench uses contiguous tonal panes separated by thin charcoal borders. Candidate containers use thin outlines and compact padding; active candidates gain yellow borders and a faint yellow fill. Records remain flat separated rows. Do not generalize the dialog library's soft shadow into a raised-card style.

### Inputs / Fields

Crop boundaries are four labeled numeric fields with dark fill, charcoal stroke, square edges, minimum height (40px), and a yellow outline color. The export-quality selector uses the same dark rectangular field language. Zoom is a native range input accented yellow; the OCR visibility checkbox is accented green.

### Navigation

Navigation is local and task-based: an outlined back action in record headers, view/crop modes in the workbench toolbar, and an explicit close control. Toolbar items wrap on narrow screens. The record crop action hides its label below the small breakpoint while preserving an accessible name.

### Image and OCR Workbench

The full image is the coordinate reference. All real OCR boxes appear when enabled; selecting an OCR row reveals the boxes and highlights its matching region with white outline and translucent white fill. Normal OCR bounds have green outlines and faint green fill, with numbered dark-green labels. The crop region uses yellow bounds, a yellow dimension badge, and a dimmed exterior. The export preview shows the actual derived image and its dimensions and size. Missing coordinates receive explanatory text rather than invented boxes.

## Do's and Don'ts

### Do:
- **Do** use square geometry and tonal separation for these task surfaces.
- **Do** retain visible keyboard focus on workbench actions and fields.
- **Do** distinguish crop bounds from OCR bounds and explain status in text.
- **Do** keep image controls and confirmation available while content panes scroll.
- **Do** preserve image-bound annotations and wrap long OCR text within its pane.

### Don't:
- **Don't** treat unused light-theme variables or library radius settings as the shipped screen palette or shape system.
- **Don't** manufacture OCR region outlines when coordinates are unavailable.
- **Don't** turn the crop dimming mask into a general panel shadow.
- **Don't** promote inherited decorative glyph icons or very low-contrast incidental metadata into reusable component rules.
