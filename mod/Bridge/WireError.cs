namespace VintageStoryAI;

// Every refusal on the wire: a machine code Node and brains can decide on,
// the human sentence as before, and whether the same intent attempted again
// later (after re-observing) may succeed. retryable:false means the request
// itself must change. Codes carry behavior; messages remain readable context.
//
// Vocabulary: invalid_request (caller bug: shape, type, range) never retries.
// State codes retry: target_changed, inventory_changed, held_item_changed,
// container_changed, craft_changed, dialog_changed, controls_blocked,
// controls_unavailable, inputs_owned, respawn_* (re-observe, then retry).
// World codes retry once the world changes: cell_unloaded, no_target,
// no_container, target_unreachable, placement_blocked, unknown_waypoint,
// transfer_empty, dialog_ignored, recipe_failed, no_world, action_error.
// Terminal codes never retry: unknown_action, unknown_target,
// unknown_operation, unknown_code, unknown_recipe, invalid_cursor,
// invalid_session, invalid_json, request_too_long, no_client, no_connection,
// not_owner, duplicate_sequence, control_released, control_expired,
// binding_unavailable, access_denied, body_cell, tool_tier, refused,
// already_selected, craft_blocked, dialog_offscreen, unsupported_mode,
// map_unavailable. stale_death retries: a new death supersedes the old id.
// expired and stalled (the transport's own codes) always retry.
internal static class WireError
{
    public static object Fail(string code, string error, bool retryable = false) =>
        new { ok = false, code, error, retryable };
}
