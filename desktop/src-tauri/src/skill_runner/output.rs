use aether_runtime::ToolOutput;
use serde_json::Value;

pub(super) fn tool_output(payload: Value) -> ToolOutput {
    ToolOutput {
        text: payload.to_string(),
        payload: Some(payload),
    }
}
