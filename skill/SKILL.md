---
name: autocad-ai-modeling
description: Use the local AutoCAD 2026 MCP to create, inspect, modify and deliver native 2D drawings and 3D solids from natural-language designs, with measured geometry, DWG files and recorded tests.
---

# AutoCAD AI modeling

Use only AutoCAD for this workflow. The MCP server is `autocad-ai-mcp`; project location on this machine is `__PROJECT_ROOT__`.

1. Connect and read the active document. Do not replace an existing drawing or infer permission to discard unsaved work. New tasks normally use a new drawing.
2. Extract units, dimensions, coordinates, tolerances and required outputs. Default units are millimetres. List assumptions for missing noncritical dimensions; ask for critical ones. AutoCAD native solids are editable geometry, not a fabricated parametric feature tree.
3. Call `create_modeling_plan` with the actual request, assumptions and ordered operations before modeling. Reference previous results as `$stepId.handles.0`. Add checks of native dimensions, volumes, bounds and entity counts. Savepoints are available through `checkpoint`; `execute_modeling_plan` creates one before execution.
4. Test tasks must call `start_recording` before drawing and `stop_recording` even if the test fails. Keep AutoCAD visible. Use separate test drawings.
5. Prefer structured native tools over raw `execute_command`. Coordinates are WCS XYZ. Box origin is minimum corner; cylinder/cone origin is base centre; sphere/torus origin is centre. Angles are degrees. `get_topology` returns current face/edge indices; re-query after every topology edit.
6. Execute the saved plan once. Read every failure, do not ignore `isError`. A failed or cancelled plan cannot be replayed under the same ID. Inspect actual drawing state, revise only the remaining steps and use a new plan. COM rejected-before-execution retries are handled internally; do not retry an unknown completion.
7. Validate actual geometry. A screenshot or completed command is not proof of correct dimensions. Use `inspect_3d_model`, bounding dimensions, native solid volume and required counts. For holes, check centre/radius inputs plus Boolean removed volume; use independent cross-section or intersection checks for critical designs.
8. Recognizable repairs are limited: native solid cleanup, explicit polyline closure, and removal of confirmed duplicate entities. Use `repair_entity` or a revised explicit plan, at most two attempts per identified problem; preserve failed receipts. Never delete bounds-only duplicate candidates without confirming geometry.
9. Deliver DWG first. Export DXF/PDF/STL/image when requested and check actual files. Save, close and reopen the delivered DWG, then re-check geometry. Output paths must be under project `output` or `artifacts`; use unique filenames unless overwrite is explicitly intended.
10. Report measured results, output paths and actual test coverage. No simulated success, no claims of unrestricted CAD capability. `cancel_task` cancels between plan steps; an in-progress kernel operation may finish before cancellation.

For a tool schema, use the MCP's advertised schema. `trim_geometry` keeps a chosen segment after native curve-parameter splits. `fillet_geometry`/`chamfer_geometry` operate on two XY lines with explicitly supplied shared corner and kept endpoints. `set_line_type` uses a loaded linetype. PDF exports the current view/layout extents using the installed PDF plotter; inspect the result.

If tools are unavailable in the current chat, reload the MCP connection or start a new chat after registration. Do not claim registration alone proves tool discovery; use the official SDK client smoke tests in `scripts` to verify.
