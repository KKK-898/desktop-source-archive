---
name: gaoge-image
description: Generate or edit images and create GIF animations through available Gaoge MCP tools, including explicit Image 2, 2.5F/S, and 2.6F/S requests. Use for the Gaoge workflow; does not apply when its tools are unavailable or the user requests official image generation.
---

# Gaoge Image

Use the installed Gaoge MCP tool directly. This workflow is self-contained; do not repeat completed skill reads or load official image_gen/CLI instructions for this route.

Preserve an explicitly requested model:

| Request | Tool |
| --- | --- |
| 2 / Image 2 | gaoge_generate_image_2 |
| 2.5F / 2.5 Flare | gaoge_generate_image_2_5_flare |
| 2.5S / 2.5 Sunburst | gaoge_generate_image_2_5_sunburst |
| 2.6F / 2.6 Flare / unversioned Flare | gaoge_generate_image_2_6_flare |
| 2.6S / 2.6 Sunburst / unversioned Sunburst | gaoge_generate_image_2_6_sunburst |

With no model specified, use 2.6F. Do not silently change a requested model or provider, including after an access error. Report unavailable models or GIF access; do not downgrade to 2.5, convert a GIF request into a still image, or run paid capability probes.

- For authorized generation, send a concise prompt and preserve explicit size, quality, and count choices. Otherwise use medium quality and one image. For 2.6, `complexity` is separate from `quality`: use `low`, `medium`, or `high` when requested; omission uses the model default of high.
- Edit with `reference_image_resource_uris` from this conversation's returned resourceUri or `reference_image_paths` from an explicitly identified local image. A straightforward edit does not need a prior view call. Never guess another conversation's or globally latest image.
- For GIF, use a 2.6 tool with `output_format: "gif"`. This integration supports text-to-GIF only; omit reference images. Defaults are `size: "auto"`, `image_count: 1`, `frame_count: 9`, and `frame_duration_ms: 200` (a 1.8-second cycle). Supported controls are 2–16 frames and 20–2000 ms per frame; use a delay that is a multiple of 10 ms. Describe the motion and intended loop in the prompt. If the user explicitly selected 2 or 2.5 for GIF, explain that this mode requires 2.6 before changing models. Do not send GIF frame controls for still images.
- Deliver the returned media card or embed the returned absolute local path. Preserve the `.gif` result when animation was requested. Ordinary generation does not require a separate view call.
- To analyze, check, or compare a specific image, obtain visual input once using `gaoge_view_generated_image` when it is not already present. A generation report or metadata does not prove visual correctness. A still GIF preview does not establish movement, timing, or a seamless loop; describe only frames actually observed and state the limitation when animation inspection is unavailable.
- Do not change global model/reasoning settings, run paid speed tests, or repeatedly regenerate an already delivered result without a user request. Report failure without unlimited retries.
