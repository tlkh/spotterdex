---
name: spotterdex-aircraft-3d
description: Reconstruct a specific aircraft variant and livery from SpotterDex photographs in Blender through an available Blender MCP, with evidence tracking, review checkpoints, and a web-ready export manifest.
metadata:
  short-description: Photo-guided aircraft reconstruction in Blender
---

# SpotterDex aircraft 3D

Use this skill for work inside the `aircraft-3d/` sub-project. Read [`aircraft-3d/README.md`](../../../aircraft-3d/README.md) for the current commands, paths, and environment truth before running helpers; this skill intentionally does not invent helper CLI arguments.

## Operating rules

- Treat `content/spotterdex.sqlite3` as read-only source data. Preserve canonical aircraft, unit, location, event, and photo IDs; never modify the public catalog as part of a model job.
- Begin intake by identifying the exact variant and livery. Record selected photo IDs/source paths, visible tail or serial markings, configuration, and confidence. If the tail identity is unknown, keep it explicitly unknown rather than merging photos from different airframes.
- Keep F-2A and F-2B geometry distinct. The first pilot brief is Mitsubishi F-2A, 8th Tactical Fighter Squadron, clean in-flight configuration (gear up, canopy closed, no external stores); do not import B-model assumptions without evidence.
- Separate reusable base geometry from livery, markings, and weathering. Build at real-world scale in a dedicated Blender scene and keep reference images out of the web export.
- Use the Blender MCP exposed in the current session for scene inspection, Python execution, visual feedback, saving, and export. Support the configured local Blender Lab MCP and the `ahujasid/mcp-for-blender` bridge without assuming either one is present; do not hard-code tool names—inspect the actually exposed MCP tools first. After a disconnect or ambiguous timeout, inspect scene state before repeating a mutation.
- Reach a credible silhouette and proportions before fine detail or materials. Require a human review milestone for the neutral-material silhouette, then another for livery placement. A successful GLB export is not evidence of photorealistic completion.
- Preserve provenance and uncertainty: cite sourced dimensions and mark inferred or unseen geometry in the project records. Do not present guesses as photographed facts.
- Save checkpoints at each milestone. Resuming a job must inspect and reuse the dedicated scene rather than duplicate objects or rerun destructive setup blindly.
- Generated renders, `.blend` files, textures, exports, and caches belong under the ignored `aircraft-3d/work/` tree. Keep reusable scripts and specifications tracked; never copy, reorganize, or modify `raw_assets/`.

## Workflow

1. Verify the Blender/MCP connection with a disposable or dedicated scene, including inspect, script execution, save/reopen, render, and GLB export smoke checks.
2. Build a labeled reference set from catalog photos. Distinguish geometry references from paint references, note missing views, and supplement dimensions only with cited sources.
3. Construct editable airframe components (fuselage, wings, intakes, canopy, tails, nozzle, and other visible forms). Compare neutral renders against references and stop for silhouette review.
4. Create UVs and export-safe PBR materials, then apply camouflage, insignia, squadron markings, and the selected serial/tail number. Stop for livery review before weathering.
5. Refine visible surface detail, produce review renders, save the editable master, export a self-contained GLB, and write the versioned export manifest. Keep unresolved areas and review status explicit.

## Quality and handoff

Use the pilot export budget from the project README (currently 200,000 triangles, 2K maps, and 25 MB GLB unless that README changes). Validate checkpoints and exports by inspecting scene state, render content, scale/orientation, materials, and manifest fields; file existence alone is not a successful validation. Optimize the web export separately from the editable master. The manifest is the future Three.js gallery boundary; do not add public-site routes, deployment, or gallery code while scaffolding this pipeline.
