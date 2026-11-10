import { addLine, describeLine, ConsoleLine } from './describe-line';
import { AgentId } from '../../core/protocol';

// Verbatim copies of the versioned JSONL fixtures. Keep all lines in order.
// Inline data avoids Node filesystem dependencies in the Angular test bundle.
const fixtureLines: Record<string, string[]> = {
  'claude/2.1.318-ask-session': [
    "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"/tmp/repo\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"model\":\"claude-opus-5-5\",\"permissionMode\":\"plan\",\"apiKeySource\":\"none\",\"output_style\":\"default\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10986,\"cache_read_input_tokens\":11366,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10986},\"output_tokens\":17,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"ttft_ms\":2547,\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_014UAAXCoGc67CqXqYjG1VzS\",\"name\":\"Read\",\"input\":{},\"caller\":{\"type\":\"direct\"}}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"file_path\\\": \\\"/tmp/repo/a.txt\\\"}\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_014UAAXCoGc67CqXqYjG1VzS\",\"name\":\"Read\",\"input\":{\"file_path\":\"/tmp/repo/a.txt\"},\"caller\":{\"type\":\"direct\"}}],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10986,\"cache_read_input_tokens\":11366,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10986},\"output_tokens\":17,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"timestamp\":\"2026-11-05T17:18:03.509Z\",\"request_id\":\"req_011CgkAM8usSm65TNBDaQDtz\",\"wire_tool_inputs\":{\"toolu_014UAAXCoGc67CqXqYjG1VzS\":{\"file_path\":\"/tmp/repo/a.txt\"}}}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"container\":null,\"safeguard_results\":[{\"type\":\"dangerous_tool_use\",\"status\":{\"type\":\"available\",\"tool_uses\":{}}}]},\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10986,\"cache_read_input_tokens\":11366,\"output_tokens\":131,\"output_tokens_details\":{\"thinking_tokens\":0},\"iterations\":[{\"input_tokens\":2,\"output_tokens\":131,\"cache_read_input_tokens\":11366,\"cache_creation_input_tokens\":10986,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10986},\"type\":\"message\"}]},\"context_management\":{\"applied_edits\":[]}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAM9LR3FrcdUfv2PApV\"}",
    "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1793913000,\"rateLimitType\":\"five_hour\",\"overageStatus\":\"rejected\",\"overageDisabledReason\":\"org_level_disabled\",\"isUsingOverage\":false,\"unifiedWindows\":{\"five_hour\":{\"utilization\":0.41,\"resetsAt\":1793913000,\"status\":\"allowed\"},\"seven_day\":{\"utilization\":0.05,\"resetsAt\":1794171600,\"status\":\"allowed\"}}},\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"session_id\":\"00000000-0000-4000-8000-000000000001\"}",
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_014UAAXCoGc67CqXqYjG1VzS\",\"type\":\"tool_result\",\"content\":\"1\\thello\\n2\\t\"}]},\"parent_tool_use_id\":null,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"timestamp\":\"2026-11-05T17:18:03.535Z\",\"tool_use_result\":{\"type\":\"text\",\"file\":{\"filePath\":\"/tmp/repo/a.txt\",\"content\":\"hello\\n\",\"numLines\":2,\"startLine\":1,\"totalLines\":2}},\"tool_result_meta\":[{\"id\":\"toolu_014UAAXCoGc67CqXqYjG1VzS\",\"permission_decision\":{\"decision\":\"accept\",\"source\":\"config\",\"reason_type\":\"mode\"}}]}",
    "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10406,\"cache_read_input_tokens\":22352,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10406},\"output_tokens\":8,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"ttft_ms\":3833,\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":50,\"estimated_tokens_delta\":50,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":50}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":null}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":180,\"estimated_tokens_delta\":130,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"CAQSxAUKEAgTGAI4AUIIdGhpbmtpbmcSDDaQ+NYkMsdJ8wZMDRoM/2ooxlmd2EOz5B5aIjAdB//qjcYaHiTOffBt3f/Zvtno0K/JJNA4+KYk9tlB0V6hZBfXZkqh6P0CRifXR/cq4QSVg0OSmMPsubfwIVNavtTilnneInLuIKV6qcuEhEUaNH5jKp9+pNEMzlONFUgSrzzt/SAy16SSEXLdUPbyteBXrSZGFYD0nqMkzuw//mh25P3DozWmMqXcoDlTdVnQ051DqBdRXT8nFqh4FFzKPY6hai/CZyeT6kgjgnsAAQyVLKUw3LRiOySBRf+e4tKnqYkeoKxMICfrPqp5nsyxysU2X1GsUPr52ev5Td7Qmwuead33T4JGgxMy/69fICckYJs1P4JtK6HgZuPw7tebSV9VMJXLGEKaUN6ueqTDY0UUY2PaYBcncYgP+Bx6LFBm2N0kaR15kj6K5o6FlY1xWqQus9JeJ5F8m9665oLloouq4SeUIl7yv8KGeLrdKECrA09zC+u6YqpUpzrrsfRMDPJnPSCCfphZipdLdnh7kkB7cC1ROSJ6w/SVfAG1UU8ouXtCnYxCCs69EQVcg3YK2LqlpaxiDhtLIcI895KQICpkbxkJnRnACKc3QLO+AICzqIquMLYO8vUfk2uV+lBUqwzcRKqNRFeB1XrqrUP9M6Ml+wtveOP0LzGIRP4nLIsMYB0QMMf+GiqI8B2aIusnvzyzk7mxRrRW1H4Q8ahkOpRlJfLGHFaikyzCg6mz9KTtpGL2JGdJ7JOGxcoOdoXDBEwIw75e/xNjEfPS863OTLEI9Th4zRi/4bcTte4n0WL7drpgxkI/w00gyul/tdTElE7g6gb6oJWqIPIUxSwNuisu+bnAb3+3iKTcfW1VVNAEha3QiWNrxP5GAiwWj3mea15YHxVghVrlkz4CcN8lTGi7hOEYAQ==\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"CAQSxAUKEAgTGAI4AUIIdGhpbmtpbmcSDDaQ+NYkMsdJ8wZMDRoM/2ooxlmd2EOz5B5aIjAdB//qjcYaHiTOffBt3f/Zvtno0K/JJNA4+KYk9tlB0V6hZBfXZkqh6P0CRifXR/cq4QSVg0OSmMPsubfwIVNavtTilnneInLuIKV6qcuEhEUaNH5jKp9+pNEMzlONFUgSrzzt/SAy16SSEXLdUPbyteBXrSZGFYD0nqMkzuw//mh25P3DozWmMqXcoDlTdVnQ051DqBdRXT8nFqh4FFzKPY6hai/CZyeT6kgjgnsAAQyVLKUw3LRiOySBRf+e4tKnqYkeoKxMICfrPqp5nsyxysU2X1GsUPr52ev5Td7Qmwuead33T4JGgxMy/69fICckYJs1P4JtK6HgZuPw7tebSV9VMJXLGEKaUN6ueqTDY0UUY2PaYBcncYgP+Bx6LFBm2N0kaR15kj6K5o6FlY1xWqQus9JeJ5F8m9665oLloouq4SeUIl7yv8KGeLrdKECrA09zC+u6YqpUpzrrsfRMDPJnPSCCfphZipdLdnh7kkB7cC1ROSJ6w/SVfAG1UU8ouXtCnYxCCs69EQVcg3YK2LqlpaxiDhtLIcI895KQICpkbxkJnRnACKc3QLO+AICzqIquMLYO8vUfk2uV+lBUqwzcRKqNRFeB1XrqrUP9M6Ml+wtveOP0LzGIRP4nLIsMYB0QMMf+GiqI8B2aIusnvzyzk7mxRrRW1H4Q8ahkOpRlJfLGHFaikyzCg6mz9KTtpGL2JGdJ7JOGxcoOdoXDBEwIw75e/xNjEfPS863OTLEI9Th4zRi/4bcTte4n0WL7drpgxkI/w00gyul/tdTElE7g6gb6oJWqIPIUxSwNuisu+bnAb3+3iKTcfW1VVNAEha3QiWNrxP5GAiwWj3mea15YHxVghVrlkz4CcN8lTGi7hOEYAQ==\"}],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10406,\"cache_read_input_tokens\":22352,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10406},\"output_tokens\":8,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"timestamp\":\"2026-11-05T17:18:07.891Z\",\"request_id\":\"req_011CgkAMP6eK1adgewUH58wD\",\"thinking_duration_ms\":503,\"thinking_display\":\"updates\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10406,\"cache_read_input_tokens\":22352,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10406},\"output_tokens\":8,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"timestamp\":\"2026-11-05T17:18:07.893Z\",\"request_id\":\"req_011CgkAMP6eK1adgewUH58wD\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":1},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"stop_details\":null,\"container\":null,\"safeguard_results\":[{\"type\":\"dangerous_tool_use\",\"status\":{\"type\":\"available\",\"tool_uses\":{}}}]},\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10406,\"cache_read_input_tokens\":22352,\"output_tokens\":66,\"output_tokens_details\":{\"thinking_tokens\":62},\"iterations\":[{\"input_tokens\":2,\"output_tokens\":66,\"cache_read_input_tokens\":22352,\"cache_creation_input_tokens\":10406,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10406},\"type\":\"message\"}]},\"context_management\":{\"applied_edits\":[]}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMPK3MVLW1PK6KwSS7\"}",
    "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1793913000,\"rateLimitType\":\"five_hour\",\"overageStatus\":\"rejected\",\"overageDisabledReason\":\"org_level_disabled\",\"isUsingOverage\":false,\"unifiedWindows\":{\"five_hour\":{\"utilization\":0.42,\"resetsAt\":1793913000,\"status\":\"allowed\"},\"seven_day\":{\"utilization\":0.05,\"resetsAt\":1794171600,\"status\":\"allowed\"}}},\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"session_id\":\"00000000-0000-4000-8000-000000000001\"}",
    "{\"duration_api_ms\":7660,\"stop_reason\":\"end_turn\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"total_cost_usd\":0.1818356,\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":21392,\"cache_read_input_tokens\":33718,\"output_tokens\":197,\"output_tokens_details\":{\"thinking_tokens\":62},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":21392,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"global\",\"iterations\":[{\"input_tokens\":2,\"output_tokens\":66,\"cache_read_input_tokens\":22352,\"cache_creation_input_tokens\":10406,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10406},\"type\":\"message\"}],\"speed\":\"standard\",\"fallback_credit\":null},\"modelUsage\":{\"claude-opus-5-5\":{\"inputTokens\":4,\"outputTokens\":197,\"cacheReadInputTokens\":33718,\"cacheCreationInputTokens\":21392,\"webSearchRequests\":0,\"costUSD\":0.1818356,\"contextWindow\":1000000,\"maxOutputTokens\":128000,\"thinkingTokens\":62,\"cacheCreationEphemeral5mInputTokens\":0,\"cacheCreationEphemeral1hInputTokens\":21392,\"canonicalModel\":\"claude-opus-5-5\",\"provider\":\"firstParty\",\"costBasis\":\"list\"}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\",\"fast_mode_disabled_reason\":\"sdk_opt_in_required\",\"subagent_stats\":{\"spawned\":0,\"requested\":{\"background\":0,\"foreground\":0,\"unset\":0},\"started_in_background\":0,\"max_depth\":0,\"spawned_by_subagents\":0,\"completed\":0,\"failed\":0,\"killed\":{\"parent\":0,\"user\":0,\"system\":0},\"refused\":{\"depth_limit\":0,\"concurrency_limit\":0,\"budget\":0},\"by_type\":{}},\"safety_stops\":0,\"is_error\":false,\"num_turns\":2,\"subtype\":\"success\",\"api_error_status\":null,\"result\":\"hello\",\"ttft_ms\":3686,\"type\":\"result\",\"duration_ms\":8084,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"ttft_stream_ms\":2936,\"time_to_request_ms\":391,\"first_content_frame_ms\":2936,\"queued_turn_count\":0,\"result_index\":0,\"model_usage_since_last_result\":{\"claude-opus-5-5\":{\"inputTokens\":4,\"outputTokens\":197,\"cacheReadInputTokens\":33718,\"cacheCreationInputTokens\":21392,\"webSearchRequests\":0,\"costUSD\":0.1818356,\"contextWindow\":1000000,\"maxOutputTokens\":128000,\"thinkingTokens\":62,\"cacheCreationEphemeral5mInputTokens\":0,\"cacheCreationEphemeral1hInputTokens\":21392,\"canonicalModel\":\"claude-opus-5-5\",\"provider\":\"firstParty\",\"costBasis\":\"list\"}},\"credential_expires_at\":\"2026-12-02T16:24:47.017Z\"}",
    "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"/tmp/repo\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"model\":\"claude-opus-5-5\",\"permissionMode\":\"plan\",\"apiKeySource\":\"none\",\"output_style\":\"default\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAMvtLwq9oxznYhussA\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":93,\"cache_read_input_tokens\":32758,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":93},\"output_tokens\":5,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"ttft_ms\":3685,\"thinking_display\":\"updates\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Bạn b\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ảo tôi đọc\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" file a.txt rồi\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" trả lời đúng n\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ội dung của nó (\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"là \\\"hello\\\").\"}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\",\"id\":\"msg_011CgkAMvtLwq9oxznYhussA\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Bạn bảo tôi đọc file a.txt rồi trả lời đúng nội dung của nó (là \\\"hello\\\").\"}],\"container\":null,\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":93,\"cache_read_input_tokens\":32758,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":93},\"output_tokens\":5,\"service_tier\":\"standard\",\"inference_geo\":\"global\",\"speed\":\"standard\"},\"input_transformations\":[],\"diagnostics\":null,\"context_management\":null},\"parent_tool_use_id\":null,\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"timestamp\":\"2026-11-05T17:18:14.901Z\",\"request_id\":\"req_011CgkAMvciDLhdoN6sGSf7Y\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"stop_details\":null,\"container\":null,\"safeguard_results\":[{\"type\":\"dangerous_tool_use\",\"status\":{\"type\":\"available\",\"tool_uses\":{}}}]},\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":93,\"cache_read_input_tokens\":32758,\"output_tokens\":43,\"output_tokens_details\":{\"thinking_tokens\":0},\"iterations\":[{\"input_tokens\":4,\"output_tokens\":43,\"cache_read_input_tokens\":32758,\"cache_creation_input_tokens\":93,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":93},\"type\":\"message\"}]},\"context_management\":{\"applied_edits\":[]}},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"parent_tool_use_id\":null,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"api_message_id\":\"msg_011CgkAMvtLwq9oxznYhussA\"}",
    "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1793913000,\"rateLimitType\":\"five_hour\",\"overageStatus\":\"rejected\",\"overageDisabledReason\":\"org_level_disabled\",\"isUsingOverage\":false,\"unifiedWindows\":{\"five_hour\":{\"utilization\":0.43,\"resetsAt\":1793913000,\"status\":\"allowed\"},\"seven_day\":{\"utilization\":0.05,\"resetsAt\":1794171600,\"status\":\"allowed\"}}},\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"session_id\":\"00000000-0000-4000-8000-000000000001\"}",
    "{\"duration_api_ms\":11638,\"stop_reason\":\"end_turn\",\"session_id\":\"00000000-0000-4000-8000-000000000001\",\"total_cost_usd\":0.1900072,\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":93,\"cache_read_input_tokens\":32758,\"output_tokens\":43,\"output_tokens_details\":{\"thinking_tokens\":0},\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"service_tier\":\"standard\",\"cache_creation\":{\"ephemeral_1h_input_tokens\":93,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"global\",\"iterations\":[{\"input_tokens\":4,\"output_tokens\":43,\"cache_read_input_tokens\":32758,\"cache_creation_input_tokens\":93,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":93},\"type\":\"message\"}],\"speed\":\"standard\",\"fallback_credit\":null},\"modelUsage\":{\"claude-opus-5-5\":{\"inputTokens\":8,\"outputTokens\":240,\"cacheReadInputTokens\":66476,\"cacheCreationInputTokens\":21485,\"webSearchRequests\":0,\"costUSD\":0.1900072,\"contextWindow\":1000000,\"maxOutputTokens\":128000,\"thinkingTokens\":62,\"cacheCreationEphemeral5mInputTokens\":0,\"cacheCreationEphemeral1hInputTokens\":21485,\"canonicalModel\":\"claude-opus-5-5\",\"provider\":\"firstParty\",\"costBasis\":\"list\"}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\",\"fast_mode_disabled_reason\":\"sdk_opt_in_required\",\"subagent_stats\":{\"spawned\":0,\"requested\":{\"background\":0,\"foreground\":0,\"unset\":0},\"started_in_background\":0,\"max_depth\":0,\"spawned_by_subagents\":0,\"completed\":0,\"failed\":0,\"killed\":{\"parent\":0,\"user\":0,\"system\":0},\"refused\":{\"depth_limit\":0,\"concurrency_limit\":0,\"budget\":0},\"by_type\":{}},\"safety_stops\":0,\"is_error\":false,\"num_turns\":1,\"subtype\":\"success\",\"api_error_status\":null,\"result\":\"Bạn bảo tôi đọc file a.txt rồi trả lời đúng nội dung của nó (là \\\"hello\\\").\",\"ttft_ms\":3986,\"type\":\"result\",\"duration_ms\":4001,\"uuid\":\"00000000-0000-4000-8000-000000000000\",\"ttft_stream_ms\":3706,\"time_to_request_ms\":23,\"first_content_frame_ms\":3707,\"queued_turn_count\":0,\"result_index\":1,\"model_usage_since_last_result\":{\"claude-opus-5-5\":{\"inputTokens\":4,\"outputTokens\":43,\"cacheReadInputTokens\":32758,\"cacheCreationInputTokens\":93,\"webSearchRequests\":0,\"costUSD\":0.008171600000000001,\"contextWindow\":1000000,\"maxOutputTokens\":128000,\"thinkingTokens\":0,\"cacheCreationEphemeral5mInputTokens\":0,\"cacheCreationEphemeral1hInputTokens\":93,\"canonicalModel\":\"claude-opus-5-5\",\"provider\":\"firstParty\",\"costBasis\":\"list\"}},\"credential_expires_at\":\"2026-12-02T16:24:47.017Z\"}",
  ],
  'claude/2.1.317': [
    "{\"type\": \"system\", \"subtype\": \"hook_started\"}",
    "{\"type\": \"system\", \"subtype\": \"hook_response\"}",
    "{\"type\": \"system\", \"subtype\": \"init\"}",
    "{\"type\": \"assistant\", \"message\": {\"role\": \"assistant\", \"content\": [{\"type\": \"tool_use\", \"name\": \"Bash\", \"input\": {\"command\": \"cat a.txt\", \"description\": \"Read a.txt contents\"}}]}}",
    "{\"type\": \"rate_limit_event\"}",
    "{\"type\": \"user\", \"message\": {\"role\": \"user\", \"content\": [{\"type\": \"tool_result\", \"content\": \"hello\", \"is_error\": false}]}}",
    "{\"type\": \"assistant\", \"message\": {\"role\": \"assistant\", \"content\": [{\"type\": \"text\", \"text\": \"hello\"}]}}",
    "{\"type\": \"rate_limit_event\"}",
    "{\"type\": \"result\", \"subtype\": \"success\", \"is_error\": false, \"num_turns\": 2, \"total_cost_usd\": 0.1313696, \"usage\": {\"input_tokens\": 4, \"cache_creation_input_tokens\": 15379, \"cache_read_input_tokens\": 33208, \"output_tokens\": 84}}",
  ],
  'codex/0.166.0': [
    "{\"type\": \"thread.started\", \"thread_id\": \"00000000-0000-0000-0000-000000000000\"}",
    "{\"type\": \"turn.started\"}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_0\", \"type\": \"agent_message\", \"text\": \"Tôi sẽ đọc tệp `a.txt`.\\n\"}}",
    "{\"type\": \"item.started\", \"item\": {\"id\": \"item_1\", \"type\": \"command_execution\", \"command\": \"/bin/zsh -lc 'cat a.txt'\", \"aggregated_output\": \"\", \"exit_code\": null, \"status\": \"in_progress\"}}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_1\", \"type\": \"command_execution\", \"command\": \"/bin/zsh -lc 'cat a.txt'\", \"aggregated_output\": \"hello\\n\", \"exit_code\": 0, \"status\": \"completed\"}}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_2\", \"type\": \"agent_message\", \"text\": \"hello\"}}",
    "{\"type\": \"turn.completed\", \"usage\": {\"input_tokens\": 31731, \"cached_input_tokens\": 28800, \"cache_write_input_tokens\": 0, \"output_tokens\": 51, \"reasoning_output_tokens\": 0}}",
  ],
};

describe('describeLine CLI contracts', () => {
  const fixtures: { agent: AgentId; path: string; expected: (ConsoleLine | null)[] }[] = [
    {
      agent: 'claude',
      path: 'claude/2.1.317',
      expected: [
        null, // system/hook_started
        null, // system/hook_response
        { text: '● init', tone: 'muted' },
        { text: '› Bash cat a.txt', tone: 'tool' },
        null, // rate_limit_event
        null, // user/tool_result
        { text: 'hello', tone: 'text' },
        null, // rate_limit_event
        { text: '✓ success', tone: 'ok' },
      ],
    },
    {
      agent: 'codex',
      path: 'codex/0.166.0',
      expected: [
        null, // thread.started
        null, // turn.started
        { text: 'Tôi sẽ đọc tệp `a.txt`.\n', tone: 'text' },
        null, // item.started
        { text: "› $ /bin/zsh -lc 'cat a.txt'", tone: 'tool' },
        { text: 'hello', tone: 'text' },
        { text: '✓ turn completed', tone: 'ok' },
      ],
    },
  ];

  for (const { agent, path, expected } of fixtures) {
    const lines = fixtureLines[path];
    it(`${path}: covers every fixture line`, () => {
      expect(lines.length).toBe(expected.length);
    });
    if (agent === 'claude') {
      it(`${path}: preserves collected fixture output`, () => {
        const collected = lines.reduce<ConsoleLine[]>(
          (all, line) => addLine(all, describeLine(agent, line)), [],
        );
        expect(collected).toEqual(expected.filter((line) => line !== null));
      });
      continue;
    }
    lines.forEach((line, index) => {
      it(`${path}: line ${index + 1} (${JSON.parse(line).type})`, () => {
        expect(describeLine(agent, line)).toEqual(expected[index]);
      });
    });
  }

  for (const agent of ['claude', 'codex', 'gemini', 'kiro'] as const) {
    it(`${agent}: preserves non-JSON output and malformed JSON`, () => {
      expect(describeLine(agent, '  CLI failed: permission denied  '))
        .toEqual({ text: 'CLI failed: permission denied', tone: 'text' });
      expect(describeLine(agent, '{invalid json'))
        .toEqual({ text: '{invalid json', tone: 'text' });
      expect(describeLine(agent, '  ')).toBeNull();
    });

    it(`${agent}: falls back for unknown types`, () => {
      expect(describeLine(agent, '{"type":"future.event"}'))
        .toEqual({ text: '[future.event]', tone: 'muted' });
    });
  }

  // Claude currently has no special error-event branch; retain its fallback.
  it('claude: retains the current error-event fallback', () => {
    expect(describeLine('claude', '{"type":"error","message":"failed"}'))
      .toEqual({ text: '[error]', tone: 'muted' });
  });

  for (const type of ['error', 'turn.failed']) {
    it(`codex: displays ${type}`, () => {
      expect(describeLine('codex', JSON.stringify({ type, message: 'failed' })))
        .toEqual({ text: '✕ failed', tone: 'error' });
    });
  }

  it('gemini: displays text, tool, completion and error events', () => {
    expect(describeLine('gemini', '{"type":"message","content":"hello"}'))
      .toEqual({ text: 'hello', tone: 'text' });
    expect(describeLine('gemini', '{"type":"tool_use","tool_name":"read_file"}'))
      .toEqual({ text: '› read_file', tone: 'tool' });
    expect(describeLine('gemini', '{"type":"tool_result"}')).toBeNull();
    expect(describeLine('gemini', '{"type":"result"}'))
      .toEqual({ text: '✓ done', tone: 'ok' });
    expect(describeLine('gemini', '{"type":"error","message":"failed"}'))
      .toEqual({ text: '✕ failed', tone: 'error' });
  });

  it('kiro: retains JSON fallback for text, tool, completion and error events', () => {
    for (const type of ['message', 'tool_use', 'result', 'error']) {
      expect(describeLine('kiro', JSON.stringify({ type, content: 'hello' })))
        .toEqual({ text: `[${type}]`, tone: 'muted' });
    }
  });
});

describe('Claude streamed messages', () => {
  const delta = (text: string) => JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });
  const assistant = (text: string) => JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text }] },
  });
  const collect = (lines: string[]) => lines.reduce<ConsoleLine[]>(
    (all, line) => addLine(all, describeLine('claude', line)), [],
  );

  it('streams Claude text deltas into one message', () => {
    const lines = collect(fixtureLines['claude/2.1.318-ask-session']);
    expect(lines.filter((line) => line.tone === 'text')).toEqual([
      { text: 'hello', tone: 'text' },
      { text: 'Bạn bảo tôi đọc file a.txt rồi trả lời đúng nội dung của nó (là "hello").', tone: 'text' },
    ]);
    expect(lines.some((line) => line.text === '[stream_event]')).toBe(false);
    expect(lines).toContainEqual({ text: '› Read /tmp/repo/a.txt', tone: 'tool' });
    expect(lines.filter((line) => line.text === '✓ success')).toHaveLength(2);
  });

  it('seals a message once its final copy arrives', () => {
    const lines = collect([delta('Xin '), delta('chào'), assistant('Xin chào'), delta('Câu hai')]);
    expect(lines.map((line) => line.text)).toEqual(['Xin chào', 'Câu hai']);
    expect(lines[0]).toEqual({ text: 'Xin chào', tone: 'text' });
    expect(lines.every((line) => line.tone === 'text')).toBe(true);
  });

  it('keeps a final message that had no deltas', () => {
    expect(collect([assistant('Xin chào')])).toEqual([{ text: 'Xin chào', tone: 'text' }]);
  });
});

describe('tg-bridge lines', () => {
  it('a saved delegation marks its place; other tg-bridge reports are work steps', () => {
    expect(describeLine('claude', '◆ tg-bridge · giao cho Codex: Viết trang')).toEqual({ text: '◆ tg-bridge · giao cho Codex: Viết trang', tone: 'delegate' });
    expect(describeLine('claude', '◆ tg-bridge · Claude Code done: Viết trang')!.tone).toBe('muted');
    expect(describeLine('claude', '◆ tg-bridge · Sửa tiêu đề (60%)')!.tone).toBe('tool');
  });
});
