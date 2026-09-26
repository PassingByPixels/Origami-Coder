// claudeCodeFixtures.ts — REAL Claude Code CLI stdout lines.
//
// Provenance: a live session driven on this machine on 2026-08-30 with
// CLI 2.1.198 (spike/drive.mjs, arg vector identical to protocol.buildArgs
// minus --permission-mode), captured verbatim to spike/transcript_run1.txt.
// This module is GENERATED from that transcript (scratchpad/genfixtures.mjs),
// never hand-typed: the house rule is that fixtures for an external contract
// are derived from the external thing. The RUN1_* names below carry the
// transcript line number they came from.
//
// Two lines are trimmed, mechanically and identically to how they were
// captured — the trim is noted on each. Nothing else is altered: not a
// character of key order, whitespace or escaping.
//
// One exception, made for the public source: the account e-mail,
// organisation and plan, the private skill descriptions, and the private
// skill, command and MCP server names are replaced with neutral values. The replacement is
// name for name, so every list keeps its length, order and structure.

/* eslint-disable */

/** transcript_run1.txt line 5 — system/status arrives BEFORE the initialize response — event order is not guaranteed. */
export const RUN1_SYSTEM_STATUS_BEFORE_INIT =
  "{\"type\":\"system\",\"subtype\":\"status\",\"status\":null,\"permissionMode\":\"default\",\"uuid\":\"9161be80-dcc5-4689-89cb-845ecec56f11\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\"}";

/** transcript_run1.txt line 6 — TRIMMED: every array cut to 1 entry (the real line is 19,306 chars of this box's command roster). */
export const RUN1_INITIALIZE_RESPONSE =
  "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"x_1\",\"response\":{\"commands\":[{\"name\":\"make-asset\",\"description\":\"Create one game asset (a prop, weapon or piece of armour) through a browser review tool: you start it once, then the user approves each stage (images, mesh, cleanup, export) in a review page that refreshes itself. You only step in again to debug a failed stage. Use when the user asks to make an asset. (user)\",\"argumentHint\":\"<what to make, e.g. 'a rusted iron helmet'>\"}],\"agents\":[{\"name\":\"AI Engineer\",\"description\":\"Expert AI/ML engineer specializing in machine learning model development, deployment, and integration into production systems. Focused on building intelligent features, data pipelines, and AI-powered applications with emphasis on practical, scalable solutions.\"}],\"output_style\":\"default\",\"available_output_styles\":[\"default\",\"Proactive\",\"Explanatory\",\"Learning\"],\"models\":[{\"value\":\"default\",\"resolvedModel\":\"claude-opus-4-8[1m]\",\"displayName\":\"Default (recommended)\",\"description\":\"Opus 4.8 with 1M context · Best for everyday, complex tasks\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"supportsAdaptiveThinking\":true,\"supportsFastMode\":true,\"supportsAutoMode\":true},{\"value\":\"opus[1m]\",\"resolvedModel\":\"claude-opus-4-8[1m]\",\"displayName\":\"Opus\",\"description\":\"Opus 4.8 with 1M context · Best for everyday, complex tasks\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"supportsAdaptiveThinking\":true,\"supportsFastMode\":true,\"supportsAutoMode\":true},{\"value\":\"claude-fable-5[1m]\",\"resolvedModel\":\"claude-fable-5\",\"displayName\":\"Fable\",\"description\":\"Fable 5 · Most capable for your hardest and longest-running tasks\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"supportsAdaptiveThinking\":true,\"supportsAutoMode\":true},{\"value\":\"sonnet\",\"resolvedModel\":\"claude-sonnet-5\",\"displayName\":\"Sonnet\",\"description\":\"Sonnet 5 · Efficient for routine tasks\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"supportsAdaptiveThinking\":true,\"supportsAutoMode\":true},{\"value\":\"haiku\",\"resolvedModel\":\"claude-haiku-4-5-20251001\",\"displayName\":\"Haiku\",\"description\":\"Haiku 4.5 · Fastest for quick answers\"}],\"account\":{\"email\":\"user@example.com\",\"organization\":\"Example Org\",\"subscriptionType\":\"Example Plan\",\"apiProvider\":\"firstParty\"},\"pid\":50516,\"feedback_survey_config\":{\"minTimeBeforeFeedbackMs\":300000,\"minTimeBetweenFeedbackMs\":3600000,\"minTimeBetweenGlobalFeedbackMs\":43200000,\"minUserTurnsBeforeFeedback\":3,\"minUserTurnsBetweenFeedback\":5,\"hideThanksAfterMs\":3000,\"onForModels\":[\"*\"],\"probability\":0.25,\"lastSurveyShownTime\":1788093426018}}}}";

/** transcript_run1.txt line 7 — TRIMMED: tools/slash_commands/agents/skills/mcp_servers cut to 3 entries each. */
export const RUN1_SYSTEM_INIT =
  "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\c--Users-dev-Desktop-Workspace\\\\86d82c38-23ee-4d0d-87e9-b6a9d26d7537\\\\scratchpad\\\\spike\\\\cwd\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"tools\":[\"Task\",\"AskUserQuestion\",\"Bash\"],\"mcp_servers\":[{\"name\":\"blender\",\"status\":\"pending\"},{\"name\":\"tasks\",\"status\":\"pending\"}],\"model\":\"claude-haiku-4-5-20251001\",\"permissionMode\":\"default\",\"slash_commands\":[\"make-asset\",\"review-code\",\"plan-mode-helper\"],\"apiKeySource\":\"none\",\"claude_code_version\":\"2.1.198\",\"output_style\":\"default\",\"agents\":[\"AI Engineer\",\"claude\",\"Embedded Firmware Engineer\"],\"skills\":[\"make-asset\",\"review-code\",\"plan-mode-helper\"],\"plugins\":[],\"analytics_disabled\":false,\"product_feedback_disabled\":false,\"uuid\":\"57b39cda-c4d2-4e47-93f8-cfdeeb45c35e\",\"memory_paths\":{\"auto\":\"C:\\\\Users\\\\dev\\\\.claude\\\\memory\\\\\"},\"fast_mode_state\":\"off\"}";

/** transcript_run1.txt line 8 — an unknown-to-us system subtype: must be tolerated, never rendered. */
export const RUN1_SYSTEM_STATUS_REQUESTING =
  "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"uuid\":\"7fe4369e-1fc0-441a-9178-d58c183b13de\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\"}";

/** transcript_run1.txt line 9 — rate_limit_event, status allowed_warning at 80% of the seven-day window. */
export const RUN1_RATE_LIMIT_EVENT =
  "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":1788195600,\"rateLimitType\":\"seven_day\",\"utilization\":0.8,\"isUsingOverage\":false,\"surpassedThreshold\":0.75},\"uuid\":\"6e02e96c-db17-47c8-b29b-d911a4fe5218\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\"}";

/** transcript_run1.txt line 10 — stream_event/message_start — carries the resolved model id. */
export const RUN1_MESSAGE_START =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeZJCM3p7sc4ehkWmgnof\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":36352,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":36352},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"18df3efa-ae1b-432b-8076-16796ab42eb2\",\"ttft_ms\":1023}";

/** transcript_run1.txt line 11 — content_block_start, thinking (haiku emits thinking even for a one-word answer). */
export const RUN1_BLOCK_START_THINKING =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"e5e9879e-cc06-4d67-a4e7-3718a9246df8\"}";

/** transcript_run1.txt line 12 — system/thinking_tokens — another unknown subtype. */
export const RUN1_THINKING_TOKENS =
  "{\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":1,\"estimated_tokens_delta\":1,\"uuid\":\"c5b660eb-6bc9-4cce-8911-047d6572f40f\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\"}";

/** transcript_run1.txt line 13 — thinking_delta. */
export const RUN1_THINKING_DELTA_1 =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"The\",\"estimated_tokens\":null}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"c4e75c5f-9c55-41db-aadf-296bd028a9f2\"}";

/** transcript_run1.txt line 15 — thinking_delta with an embedded quote + newlines. */
export const RUN1_THINKING_DELTA_2 =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" user is asking me to reply with the single word PONG and nothing else. They explicitly state \\\"Do not use any tools.\\\"\\n\\nThis is a simple test/ping\",\"estimated_tokens\":null}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"75d7f15b-bd25-46ea-8f5a-768e1bb50490\"}";

/** transcript_run1.txt line 19 — signature_delta — carries no user-visible text. */
export const RUN1_SIGNATURE_DELTA =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"EtYDCrIBCBEYAipAZGJIpu+DLMROmLztafRW2KeiMfa5u2YwDo59RG/TtWZRpghl1YJwabpb+oLy/Jz8q1ErVPVGnFpGrerxmLe4xjIZY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMTgAQgh0aGlua2luZ1okMDRmOGQ5MmItMDlkNC00YzAyLTlhZTQtMjkwYTg1OGJhYzU2chAyuP6EdNd4oH+pT3N9nCp0iAEBqAHZxdHUBrABAhIM1g2NnUdiTvcvaoOcGgyh2+zwcmjNtqo3yH4iMFhaL2ffXOzK+hweu1RPbX2pUzvfKnIpuUB+YvXoiUAFywBPk5GOHTzyjYC65FnhQirQAU/huMrC7CAfKTyIPUpyOi45NzW+yv+tFMAKMCVOsXTlgDEmrDgU8LHeugnx+LjBFadqyOi6qaH5h1yFCYmuLGI2ZKK8Gds6jexqTaGwKltKBeUeJjAJNvduN5w8Xq/XKWMTjLifcjsVkhHWE/5D9qL5yd+WOTDCrOE6Dg2j/UhuycRT/shrboM8FjubBH9h7pGMHCUUpKhGos6jKGxLF8MEbsn9DN8unu3YfdweJxMbanWhr05CbvBFxK/O9Sg3TNtcITWEp5UactkmqFF5ZFoYAQ==\"}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"65e5b8a1-487b-452d-8de4-39eb5e411fb6\"}";

/** transcript_run1.txt line 20 — assistant event for the COMPLETED thinking block (already streamed as deltas). */
export const RUN1_ASSISTANT_THINKING_BLOCK =
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeZJCM3p7sc4ehkWmgnof\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"The user is asking me to reply with the single word PONG and nothing else. They explicitly state \\\"Do not use any tools.\\\"\\n\\nThis is a simple test/ping request. I should just respond with \\\"PONG\\\".\",\"signature\":\"EtYDCrIBCBEYAipAZGJIpu+DLMROmLztafRW2KeiMfa5u2YwDo59RG/TtWZRpghl1YJwabpb+oLy/Jz8q1ErVPVGnFpGrerxmLe4xjIZY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMTgAQgh0aGlua2luZ1okMDRmOGQ5MmItMDlkNC00YzAyLTlhZTQtMjkwYTg1OGJhYzU2chAyuP6EdNd4oH+pT3N9nCp0iAEBqAHZxdHUBrABAhIM1g2NnUdiTvcvaoOcGgyh2+zwcmjNtqo3yH4iMFhaL2ffXOzK+hweu1RPbX2pUzvfKnIpuUB+YvXoiUAFywBPk5GOHTzyjYC65FnhQirQAU/huMrC7CAfKTyIPUpyOi45NzW+yv+tFMAKMCVOsXTlgDEmrDgU8LHeugnx+LjBFadqyOi6qaH5h1yFCYmuLGI2ZKK8Gds6jexqTaGwKltKBeUeJjAJNvduN5w8Xq/XKWMTjLifcjsVkhHWE/5D9qL5yd+WOTDCrOE6Dg2j/UhuycRT/shrboM8FjubBH9h7pGMHCUUpKhGos6jKGxLF8MEbsn9DN8unu3YfdweJxMbanWhr05CbvBFxK/O9Sg3TNtcITWEp5UactkmqFF5ZFoYAQ==\"}],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":36352,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":36352},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"uuid\":\"8d2982dd-4e44-4c6e-bab3-2d0269f3a1b8\",\"request_id\":\"req_011CeZJCLS76RQMUsPnghyhB\"}";

/** transcript_run1.txt line 21 — content_block_stop, index 0. */
export const RUN1_BLOCK_STOP_0 =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"298dacb8-a9f7-489b-9655-a8017008974a\"}";

/** transcript_run1.txt line 22 — content_block_start, text. */
export const RUN1_BLOCK_START_TEXT =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"88dc3d25-8a4f-44f7-b796-3f12ea1b8efd\"}";

/** transcript_run1.txt line 23 — text_delta 'PONG'. */
export const RUN1_TEXT_DELTA =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"PONG\"}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"9f99985f-38fc-4c4c-8132-193ed07e6f55\"}";

/** transcript_run1.txt line 24 — assistant event for the COMPLETED text block. */
export const RUN1_ASSISTANT_TEXT_BLOCK =
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeZJCM3p7sc4ehkWmgnof\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"PONG\"}],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":36352,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":36352},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"uuid\":\"946e4d41-68af-499d-9d2f-dd6c97331d8f\",\"request_id\":\"req_011CeZJCLS76RQMUsPnghyhB\"}";

/** transcript_run1.txt line 25 — content_block_stop, index 1. */
export const RUN1_BLOCK_STOP_1 =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":1},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"164eee7b-7a77-4d58-920c-b06f3aefffcc\"}";

/** transcript_run1.txt line 26 — message_delta with end_turn + usage. */
export const RUN1_MESSAGE_DELTA =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"stop_details\":null},\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":36352,\"cache_read_input_tokens\":0,\"output_tokens\":62,\"output_tokens_details\":{\"thinking_tokens\":54},\"iterations\":[{\"input_tokens\":10,\"output_tokens\":62,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":36352,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":36352},\"type\":\"message\"}]},\"context_management\":{\"applied_edits\":[]}},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"be86e692-8c72-45f3-80ad-a97b8b2fb113\"}";

/** transcript_run1.txt line 27 — message_stop. */
export const RUN1_MESSAGE_STOP =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"parent_tool_use_id\":null,\"uuid\":\"51b1f1fc-e6cd-423f-b96b-d5e9373c28ac\"}";

/** transcript_run1.txt line 28 — result: usage + modelUsage[*].contextWindow = the context meter's denominator. */
export const RUN1_RESULT =
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"api_error_status\":null,\"duration_ms\":1627,\"duration_api_ms\":2410,\"ttft_ms\":1611,\"ttft_stream_ms\":1085,\"time_to_request_ms\":62,\"num_turns\":1,\"result\":\"PONG\",\"stop_reason\":\"end_turn\",\"session_id\":\"c6bab4a9-9d8a-4bf1-855d-9d7e146f884a\",\"total_cost_usd\":0.073633,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":36352,\"cache_read_input_tokens\":0,\"output_tokens\":62,\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":36352,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":10,\"output_tokens\":62,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":36352,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":36352},\"type\":\"message\"}],\"speed\":\"standard\"},\"modelUsage\":{\"claude-haiku-4-5-20251001\":{\"inputTokens\":544,\"outputTokens\":77,\"cacheReadInputTokens\":0,\"cacheCreationInputTokens\":36352,\"webSearchRequests\":0,\"costUSD\":0.073633,\"contextWindow\":200000,\"maxOutputTokens\":32000}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\",\"uuid\":\"19608ab0-068b-4754-a3ff-1e474afef32d\"}";

/** The stdout lines of the whole turn, in captured order — the driver harness
 *  replays exactly this and nothing else. */
export const RUN1_STDOUT_LINES: readonly string[] = [
  RUN1_SYSTEM_STATUS_BEFORE_INIT,
  RUN1_INITIALIZE_RESPONSE,
  RUN1_SYSTEM_INIT,
  RUN1_SYSTEM_STATUS_REQUESTING,
  RUN1_RATE_LIMIT_EVENT,
  RUN1_MESSAGE_START,
  RUN1_BLOCK_START_THINKING,
  RUN1_THINKING_TOKENS,
  RUN1_THINKING_DELTA_1,
  RUN1_THINKING_DELTA_2,
  RUN1_SIGNATURE_DELTA,
  RUN1_ASSISTANT_THINKING_BLOCK,
  RUN1_BLOCK_STOP_0,
  RUN1_BLOCK_START_TEXT,
  RUN1_TEXT_DELTA,
  RUN1_ASSISTANT_TEXT_BLOCK,
  RUN1_BLOCK_STOP_1,
  RUN1_MESSAGE_DELTA,
  RUN1_MESSAGE_STOP,
  RUN1_RESULT,
];

// ── RUN2: the TOOL path ──────────────────────────────────────────────────────
// Second live run, 2026-08-30, same CLI (2.1.198) but driven through the BUILT
// driver (src/claudeCode/driver.ts) rather than the spike script, cwd
// C:\\tmp\\origami-cc-smoke, prompt "Use the Write tool to create a file
// called smoke.txt …", --max-turns 1.
//
// NOTE WHAT IS ABSENT: no `can_use_tool` control_request. The run was intended
// to capture a DENY on the wire; this machine's own settings (a 784-entry
// permissions.allow plus additionalDirectories) pre-approved the Write, so the
// CLI never asked — which is exactly what a terminal session would have done.
// The deny path therefore has no captured fixture and is tested against the
// contract shape instead; claudeCodeDriver.test.ts says so at the test.

/** smoke_deny.txt stdout line 22 — content_block_start for a tool_use block — the card opens here, before any argument has streamed. */
export const RUN2_BLOCK_START_TOOL_USE =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01Tam2qmJwK1fMj1GQHUYkSF\",\"name\":\"Write\",\"input\":{},\"caller\":{\"type\":\"direct\"}}},\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"parent_tool_use_id\":null,\"uuid\":\"359921c9-c793-45f5-b80e-afdf0cc779c0\"}";

/** smoke_deny.txt stdout line 23 — input_json_delta, empty first fragment. */
export const RUN2_INPUT_JSON_DELTA_EMPTY =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}},\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"parent_tool_use_id\":null,\"uuid\":\"2fcf0eaf-2ef3-423c-99a7-3bc58507f370\"}";

/** smoke_deny.txt stdout line 24 — input_json_delta carrying half a JSON object — deliberately NOT reassembled by the translator. */
export const RUN2_INPUT_JSON_DELTA_PATH =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"file_path\\\": \\\"C:\\\\\\\\tmp\\\\\\\\origami-cc-smoke\\\\\\\\smoke.txt\"}},\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"parent_tool_use_id\":null,\"uuid\":\"5448e51d-078a-4a96-9717-0ee1f55e85ec\"}";

/** smoke_deny.txt stdout line 25 — input_json_delta, second fragment. */
export const RUN2_INPUT_JSON_DELTA_CONTENT =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\", \\\"content\\\": \\\"hello\"}},\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"parent_tool_use_id\":null,\"uuid\":\"58d98ef4-5022-42b6-8dc9-e4352b525694\"}";

/** smoke_deny.txt stdout line 26 — input_json_delta, closing fragment. */
export const RUN2_INPUT_JSON_DELTA_CLOSE =
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"}\"}},\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"parent_tool_use_id\":null,\"uuid\":\"326ea76d-0e39-4a93-8b60-950144fa058d\"}";

/** smoke_deny.txt stdout line 27 — the assistant event: the SAME tool call, whole and already parsed — where the card's real arguments come from. */
export const RUN2_ASSISTANT_TOOL_USE =
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeZXf2zNxBo1B995qzZ9H\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01Tam2qmJwK1fMj1GQHUYkSF\",\"name\":\"Write\",\"input\":{\"file_path\":\"C:\\\\tmp\\\\origami-cc-smoke\\\\smoke.txt\",\"content\":\"hello\"},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":9974,\"cache_read_input_tokens\":26388,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":9974},\"output_tokens\":4,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"},\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"uuid\":\"77ea7203-8c9f-4177-a068-994007b9e3f0\",\"request_id\":\"req_011CeZXf26oYd2QtT19fe81a\"}";

/** smoke_deny.txt stdout line 31 — the CLI echoing the tool RESULT back as a `user` event — the only frame that completes a card. */
export const RUN2_USER_TOOL_RESULT =
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01Tam2qmJwK1fMj1GQHUYkSF\",\"type\":\"tool_result\",\"content\":\"File created successfully at: C:\\\\tmp\\\\origami-cc-smoke\\\\smoke.txt (file state is current in your context — no need to Read it back)\"}]},\"parent_tool_use_id\":null,\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"uuid\":\"18679526-25b4-4060-85b5-94b08b24fe28\",\"timestamp\":\"2026-08-30T21:01:12.659Z\",\"tool_use_result\":{\"type\":\"create\",\"filePath\":\"C:\\\\tmp\\\\origami-cc-smoke\\\\smoke.txt\",\"content\":\"hello\",\"structuredPatch\":[],\"originalFile\":null,\"userModified\":false}}";

/** smoke_deny.txt stdout line 32 — an ERRORED result (is_error true, subtype error_max_turns) — the turn was cut at --max-turns 1. */
export const RUN2_RESULT_MAX_TURNS =
  "{\"type\":\"result\",\"subtype\":\"error_max_turns\",\"duration_ms\":2589,\"duration_api_ms\":3619,\"is_error\":true,\"num_turns\":2,\"stop_reason\":\"tool_use\",\"session_id\":\"995a1315-ff9c-4258-8acf-0e46add36bc9\",\"total_cost_usd\":0.0241338,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":9974,\"cache_read_input_tokens\":26388,\"output_tokens\":184,\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":9974,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":10,\"output_tokens\":184,\"cache_read_input_tokens\":26388,\"cache_creation_input_tokens\":9974,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":9974},\"type\":\"message\"}],\"speed\":\"standard\"},\"modelUsage\":{\"claude-haiku-4-5-20251001\":{\"inputTokens\":552,\"outputTokens\":199,\"cacheReadInputTokens\":26388,\"cacheCreationInputTokens\":9974,\"webSearchRequests\":0,\"costUSD\":0.0241338,\"contextWindow\":200000,\"maxOutputTokens\":32000}},\"permission_denials\":[],\"terminal_reason\":\"max_turns\",\"fast_mode_state\":\"off\",\"uuid\":\"3d455a1a-be87-41cd-9aa5-0d599a507fc3\",\"errors\":[\"Reached maximum number of turns (1)\"]}";

// -- PROBE: the UAT round's own live spawn ------------------------------------
// Third live run, 2026-08-31, CLI 2.1.198, the PRODUCTION arg vector plus
// --max-turns 1, cwd spike/cwd-probe, --model FABLE. Captured verbatim to
// spike/transcript_probe.txt. Trimming below is by lossless json round-trip
// (genfixtures2.py asserts an untrimmed round-trip reproduces the wire bytes),
// so array length is the only altered thing.
//
// This run is the evidence for three separate claims:
//   * `--model fable` RESOLVES  -> "model":"claude-fable-5".
//   * a subscription reports    -> "apiKeySource":"none".
//   * memories ride along       -> "memory_paths":{"auto":"...\\.claude\\memory\\"}.
// And for the skills diagnosis: `skills` holds 25 names, `slash_commands` 53,
// and skills is a strict SUBSET. Both lists are kept WHOLE here — they are the
// thing under test, so trimming them would delete the evidence.
/** transcript_probe.txt system/init - TRIMMED: tools and agents cut to 3; slash_commands and skills kept WHOLE. */
export const PROBE_SYSTEM_INIT =
  "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\c--Users-dev-Desktop-Workspace\\\\86d82c38-23ee-4d0d-87e9-b6a9d26d7537\\\\scratchpad\\\\spike\\\\cwd-probe\",\"session_id\":\"65426887-dc12-4847-8c7c-7d59ec25617d\",\"tools\":[\"Task\",\"AskUserQuestion\",\"Bash\"],\"mcp_servers\":[{\"name\":\"blender\",\"status\":\"pending\"},{\"name\":\"tasks\",\"status\":\"connected\"},{\"name\":\"claude.ai Example Drive\",\"status\":\"pending\"}],\"model\":\"claude-fable-5\",\"permissionMode\":\"default\",\"slash_commands\":[\"make-asset\",\"review-code\",\"plan-mode-helper\",\"tutor\",\"learn-language\",\"refactor\",\"triage\",\"speak\",\"fine-tune\",\"summarize\",\"nightly-run\",\"relay-task\",\"social-posts\",\"social-posts:examples:bad_posts\",\"social-posts:examples:good_posts\",\"social-posts:instructions:draft\",\"social-posts:instructions:rules\",\"social-posts:instructions:topic_research\",\"social-posts:instructions:voice\",\"deep-research\",\"design-sync\",\"dataviz\",\"update-config\",\"verify\",\"debug\",\"code-review\",\"simplify\",\"batch\",\"fewer-permission-prompts\",\"auto-mode-setup\",\"loop\",\"schedule\",\"claude-api\",\"run\",\"run-skill-generator\",\"agents\",\"clear\",\"compact\",\"config\",\"context\",\"heapdump\",\"init\",\"reload-skills\",\"review\",\"security-review\",\"usage-credits\",\"extra-usage\",\"usage\",\"insights\",\"recap\",\"goal\",\"design\",\"team-onboarding\"],\"apiKeySource\":\"none\",\"claude_code_version\":\"2.1.198\",\"output_style\":\"default\",\"agents\":[\"AI Engineer\",\"claude\",\"Embedded Firmware Engineer\"],\"skills\":[\"make-asset\",\"review-code\",\"plan-mode-helper\",\"tutor\",\"learn-language\",\"refactor\",\"triage\",\"speak\",\"fine-tune\",\"summarize\",\"deep-research\",\"design-sync\",\"dataviz\",\"update-config\",\"verify\",\"debug\",\"code-review\",\"simplify\",\"batch\",\"fewer-permission-prompts\",\"loop\",\"schedule\",\"claude-api\",\"run\",\"run-skill-generator\"],\"plugins\":[],\"analytics_disabled\":false,\"product_feedback_disabled\":false,\"uuid\":\"0db397a8-221d-487b-9c58-1a6dbc67d550\",\"memory_paths\":{\"auto\":\"C:\\\\Users\\\\dev\\\\.claude\\\\memory\\\\\"},\"fast_mode_state\":\"off\"}";

/** transcript_probe.txt rate_limit_event - allowed_warning at 90% of the seven-day window. VERBATIM. */
export const PROBE_RATE_LIMIT_EVENT =
  "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":1788195600,\"rateLimitType\":\"seven_day\",\"utilization\":0.9,\"isUsingOverage\":false,\"surpassedThreshold\":0.75},\"uuid\":\"e38a2904-5731-49bd-943b-7a7735582a95\",\"session_id\":\"65426887-dc12-4847-8c7c-7d59ec25617d\"}";

/**
 * transcript_deny.txt line 42 — a REAL `can_use_tool` control_request. VERBATIM.
 *
 * Worth stating plainly, because the RUN2 header above says the deny path had
 * no captured fixture: that was true of the run it describes. This line is from
 * a LATER capture (spike/transcript_deny.txt), where the probe wrote into a cwd
 * outside the machine's 784-entry permissions.allow, so the CLI did have to ask.
 * It is the shape `permissionAskOf` reads, and the shape the phase 2 plan card
 * is modelled on — `ExitPlanMode` arrives as one of these, with the plan in
 * `input`. Note `permission_suggestions` and `tool_use_id`, neither of which we
 * read: an unread field on a real frame is evidence the parser is lenient, not
 * a reason to start reading it.
 */
export const DENY_CAN_USE_TOOL =
  "{\"type\":\"control_request\",\"request_id\":\"71895c53-f51d-4cae-adb8-2906e1971e4b\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Write\",\"display_name\":\"Write\",\"input\":{\"file_path\":\"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\c--Users-dev-Desktop-Workspace\\\\86d82c38-23ee-4d0d-87e9-b6a9d26d7537\\\\scratchpad\\\\spike\\\\cwd-deny\\\\probe.txt\",\"content\":\"hello\"},\"description\":\"probe.txt\",\"permission_suggestions\":[{\"type\":\"setMode\",\"mode\":\"acceptEdits\",\"destination\":\"session\"}],\"tool_use_id\":\"toolu_01A9RuMZXTLbidGKmphFqWym\"}}";

/** transcript_deny.txt rate_limit_event - the SAME status at 87%. VERBATIM. A second reading of the same level is what proves the pill refreshes while the transcript line does not repeat. */
export const DENY_RATE_LIMIT_EVENT =
  "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":1788195600,\"rateLimitType\":\"seven_day\",\"utilization\":0.87,\"isUsingOverage\":false,\"surpassedThreshold\":0.75},\"uuid\":\"b650deaf-4fd6-4ea2-b2f5-d0dbe98bf9a3\",\"session_id\":\"34f3317a-755f-4413-84f1-8f2660105f93\"}";

/** transcript_probe.txt control_response to our own `initialize` - TRIMMED: commands cut to 3, agents and models to 1, and the `account` block (the owner's e-mail and plan) removed. This is where the `/` palette gets its PROSE: the same 53 names init lists, with descriptions. */
export const PROBE_INITIALIZE_RESPONSE =
  "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"x_1\",\"response\":{\"commands\":[{\"name\":\"make-asset\",\"description\":\"Create one game asset (a prop, weapon or piece of armour) through a browser review tool: you start it once, then the user approves each stage (images, mesh, cleanup, export) in a review page that refreshes itself. You only step in again to debug a failed stage. Use when the user asks to make an asset. (user)\",\"argumentHint\":\"<what to make, e.g. 'a rusted iron helmet'>\"},{\"name\":\"review-code\",\"description\":\"Plan a larger job before you start it: split it into steps, pick who does each step, and list what to check at the end. (user)\",\"argumentHint\":\"\"},{\"name\":\"plan-mode-helper\",\"description\":\"Work in plan mode: write the plan, get it approved, then make the change and check it against the plan. Use only when the user asks for it. (user)\",\"argumentHint\":\"\"}],\"agents\":[{\"name\":\"AI Engineer\",\"description\":\"Expert AI/ML engineer specializing in machine learning model development, deployment, and integration into production systems. Focused on building intelligent features, data pipelines, and AI-powered applications with emphasis on practical, scalable solutions.\"}],\"output_style\":\"default\",\"available_output_styles\":[\"default\",\"Proactive\",\"Explanatory\",\"Learning\"],\"models\":[{\"value\":\"default\",\"resolvedModel\":\"claude-opus-4-8[1m]\",\"displayName\":\"Default (recommended)\",\"description\":\"Opus 4.8 with 1M context \u00b7 Best for everyday, complex tasks\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"supportsAdaptiveThinking\":true,\"supportsFastMode\":true,\"supportsAutoMode\":true}],\"pid\":9572,\"feedback_survey_config\":{\"minTimeBeforeFeedbackMs\":300000,\"minTimeBetweenFeedbackMs\":3600000,\"minTimeBetweenGlobalFeedbackMs\":43200000,\"minUserTurnsBeforeFeedback\":3,\"minUserTurnsBetweenFeedback\":5,\"hideThanksAfterMs\":3000,\"onForModels\":[\"*\"],\"probability\":0.25,\"lastSurveyShownTime\":1788164188699}}}}";
